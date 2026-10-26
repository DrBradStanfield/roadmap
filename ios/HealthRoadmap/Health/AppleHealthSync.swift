import Foundation
import Observation
import UIKit

/// Apple Health in and out (US-25 AC13–AC15, ios/architecture.md D6).
///
/// In: new readings since each kind's anchor go to the engine as one edit
/// (`appleHealth`), whose rules decide what lands; the anchor moves only after
/// the record is on disk, so a refused or failed save reads them again later.
/// Out: the engine lists the values a person entered (`healthWritesJson`); each
/// is written once per version.
///
/// Its state is on the main actor; HealthKit and the engine are awaited. An import
/// goes through `RecordStore.applyNow`, in the store's one ordered line, so an import
/// and a typed save never overlap: each edit reads the record as it is at its turn.
/// A run asked for while one is going sets `again`, and the running one loops.
@MainActor
@Observable
final class AppleHealthSync {
    enum Status: Equatable {
        /// This device has no Health database.
        case unavailable
        case notConnected
        case working
        case upToDate(Date)
        /// Health is encrypted while the phone is locked; the next unlock retries.
        case waitingForUnlock
        case failed(String)
    }

    private(set) var status: Status

    private let store: RecordStore
    private let engine: HealthEngine
    private let client: HealthStoreClient
    private let memory: HealthSyncMemory
    /// US-56's cards, read as soon as the sheet is answered (`connect`).
    private let live: LiveHealth?
    private var running = false
    private var again = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var started = false

    /// Reads the record again (cloud sync's re-read) after an import was refused: in
    /// the cloud a refusal means the record moved on (an erase or units taken in).
    private let reread: @MainActor () async -> Void

    init(store: RecordStore, engine: HealthEngine, client: HealthStoreClient, memory: HealthSyncMemory = HealthSyncMemory(),
         live: LiveHealth? = nil, reread: @escaping @MainActor () async -> Void = {}) {
        self.store = store
        self.engine = engine
        self.client = client
        self.memory = memory
        self.live = live
        self.reread = reread
        status = !client.isAvailable ? .unavailable : memory.connected ? .working : .notConnected
    }

    /// True once the person connected Apple Health on this phone, a failed refresh included:
    /// the erase names Apple Health and deletes its samples (US-25 AC16).
    var everConnected: Bool { memory.connected }

    /// Connected and not failed. Otherwise My data's Apple Health row offers Connect, the one
    /// way in, so Vitals offers no Turn On (US-25 AC15, US-56 AC5).
    var connected: Bool {
        switch status {
        case .notConnected, .failed, .unavailable: false
        case .working, .upToDate, .waitingForUnlock: true
        }
    }

    /// Sex and birth month and year from Health, for onboarding (US-54 AC3).
    func characteristics() -> HealthCharacteristics {
        memory.connected && client.isAvailable ? client.characteristics() : .none
    }

    /// "Delete all my data" (US-25 AC16): deletes the samples this app wrote to Health
    /// and forgets their versions. The import anchors stay, so readings already in
    /// Health from before the erase are not imported again (D6). False when Health
    /// refused, for the erase to say so. Never connected: nothing to delete.
    func eraseOwnSamples() async -> Bool {
        guard memory.connected, client.isAvailable else { return true }
        do {
            try await client.deleteOwnSamples()
        } catch {
            return false
        }
        memory.forgetWritten()
        return true
    }

    /// The app's one Apple Health connect (US-56 AC4): Apple's permission sheet for
    /// everything, then the first import. The cards read as soon as the sheet is answered,
    /// beside the import, never after it (always read: the answer is new, N2).
    func connect() async {
        guard client.isAvailable else { return }
        do {
            try await client.requestAuthorization()
        } catch {
            status = .failed(error.localizedDescription)
            return
        }
        memory.connected = true
        start()
        async let imported: Void = refresh()
        await live?.refresh(force: true)
        await imported
    }

    /// At launch and on connect: refresh when Health has new data (in the background
    /// too), when the phone unlocks, and when a typed value changes the record. The
    /// app's `follow` refreshes when it comes forward. Once per launch. At launch the
    /// observers are already in place (`observeAtLaunch`), so the client keeps those.
    func start() {
        guard memory.connected, client.isAvailable, !started else { return }
        started = true
        client.observe(HealthKind.allCases) { [weak self] in await self?.refresh() }
        NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in await self?.refresh() }
        }
        watchRecord()
    }

    /// Apple asks for HealthKit's observer queries and background delivery to be set up
    /// as the process starts, before `application(_:didFinishLaunchingWithOptions:)`
    /// returns: when iOS wakes the app for new Health data, a query registered later may
    /// miss that delivery (adversary R1). So the app's `Launch` calls this from its init,
    /// synchronously, while its parts are still being built off the main thread. A
    /// delivery then waits for the parts (`sync`) and refreshes; the handler returns, and
    /// HealthKit's completion is called, only after that refresh, or at once if the parts
    /// never come (nil: the launch failed).
    static func observeAtLaunch(client: HealthStoreClient, memory: HealthSyncMemory = HealthSyncMemory(),
                                sync: @escaping @MainActor () async -> AppleHealthSync?) {
        guard memory.connected, client.isAvailable else { return }
        client.observe(HealthKind.allCases) { await sync()?.refresh() }
    }

    /// Reads what is new, then writes what is typed. A call made while a refresh runs
    /// asks it to go round once more and returns when it has finished, so an observer
    /// query tells iOS its background work is done only after the import saved.
    func refresh() async {
        guard client.isAvailable else { return }
        guard memory.connected else { status = .notConnected; return }
        if running {
            again = true
            await withCheckedContinuation { waiting.append($0) }
            return
        }
        running = true
        defer {
            running = false
            waiting.forEach { $0.resume() }
            waiting = []
        }
        repeat {
            again = false
            status = .working
            do {
                try await importNew()
                try await writeTyped()
                status = .upToDate(.now)
            } catch HealthStoreError.locked {
                status = .waitingForUnlock
                return
            } catch {
                status = .failed(error.localizedDescription)
                return
            }
        } while again
    }

    private func importNew() async throws {
        for kind in HealthKind.allCases {
            let anchor = memory.anchor(for: kind)
            let batch = try await client.samples(of: kind, after: anchor)
            // A refused read looks like an empty one (iOS hides which), and a blood pressure
            // with one half refused shows only the other. Until a kind has given a whole
            // reading, keep no anchor, so allowing it later still brings in its past.
            if anchor == nil, !Self.hasWholeReading(batch.samples, kind) { continue }
            if !batch.samples.isEmpty { try await save(batch.samples) }
            memory.setAnchor(batch.anchor, for: kind)
        }
    }

    /// Through the same door as a typed value (in the cloud: the session, the merge and
    /// the erase guard), checked against the record as it is now: an import is not a
    /// sheet, so a sheet's pin never refuses it. A refusal reads the record again and
    /// tries once more; a second refusal keeps the anchor, so the batch comes again.
    private func save(_ samples: [HealthSample]) async throws {
        if case .saved = await store.applyNow(.appleHealth(samples)) { return }
        await reread()
        if case .refused(let message, _) = await store.applyNow(.appleHealth(samples)) {
            throw ImportRefused(message: message)
        }
    }

    /// Each value once per version. One Health refuses does not hold back the rest:
    /// it is tried again next time, and the first refusal is reported after the others.
    private func writeTyped() async throws {
        let writes = try await engine.healthWrites(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId)
        var refused: Error?
        for write in writes where write.version > memory.writtenVersion(write.syncId) {
            guard let kind = write.kind, client.canWrite(kind) else { continue }
            do {
                try await client.save(write)
                memory.setWritten(write.version, for: write.syncId)
            } catch HealthStoreError.locked {
                throw HealthStoreError.locked
            } catch {
                refused = refused ?? error
            }
        }
        if let refused { throw refused }
    }

    /// Any reading for most kinds; for blood pressure, both halves of one.
    private static func hasWholeReading(_ samples: [HealthSample], _ kind: HealthKind) -> Bool {
        guard kind == .bloodPressure else { return !samples.isEmpty }
        let systolic = Set(samples.filter { $0.metricType == "systolic_bp" }.compactMap(\.pairId))
        return samples.contains { $0.metricType == "diastolic_bp" && $0.pairId.map(systolic.contains) == true }
    }

    /// A typed save changes `recordJSON`; the next refresh writes it to Health.
    private func watchRecord() {
        withObservationTracking { _ = store.recordJSON } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.watchRecord()
                await self.refresh()
            }
        }
    }

    private struct ImportRefused: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
}
