import Foundation
import Observation
import UIKit

/// Apple Health in and out (US-25 AC13–AC15, ios/architecture.md D6).
///
/// In: new readings since each kind's anchor go to the engine as one edit
/// (`appleHealth`), whose rules decide what lands; the anchor moves only after
/// the record is on disk, so a refused or failed save reads them again later.
/// Lab results from Health Records (US-72), where Apple offers them, come the same way
/// (`healthRecords`), through the same line, with their own anchor.
/// Out: the engine lists the values a person entered (`healthWritesJson`); each
/// is written once per version.
///
/// Its state is on the main actor; HealthKit and the engine are awaited. An import
/// goes through `RecordStore.applyNow`, in the store's one ordered line, so an import
/// and a typed save never overlap: each edit reads the record as it is at its turn.
/// Its run state is one mode, `Run` (lead H27, AppleHealthRun.swift): a run asked for while one
/// is going queues one more, and the running one loops.
///
/// An erase disconnects Apple Health (US-72 AC10): every anchor resets and nothing is read
/// until the person connects again, which reads everything from the start. Each pass first
/// asks `EraseGate` about the record's erase, and every batch is saved on the record's mark
/// taken before it was read, so a batch read before an erase never lands after it.
///
/// The one rule: no HealthKit read or write proceeds unless the connection generation it
/// started under is still current, checked at entry and after every suspension. Every erase
/// disconnect moves the generation (`disconnect`). A pass checks it with the record's mark
/// (`still`); the live cards and pages check it through `LiveHealth.ticket` (`connection`).
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
        /// After "Don't Allow" (AC15b): nothing may be written and nothing has come in.
        case notAllowed
    }

    /// The one run state (lead H27), changed only by `send`.
    private(set) var run: Run
    var status: Status { run.status }
    /// Settings' Apple Health footer says the owed delete is stuck (US-72 AC16, `Owed.showsFooter`).
    /// A cache of `memory.owed`, so every writer of owed that can change it must refresh it: init,
    /// a pay (`OwedPay`) and `disconnect`. A save owed meanwhile (`owe`) keeps the count, so it never changes it.
    /// Set only by `refreshOwedFooter`.
    private(set) var owedFooter = false

    private let store: RecordStore
    private let engine: HealthEngine
    private let client: HealthStoreClient
    private let memory: HealthSyncMemory
    /// What an erase owes Apple Health, paid one at a time (AppleHealthOwed.swift).
    private let owed: OwedPay
    /// US-56's cards, read as soon as the sheet is answered (`connect`).
    private let live: LiveHealth?
    /// The connection generation of the one rule above: moves on every erase disconnect.
    private var generation = 0
    /// Who waits for the running pass to end: a refresh asked for during it, an erase's `drained`.
    private(set) var waiting: [UUID: CheckedContinuation<Void, Never>] = [:]
    private var started = false
    /// A lab results request is showing: a second return to the foreground does not ask again.
    private var asking = false
    /// Where the two Health Records events go (US-72 AC13); RootView sets it.
    @ObservationIgnored var analytics: Analytics?

    /// Reads the record again (cloud sync's re-read) after an import was refused: in
    /// the cloud a refusal means the record moved on (an erase or units taken in).
    private let reread: @MainActor () async -> Void

    init(store: RecordStore, engine: HealthEngine, client: HealthStoreClient, memory: HealthSyncMemory = HealthSyncMemory(),
         live: LiveHealth? = nil, reread: @escaping @MainActor () async -> Void = {}) {
        self.store = store
        self.engine = engine
        self.client = client
        self.memory = memory
        owed = OwedPay(client: client, memory: memory)
        self.live = live
        self.reread = reread
        run = !client.isAvailable ? .unavailable : memory.connected ? .idle(.notYet) : .disconnected
        refreshOwedFooter()
        // After an erase disconnected Health, the cards read nothing until Connect (US-72 AC10).
        live?.connection = { [weak self] in self?.connection }
    }

    /// The one writer of `owedFooter` (US-72 AC16): its rule, read from what is owed.
    func refreshOwedFooter() { owedFooter = memory.owed.showsFooter }

    /// The generation a read may start under; nil while an erase has Apple Health disconnected.
    var connection: Int? { memory.connected || memory.eraseSeen == nil ? generation : nil }

    /// True once the person connected Apple Health on this phone, a failed refresh included:
    /// the erase names Apple Health and deletes its samples (US-25 AC16).
    var everConnected: Bool { memory.connected }

    /// Connected and not failed. Otherwise My data's Apple Health row offers Connect, the one
    /// way in, so Vitals offers no Turn On (US-25 AC15, US-56 AC5).
    var connected: Bool {
        switch status {
        case .notConnected, .failed, .unavailable: false
        case .working, .upToDate, .waitingForUnlock, .notAllowed: true
        }
    }

    /// Sex and birth month and year from Health, for onboarding (US-54 AC3).
    func characteristics() -> HealthCharacteristics {
        memory.connected && client.isAvailable ? client.characteristics() : .none
    }

    /// The app's one Apple Health connect (US-56 AC4): Apple's permission sheet for
    /// everything, then the first import. The cards read as soon as the sheet is answered,
    /// beside the import, never after it (always read: the answer is new, N2).
    func connect() async {
        guard client.isAvailable else { return }
        // Not connected: the record's erase is taken as seen. Still connected (Connect is offered
        // after a failed refresh) with a newer erase pending: it disconnects, then connects again.
        _ = followErase()
        do {
            // Health showed its lab results sheet because HealthKit said one was needed (AC13).
            if try await client.requestAuthorization() {
                memory.labResultsAsked = .now
                analytics?.event(.healthRecordsAsked)
            }
        } catch {
            send(.connectFailed(error.localizedDescription))
            return
        }
        // What an erase left owed goes first. A delete that fails (locked) still connects: those
        // ids stay owed, apart from what this connection writes (edge 1).
        await deleteOwed()
        memory.connected = true
        start()
        async let imported: Void = refresh()
        await live?.refresh(force: true)
        await imported
    }

    /// Coming on screen (the app's `follow`), never from a background wake, where no sheet
    /// can show: a person who connected before lab results were asked for gets Health's lab
    /// results sheet when HealthKit says one is needed (US-72 AC1, AC13), once. HealthKit
    /// keeps saying so for a person with no Health Records account, or who closed the sheet,
    /// so a sheet once shown is remembered and coming on screen never shows one again.
    /// Then the refresh, which imports what they allowed.
    func foreground() async {
        await deleteOwed()
        if memory.labResultsAsked == nil { _ = await askForLabResults() }
        await refresh()
    }

    /// Settings' "Share new lab results" row is offered (US-72 AC14).
    var offersLabResults: Bool { connected && client.isAvailable && client.supportsHealthRecords }

    /// The row's tap (US-72 AC14): Health's lab results sheet when HealthKit says one is
    /// needed ("Ask Before Sharing" and new results), then the import. Otherwise nothing.
    func shareNewLabResults() async {
        if await askForLabResults() { await refresh() }
    }

    /// Health's lab results sheet, when HealthKit says one is needed; true when it showed.
    /// Nothing of ours comes before it (guideline 5.1.1).
    private func askForLabResults() async -> Bool {
        guard memory.connected, client.isAvailable, client.supportsHealthRecords, !asking else { return false }
        asking = true
        defer { asking = false }
        guard (try? await client.requestLabResults()) == true else { return false }
        memory.labResultsAsked = .now
        analytics?.event(.healthRecordsAsked)
        return true
    }

    /// At launch and on connect: refresh when Health has new data (in the background
    /// too), when the phone unlocks, and when a typed value changes the record. The
    /// app's `follow` refreshes when it comes forward. Health's observers on each connect
    /// (an erase stopped them); at launch they are already in place (`observeAtLaunch`),
    /// so the client keeps those. The unlock and record watchers once per launch.
    func start() {
        guard memory.connected, client.isAvailable else { return }
        client.observe(HealthKind.allCases) { [weak self] in await self?.refresh() }
        guard !started else { return }
        started = true
        NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
            Task { @MainActor in
                await self?.deleteOwed()
                await self?.refresh()
            }
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
        var effect = send(.trigger(connected: memory.connected))
        if effect == .wait { await withCheckedContinuation { waiting[UUID()] = $0 } }
        guard effect == .pass else { return }
        // Whoever runs the passes lets every waiter go once they end, however they ended.
        defer {
            waiting.values.forEach { $0.resume() }
            waiting = [:]
        }
        while effect == .pass { effect = send(await onePass()) }
    }

    /// Moves the run state on (`Run.transition`) and returns the effect it asks for.
    @discardableResult
    private func send(_ event: RunEvent) -> RunEffect? {
        let effect: RunEffect?
        (run, effect) = Run.transition(run, event)
        return effect
    }

    /// One pass: the erase gate, then what is new in, then what is typed out. Its end is the event.
    private func onePass() async -> RunEvent {
        guard followErase(), memory.connected else { return .gateClosed }
        // Taken before anything is read: an erase from here on refuses this pass's saves.
        let pass = Pass(mark: store.mark, generation: generation)
        do {
            try await importNew(on: pass)
            try still(pass)
            try await writeTyped(on: pass)
            try still(pass)
            return .passEnded(.done(noAccess ? .notAllowed : .upToDate(.now)))
        } catch is RecordMoved {
            // An erase landed meanwhile: the next pass meets it at the gate.
            return .passEnded(.moved)
        } catch HealthStoreError.locked {
            return .passEnded(.locked)
        } catch {
            return .passEnded(.failed(error.localizedDescription))
        }
    }

    /// The gate (US-72 AC10) on the record shown now: a newer erase on the record seen before
    /// disconnects; a first look or a new record source is taken as seen. False: disconnected.
    /// A connected cloud whose record is not open yet decides nothing.
    private func followErase() -> Bool {
        guard let source = store.recordSource, let data = store.myData else { return true }
        let now = EraseSeen(epoch: data.eraseEpoch ?? 0, source: source)
        switch EraseGate.decide(connected: memory.connected, seen: memory.eraseSeen, recordErase: now.epoch, recordSource: source) {
        case .keep: return true
        case .adopt:
            memory.eraseSeen = now
            return true
        case .disconnect:
            memory.eraseSeen = now
            disconnect()
            // As a local erase does (DataEraser): nothing read before it stays on screen or on disk (edge 3).
            let deadline = ContinuousClock.now + Self.drainBound
            Task {
                await live?.forget()
                await deleteOwed(erasing: deadline)
            }
            return false
        }
    }

    /// Disconnected by an erase: nothing is observed or read, and every anchor resets, so
    /// the next Connect reads everything from the start. Every value written is owed a delete.
    /// What Health showed is kept (`labResultsAsked`), so that Connect asks nothing again.
    private func disconnect() {
        generation += 1
        memory.oweWritten()
        refreshOwedFooter()
        send(.disconnect(wasConnected: memory.connected))
        guard memory.connected else { return }
        memory.connected = false
        for kind in HealthKind.allCases { memory.setAnchor(nil, for: kind) }
        memory.labResultsAnchor = nil
        client.stopObserving()
    }

    /// "Delete all my data" (US-25 AC16, US-72 AC10), once the record's erase has landed:
    /// disconnects Apple Health, then pays what it owes (`OwedPay.deleteAll`). `wasConnected`:
    /// Health was connected as the erase began (a pass that saw the erase first may have
    /// disconnected it already); a delete still owed (`HealthSyncMemory.owed`) is made either way.
    /// False when Health refused the delete or left an id. Neither: nothing to delete.
    func erased(wasConnected: Bool) async -> Bool {
        if let source = store.recordSource { memory.eraseSeen = EraseSeen(epoch: store.myData?.eraseEpoch ?? heldUndrawnEpoch ?? 0, source: source) }
        disconnect()
        guard client.isAvailable, wasConnected || !memory.owed.ids.isEmpty || memory.owedUnreadable else { return true }
        return await owed.deleteAll(deadline: .now + Self.drainBound, drain: drained, settled: refreshOwedFooter)
    }

    /// The erase of a record held with no drawing (US-25 AC16f, lead S66): the stored record's own
    /// `meta.eraseEpoch`, the field its drawing will show (ios/engine/my-data.ts). Nil unless held undrawn.
    /// Temporary (S66): Swift reads one field of the stored record's meta only because no engine door gives the held erase epoch yet. H113's PR replaces this with the stored epoch and deletes this helper; do not copy this pattern.
    private var heldUndrawnEpoch: Int? {
        guard store.hold == .heldUndrawn, let json = store.readable?.json,
              let file = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any] else { return nil }
        return (file["meta"] as? [String: Any])?["eraseEpoch"] as? Int ?? 0
    }

    /// The one owed pay at a time (`OwedPay.pay`), drained by this run.
    @discardableResult
    private func deleteOwed(erasing deadline: ContinuousClock.Instant? = nil) async -> Bool {
        await owed.pay(erasing: deadline, drain: drained, settled: refreshOwedFooter)
    }

    /// How long an erase's Health delete waits for a running pass. The record's erase has
    /// already landed: only the Health delete waits, and never on a hung HealthKit call.
    static let drainBound: Duration = .seconds(2)

    /// Waits for a running pass to end (`waiting`), or `deadline`, whichever comes first.
    /// The erase moved the generation, so the pass stops at its next check, once its HealthKit
    /// call returns. A call that hangs past the bound is left running: a sample it saves later
    /// is owed (`writeTyped`), and the next foreground or unlock deletes it (`deleteOwed`).
    /// The deadline is its own task, so a cancelled caller still waits for it, never spins.
    private func drained(by deadline: ContinuousClock.Instant) async {
        guard run.passing, deadline > .now else { return }
        let id = UUID()
        let timer = Task { [weak self] in
            try? await Task.sleep(until: deadline, clock: .continuous)
            self?.waiting.removeValue(forKey: id)?.resume()
        }
        await withCheckedContinuation { waiting[id] = $0 }
        timer.cancel()
    }

    /// What a pass began under: the record's mark and the connection generation.
    private struct Pass {
        let mark: RecordStore.Mark
        let generation: Int
    }

    /// The one rule, for a pass: its mark no longer holds (an erase landed since it began), or
    /// its connection generation moved (an erase disconnected Apple Health).
    private func still(_ pass: Pass) throws {
        guard pass.mark.holds(at: store.mark), pass.generation == generation else { throw RecordMoved() }
    }

    /// No kind may be written and none has given a reading (US-25 AC15b). iOS hides a refused
    /// read, so an empty Health whose writes were refused looks the same, and says the same.
    private var noAccess: Bool {
        !HealthKind.allCases.contains { client.canWrite($0) || memory.anchor(for: $0) != nil } && memory.labResultsAnchor == nil
    }

    private func importNew(on pass: Pass) async throws {
        for kind in HealthKind.allCases {
            let anchor = memory.anchor(for: kind)
            let batch = try await client.samples(of: kind, after: anchor)
            try still(pass)
            // A refused read looks like an empty one (iOS hides which), and a blood pressure
            // with one half refused shows only the other. Until a kind has given a whole
            // reading, keep no anchor, so allowing it later still brings in its past.
            if anchor == nil, !Self.hasWholeReading(batch.samples, kind) { continue }
            if !batch.samples.isEmpty { try await save(.appleHealth(batch.samples), on: pass) }
            try still(pass)
            memory.setAnchor(batch.anchor, for: kind)
        }
        try await importLabResults(on: pass)
    }

    /// Lab results (US-72), as a kind: no anchor until a batch brought some (a refused read
    /// looks like an empty one), and the anchor moves only once the record holding them is saved.
    private func importLabResults(on pass: Pass) async throws {
        guard client.supportsHealthRecords else { return }
        // A build that reads results the last one refused reads them all again; AC5's dedup keeps that safe.
        if memory.labResultsRules != HealthSyncMemory.labResultsRulesVersion {
            memory.labResultsAnchor = nil
            memory.labResultsRules = HealthSyncMemory.labResultsRulesVersion
        }
        let anchor = memory.labResultsAnchor
        let batch = try await client.labResults(after: anchor)
        try still(pass)
        if anchor == nil, batch.records.isEmpty { return }
        if !batch.records.isEmpty, try await save(.healthRecords(batch.records), on: pass)?.landed == true {
            analytics?.event(.healthRecordsImported)
        }
        try still(pass)
        memory.labResultsAnchor = batch.anchor
    }

    /// Through the same door as a typed value (in the cloud: the session, the merge and
    /// the erase guard), checked against the record as it is now: an import is not a
    /// sheet, so a sheet's pin never refuses it. A refusal reads the record again and
    /// tries once more; a second refusal keeps the anchor, so the batch comes again.
    /// On the pass's mark, the record the batch was read from: after an erase it never lands,
    /// and the pass ends silently (`RecordMoved`) for the next one to meet the erase.
    /// Returns what a Health Records batch did (nil for any other edit).
    @discardableResult
    private func save(_ edit: RecordEdit, on pass: Pass) async throws -> HealthRecordCounts? {
        guard let first = await store.applyNow(edit, on: pass.mark) else { throw RecordMoved() }
        if case .saved(let counts) = first { return counts }
        try still(pass)
        await reread()
        try still(pass)
        guard let second = await store.applyNow(edit, on: pass.mark) else { throw RecordMoved() }
        switch second {
        case .saved(let counts): return counts
        case .refused(let message, _):
            try still(pass)
            throw ImportRefused(message: message)
        }
    }

    /// Each value once per version. One Health refuses does not hold back the rest:
    /// it is tried again next time, and the first refusal is reported after the others.
    /// Each save starts only while the pass holds. One that lands is listed at once: as written,
    /// or, once an erase has disconnected Health, as owed, so the delete covers it (`deleteOwed`).
    /// A pass never writes an owed id; it is written again once its delete is paid.
    private func writeTyped(on pass: Pass) async throws {
        guard let json = store.readable?.json else { return }
        let writes = try await engine.healthWrites(recordJSON: json, now: .now, deviceId: store.deviceId)
        memory.learnKinds(writes)
        var refused: Error?
        for write in writes where write.version > memory.writtenVersion(write.syncId) && memory.owed.ids[write.syncId] == nil {
            guard let kind = write.kind, client.canWrite(kind) else { continue }
            try still(pass)
            do {
                try await client.save(write)
                if pass.generation == generation {
                    memory.setWritten(write.version, for: write.syncId)
                } else {
                    memory.owe(write.version, for: write.syncId)
                }
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

    /// A typed save moves the record's `revision`; the next refresh writes it to Health. An erase
    /// whose draw failed opening or closing `predatesErase` starts one too. A redraw of the same
    /// record (coming forward, midnight) moves neither, so it starts no HealthKit pass (F3);
    /// a per-test units choice moves `revision`, so it starts one.
    private func watchRecord() {
        let seen = (store.revision, store.predatesErase)
        withObservationTracking { _ = (store.revision, store.predatesErase) } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.watchRecord()
                if (self.store.revision, self.store.predatesErase) != seen { await self.refresh() }
            }
        }
    }

    private struct RecordMoved: Error {}

    private struct ImportRefused: LocalizedError {
        let message: String
        var errorDescription: String? { message }
    }
}
