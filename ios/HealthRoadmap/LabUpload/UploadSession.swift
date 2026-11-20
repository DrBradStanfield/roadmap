import Foundation
import Observation

/// The app's shared upload (design PR 15, US-52 AC8c): one runner wired to the record store's
/// record and save, the review page's taps sent to it in the order made. While it lives it pins
/// the record the page opened on (US-25 AC11, lead S52), so an erase or a Disconnect meanwhile
/// refuses its Save rather than writing into another record; `end()` lets it go.
@MainActor @Observable
final class UploadSession {
    @ObservationIgnored let runner: UploadRunner
    var model: UploadModel { runner.model }
    @ObservationIgnored private let engine: HealthEngine
    @ObservationIgnored private let store: RecordStore
    @ObservationIgnored private let analytics: Analytics?
    /// The last event sent: each waits for the one before, so the engine steps them in tap order.
    @ObservationIgnored private var last: Task<Void, Never>?
    /// The last view decoded, so a redraw with the same text decodes nothing.
    @ObservationIgnored private var drawn: (text: String, page: UploadPage?)?
    /// Every planned letter's Markdown, for the state it was planned from.
    @ObservationIgnored private var letters: (state: String, byFile: [String: String])?
    /// The record is pinned until `end()`; the current pick's usage was told (once a pick).
    @ObservationIgnored private var pinned = true
    @ObservationIgnored private var told = false
    /// Save was tapped and its outcome has not drawn yet: Close and every choice wait from the tap (a claim,
    /// not a mode). Observed: the sheet's Close and swipe-down and the page's controls read it. `tapped` while
    /// the Save waits for the choices before it to draw, until the runner numbers its event; then Close waits
    /// until a view drawn through that event no longer says saving, which is once the attempt's `saved` or
    /// `saveFailed` has stepped and drawn, whatever its text. A Save that ends unsent lets it go (nil).
    private enum Claim { case tapped, queued(Int) }
    private var claim: Claim?
    /// The latest event a tap sent (a choice, Try again, Stop): its generation, which only grows, and its number once
    /// queued (nil until then). An older event's number never lands over a newer one's, so Save waits for the last
    /// event's view (PR 1912 review R2 and ruling).
    private struct Sent { var generation = 0; var number: Int? = 0 }
    @ObservationIgnored private var sent = Sent()

    /// How a pick went: the engine has it, the reader refused it (its words), or the loaded engine
    /// cannot run the shared upload (an older one over the air).
    enum Started: Equatable { case running, refused(String), fallback }

    /// `sender`, `frame` and `save` (state, run and attempt to the event to step): a test's
    /// stand-ins; a nil `save` is the record store's.
    init(engine: HealthEngine, store: RecordStore, analytics: Analytics? = nil, sender: LabReadSender = LabReadSender(),
         frame: Duration = .milliseconds(16), save: (@Sendable (String, Int, Int) async -> String)? = nil) {
        self.engine = engine
        self.store = store
        self.analytics = analytics
        store.pinScreen()
        // Every Save is checked against this record, whatever the pin does later (a Close, a new pick).
        let opened = store.pinned ?? store.screen
        let held = LabFileReader.Held()
        // The review is drawn against the record as it is now, or, while none can be read, the last one that
        // could: the engine never judges the page against no record (adversary R1). Save keeps the pin above.
        let lastRead = LastRecord()
        let setup = UploadRunner.Setup(
            deviceId: store.deviceId,
            record: { await MainActor.run { lastRead.current(store.readable?.json) } },
            ask: { [engine] in await engine.uploadRules(files: $0, members: $1) },
            sender: sender,
            unitSystem: store.myData?.unitSystem ?? "si",
            cloudConnected: { await store.cloudErase != nil },
            save: save ?? { state, run, attempt in
                let saved = await store.saveUpload(state: state, originals: held.originals(), read: { held.original($0) }, as: opened)
                return Self.event(saved, run: run, attempt: attempt)
            },
            frame: frame,
            held: held)
        runner = UploadRunner(engine: engine, model: UploadModel(), setup: setup)
        watchRecord()
    }

    /// The record moved while the page is open (a sync from another device, an edit elsewhere): the
    /// page is drawn again from the engine on the record as it is now, so a value another writer put in
    /// a slot the upload offers shows its conflict without a tap. Not after `end()`. A record that is
    /// no longer the one the page opened on (an erase, a Disconnect) still refuses its Save (the pin).
    private func watchRecord() {
        let seen = store.revision
        withObservationTracking { _ = store.revision } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.pinned else { return }
                self.watchRecord()
                if self.store.revision != seen { await self.runner.recordChanged() }
            }
        }
    }

    /// The last record that could be read, for a moment when none can (an erase drawing, an unreadable copy).
    @MainActor private final class LastRecord {
        private var text = ""
        func current(_ readable: String?) -> String {
            if let readable { text = readable }
            return text
        }
    }

    /// The page is gone: the record is no longer pinned. Once; the runner's own tasks end with it.
    func end() {
        guard pinned else { return }
        pinned = false
        store.unpinScreen()
    }

    /// Reads a pick into bytes and hands it to the engine. A pick cancelled while it was read (Close
    /// during a slow File Provider read) is never held or sent.
    func start(_ files: @Sendable () async throws -> [UploadRunner.Picked], needsConsent: Bool) async -> Started {
        guard await engine.runsSharedUpload() else { return .fallback }
        told = false
        let picked: [UploadRunner.Picked]
        do { picked = try await files() } catch {
            // The reader's own refusals keep their words; no system error text reaches the screen.
            return Task.isCancelled ? .running : .refused((error as? LabFileReader.Failure)?.localizedDescription ?? LabUploadSheet.notRead)
        }
        guard !Task.isCancelled else { return .running }
        if await runner.pick(picked, needsConsent: needsConsent) { return .running }
        return model.state == .unavailable ? .fallback : .running
    }

    /// One tap, as the engine's event, after the taps before it. A Save once sent, Close and Discard first tell
    /// the pick's usage, once a pick (Clarity names only, never a count, a name or a value): "Lab
    /// save all" for a Save of two or more files, "Lab save one" for one (US-52 AC8b), then the
    /// shared upload's own counts as fixed names (US-12 AC30).
    ///
    /// A Save tap is never dropped: it waits until every event a tap sent before it (a choice, Try again, Stop) is
    /// stepped and drawn, then sends back that page's own list (`reviewed`), so Save writes exactly what the page
    /// displayed (US-13 AC23). If that page says Save is off, nothing is sent and the claim is let go: the page shows
    /// its own reason. Any of those taps, or a second Save, while the claim holds is not taken.
    func send(_ action: UploadAction) {
        switch action {
        case .save:
            guard !saveClaimed else { return }
            claim = .tapped
            // The page the tap saw, when no tap's event waits to draw; else the one drawn after the last.
            let shown = choicePending ? nil : currentPage
            then { [weak self] runner in
                guard let self else { return }
                var page = shown
                if page == nil, let text = await self.model.drawn(through: self.sent.number ?? 0) { page = self.page(text) }
                guard let page, page.save.enabled else {
                    self.claim = nil
                    return
                }
                // Counted only for a Save that is sent (US-52 AC8b), once a pick.
                self.tellUsage { [analytics = self.analytics] in analytics?.event(page.files.rows.count >= 2 ? .labSaveAll : .labSaveOne) }
                let number = await runner.queue(UploadAction.saveEvent(promised: page.reviewed))
                self.claim = .queued(number)
                await runner.drain()
            }
        case .tick, .replace, .testDay, .title, .kind, .documentDate, .retryAll, .stop:
            guard !saveClaimed else { return }
            sent = Sent(generation: sent.generation + 1, number: nil)
            let generation = sent.generation
            then { [weak self] runner in
                let number = await runner.queue(action.event(now: Date.now.formatted(HealthEngine.iso)))
                if self?.sent.generation == generation { self?.sent.number = number }
                await runner.drain()
            }
        case .close:
            tellUsage {}
            then { await $0.close() }
        case .discard:
            tellUsage {}
            then { await $0.discard() }
        }
    }

    /// Runs `work` after the work of every tap before it, so the engine steps them in tap order.
    private func then(_ work: @escaping @MainActor (UploadRunner) async -> Void) {
        let (runner, before) = (runner, last)
        last = Task {
            await before?.value
            await work(runner)
        }
    }

    /// The page drawn now; nil while none is.
    private var currentPage: UploadPage? {
        if case .drawn(let text) = model.state { page(text) } else { nil }
    }

    /// Once a run: `first`, then "Lab upload known skipped" when a file was already held and "Lab upload
    /// first read under 30 s" when the first file was read inside 30 seconds, from uploadUsageJson.
    private func tellUsage(_ first: () -> Void) {
        guard !told else { return }
        told = true
        first()
        let (runner, engine, analytics) = (runner, engine, analytics)
        Task {
            guard let state = await runner.stateText, let usage = try? await engine.perform({ try $0.uploadUsage(state: state) }) else { return }
            if (usage.known ?? 0) > 0 { analytics?.event(.labUploadKnownSkipped) }
            if let seconds = usage.firstReadSeconds, seconds < 30 { analytics?.event(.labUploadFirstReadUnder30s) }
        }
    }

    /// Save was tapped and its outcome has not drawn yet (a claim, not a mode): Close and swipe-down wait.
    var saveClaimed: Bool {
        guard let claim, case .drawn(let text) = model.state else { return false }
        guard case .queued(let save) = claim else { return true }
        return model.drawnThrough < save || page(text)?.phase == "saving"
    }

    /// The latest event a tap sent is not yet queued, or its view not yet drawn: a Save now waits for that view.
    var choicePending: Bool { sent.number.map { model.drawnThrough < $0 } ?? true }

    /// The doors' words for a call that answered nothing, from the last view drawn.
    var engineError: String? { drawn?.page?.engineError ?? drawn.flatMap { UploadPage.words($0.text) } }

    /// The page for the model's view text, decoded once per text.
    func page(_ text: String) -> UploadPage? {
        if let drawn, drawn.text == text { return drawn.page }
        let page = UploadPage.decoded(text)
        drawn = (text, page)
        return page
    }

    /// A letter's Markdown as Save writes it, from the engine's save plan (one plan per state);
    /// nil when it cannot be read.
    func letter(_ fileId: String) async -> String? {
        guard let state = await runner.stateText else { return nil }
        if let letters, letters.state == state { return letters.byFile[fileId] }
        let (record, deviceId, cloud) = (store.readable?.json ?? "", store.deviceId, store.cloudErase != nil)
        guard let planned = try? await engine.perform({ try $0.uploadLetters(state: state, record: record, cloudConnected: cloud, deviceId: deviceId) }) else { return nil }
        letters = (state, planned)
        return planned[fileId]
    }

    /// What the save door answered, as the engine's event: `saved` with its outcome, or `saveFailed`.
    nonisolated static func event(_ saved: Result<UploadSaveAnswer.Outcome, LabRefusal>, run: Int, attempt: Int) -> String {
        switch saved {
        case .success(let o):
            var outcome: [String: Any] = ["values": o.values, "documents": o.documents, "archived": o.archived]
            if let unstored = o.unstored { outcome["unstored"] = unstored }
            if let skipped = o.skippedValues { outcome["skippedValues"] = skipped }
            if let skipped = o.skippedLabValues { outcome["skippedLabValues"] = skipped }
            if let refused = o.refused { outcome["refused"] = refused }
            return EngineNatives.json(["type": "saved", "run": run, "attempt": attempt, "outcome": outcome])
        case .failure(let refusal):
            return EngineNatives.json(["type": "saveFailed", "run": run, "attempt": attempt, "message": refusal.message])
        }
    }
}
extension HealthEngine {
    /// Each planned letter's Markdown by file id (health-core uploadSavePlan, `contentMd`): the text
    /// Save writes. Nil from an engine without the door, or one that refused.
    func uploadLetters(state: String, record: String, cloudConnected: Bool, deviceId: String) throws -> [String: String]? {
        guard let text = try doorUploadSavePlanJson(stateJson: state, recordJson: record, nowIso: Date.now.formatted(Self.iso),
                                                    cloudConnected: cloudConnected, deviceId: deviceId),
              case .answered(let plan) = UploadDoors.answer(text) else { return nil }
        struct Plan: Decodable {
            struct Entry: Decodable { let fileId: String; let fields: Fields }
            struct Fields: Decodable { let contentMd: String }
            let documents: [Entry]
        }
        let documents = try JSONDecoder().decode(Plan.self, from: Data(plan.utf8)).documents
        return Dictionary(documents.map { ($0.fileId, $0.fields.contentMd) }, uniquingKeysWith: { first, _ in first })
    }
}
