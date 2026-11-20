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
    /// Save was tapped and its outcome has not drawn yet: Close waits from the tap (a claim, not a mode).
    /// Observed: the sheet's Close and swipe-down read it. The view drawn when Save was tapped: until
    /// a newer view arrives, and while the newer one says saving, Close waits.
    private var claimedAt: String?

    /// How a pick went: the engine has it, the reader refused it (its words), or the loaded engine
    /// cannot run the shared upload (an older one over the air: today's flow reads it).
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
        let setup = UploadRunner.Setup(
            deviceId: store.deviceId,
            record: { await store.readable?.json ?? "" },
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
    }

    /// The page is gone: the record is no longer pinned. Once; the runner's own tasks end with it.
    func end() {
        guard pinned else { return }
        pinned = false
        store.unpinScreen()
    }

    /// Reads a pick into bytes and hands it to the engine; `files` answering nil means today's flow
    /// reads it. A pick cancelled while it was read (Close during a slow File Provider read) is never
    /// held or sent.
    func start(_ files: @Sendable () async throws -> [UploadRunner.Picked]?, needsConsent: Bool) async -> Started {
        guard await engine.runsSharedUpload() else { return .fallback }
        told = false
        let read: [UploadRunner.Picked]?
        do { read = try await files() } catch { return Task.isCancelled ? .running : .refused(error.localizedDescription) }
        guard !Task.isCancelled else { return .running }
        guard let picked = read else { return .fallback }
        if await runner.pick(picked, needsConsent: needsConsent) { return .running }
        return model.state == .unavailable ? .fallback : .running
    }

    /// One tap, as the engine's event, after the taps before it. Save, Close and Discard first tell
    /// the pick's usage, once a pick (Clarity names only, never a count, a name or a value): "Lab
    /// save all" for a Save of two or more files, "Lab save one" for one (US-52 AC8b), then the
    /// shared upload's own counts as fixed names (US-12 AC30).
    func send(_ action: UploadAction) {
        switch action {
        case .save:
            claimedAt = drawnText
            tellUsage { [analytics, files = drawn?.page?.files.rows.count ?? 0] in analytics?.event(files >= 2 ? .labSaveAll : .labSaveOne) }
        case .close, .discard: tellUsage {}
        default: break
        }
        let (runner, before) = (runner, last)
        last = Task {
            await before?.value
            switch action {
            case .close: await runner.close()
            case .discard: await runner.discard()
            default: await runner.submit(action.event(now: Date.now.formatted(HealthEngine.iso)))
            }
        }
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
        guard let claimedAt else { return false }
        guard case .drawn(let text) = model.state else { return false }
        return text == claimedAt || page(text)?.phase == "saving"
    }

    private var drawnText: String? { if case .drawn(let text) = model.state { text } else { nil } }

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

extension LabFileReader {
    /// One file picked in Files, as the shared upload takes it: its bytes, read off the main thread
    /// through a file coordinator. Nil for a folder, a file the rules call too large by its listed
    /// size, or one that will not read: today's flow reads those and says why in its own words.
    @concurrent
    static func picked(_ url: URL, ask: AskRules) async -> UploadRunner.Picked? {
        guard !url.hasDirectoryPath else { return nil }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let name = url.lastPathComponent, listed = size(of: url)
        guard await ask([UploadFile(name: name, bytes: listed)], []).file(name, listed) != .tooLarge,
              let data = try? coordinatedData(url) else { return nil }
        return UploadRunner.Picked(id: UUID().uuidString, name: name, data: data)
    }
}
