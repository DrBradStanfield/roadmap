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
/// Everything runs on the main actor, as `RecordStore` does, so an import and a
/// typed save never overlap: each edit reads the record as it is at that moment.
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
    private var running = false
    private var again = false
    private var waiting: [CheckedContinuation<Void, Never>] = []
    private var started = false

    /// Reads the record again (cloud sync's re-read) after an import was refused: in
    /// the cloud a refusal means the record moved on (an erase or units taken in).
    private let reread: @MainActor () async -> Void

    init(store: RecordStore, engine: HealthEngine, client: HealthStoreClient, memory: HealthSyncMemory = HealthSyncMemory(),
         reread: @escaping @MainActor () async -> Void = {}) {
        self.store = store
        self.engine = engine
        self.client = client
        self.memory = memory
        self.reread = reread
        status = !client.isAvailable ? .unavailable : memory.connected ? .working : .notConnected
    }

    /// The "Connect Apple Health" row: Apple's permission sheet, then the first import.
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
        await refresh()
    }

    /// At launch and on connect: refresh when Health has new data (in the background
    /// too), when the app comes forward, when the phone unlocks, and when a typed
    /// value changes the record. Once per launch.
    func start() {
        guard memory.connected, client.isAvailable, !started else { return }
        started = true
        client.observe(HealthKind.allCases) { [weak self] in await self?.refresh() }
        for name in [UIApplication.didBecomeActiveNotification, UIApplication.protectedDataDidBecomeAvailableNotification] {
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in await self?.refresh() }
            }
        }
        watchRecord()
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
        if case .saved = store.applyNow(.appleHealth(samples)) { return }
        await reread()
        if case .refused(let message, _) = store.applyNow(.appleHealth(samples)) {
            throw ImportRefused(message: message)
        }
    }

    /// Each value once per version. One Health refuses does not hold back the rest:
    /// it is tried again next time, and the first refusal is reported after the others.
    private func writeTyped() async throws {
        let writes = try engine.healthWrites(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId)
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
