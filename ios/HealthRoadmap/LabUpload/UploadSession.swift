import Foundation

/// The app's shared upload (design PR 15, US-52 AC8c): one runner wired to the record store's
/// record and save, the review page's taps sent to it in the order made.
@MainActor
final class UploadSession {
    let runner: UploadRunner
    var model: UploadModel { runner.model }
    private let engine: HealthEngine
    private let store: RecordStore
    private let cloudConnected: Bool
    /// The last event sent: each waits for the one before, so the engine steps them in tap order.
    private var last: Task<Void, Never>?
    /// The last view decoded, so a redraw with the same text decodes nothing.
    private var drawn: (text: String, page: UploadPage?)?
    /// Every planned letter's Markdown, for the state it was planned from.
    private var letters: (state: String, byFile: [String: String])?

    /// `sender`, `frame` and `save` (state, run and attempt to the event to step): a test's
    /// stand-ins; a nil `save` is the record store's.
    init(engine: HealthEngine, store: RecordStore, sender: LabReadSender = LabReadSender(), frame: Duration = .milliseconds(16),
         save: (@Sendable (String, Int, Int) async -> String)? = nil) {
        self.engine = engine
        self.store = store
        let held = LabFileReader.Held()
        cloudConnected = store.cloudErase != nil
        let setup = UploadRunner.Setup(
            deviceId: store.deviceId,
            record: { await store.recordJSON },
            ask: { [engine] in await engine.uploadRules(files: $0, members: $1) },
            sender: sender,
            unitSystem: store.myData?.unitSystem ?? "si",
            cloudConnected: cloudConnected,
            save: save ?? { state, run, attempt in
                let saved = await store.saveUpload(state: state, originals: held.originals(), read: { held.original($0) })
                return Self.event(saved, run: run, attempt: attempt)
            },
            frame: frame,
            held: held)
        runner = UploadRunner(engine: engine, model: UploadModel(), setup: setup)
    }

    /// One tap, as the engine's event, after the taps before it.
    func send(_ action: UploadAction) {
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
        let (record, deviceId, cloud) = (store.recordJSON, store.deviceId, cloudConnected)
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
