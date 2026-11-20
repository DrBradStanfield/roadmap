import Foundation
import Observation

/// What the shared upload's screen draws from (design PR 14; drawn by the review page, PR 15):
/// one state, set only by the runner, on the main actor.
@MainActor @Observable
final class UploadModel {
    enum State: Equatable {
        /// The engine lacks the shared upload's doors: the sheet says the pick was not read.
        case unavailable
        /// A pick started, no view drawn yet.
        case starting
        /// The latest view, health-core UploadView as the engine's JSON text.
        case drawn(String)
        /// A door refused, in its own words; nil when the engine call itself failed. It stays
        /// until the next pick: no later view draws over it.
        case refused(UploadDoors.Refusal?)

        static func transition(_ state: State, _ next: State) -> State {
            switch (state, next) {
            case (.refused, .drawn): state
            default: next
            }
        }
    }
    private(set) var state: State = .starting
    /// How many queued events the drawn view's state has stepped. It moves with a view whose text is
    /// unchanged too, so a caller tells a view drawn after its event from one drawn before it.
    private(set) var drawnThrough = 0

    func show(_ next: State, through: Int? = nil) {
        let new = State.transition(state, next)
        if new != state { state = new }
        if let through, through != drawnThrough { drawnThrough = through }
    }

    /// The first view drawn through event `number`; nil once the run is refused or unavailable instead.
    func drawn(through number: Int) async -> String? {
        while true {
            switch state {
            case .drawn(let text) where drawnThrough >= number: return text
            case .refused, .unavailable: return nil
            default:
                await withCheckedContinuation { (moved: CheckedContinuation<Void, Never>) in
                    withObservationTracking { _ = (state, drawnThrough) } onChange: { moved.resume() }
                }
            }
        }
    }
}

/// Drawing the view: idle, drawing, or drawing with a newer state waiting to be drawn after.
enum ViewLoop: Equatable {
    case idle, drawing, drawingAgain
    enum Event { case asked, drawn }

    static func transition(_ loop: ViewLoop, _ event: Event) -> ViewLoop {
        switch (loop, event) {
        case (.idle, .asked): .drawing
        case (.drawing, .asked), (.drawingAgain, .asked): .drawingAgain
        case (.drawingAgain, .drawn): .drawing
        case (.drawing, .drawn), (.idle, .drawn): .idle
        }
    }
}

/// Runs one upload through the engine's machine (design PR 14, US-52 AC7e, AC7f, AC8c). It owns no
/// rule and no mode: it holds the engine's state as text, steps it one event at a time, carries
/// out the effects each step returns, and draws the view. The engine limits what runs at once
/// (5 sends, 3 hashes or converts); the runner adds no limit and no retry of its own.
actor UploadRunner {
    /// One picked file, its bytes read: a ZIP by its name. `bytes` is its size: the bytes read, or
    /// the listed size of a file the rules call too large, never read, so the engine refuses it in
    /// its own words. `keepsOriginal`: false for a photo or a scan, never a file: it is picked
    /// `original: false`, so the engine stores no original of it (the consent screen says only a
    /// report picked from Files is kept in the cloud). `redrawn`: the app's own photo, a JPEG it drew
    /// with no metadata, sent as its own bytes; every other picture is redrawn before it is sent.
    struct Picked: Sendable {
        let id: String
        let name: String
        let data: Data
        let bytes: Int
        let keepsOriginal: Bool
        let redrawn: Bool

        init(id: String = UUID().uuidString, name: String, data: Data, bytes: Int? = nil, keepsOriginal: Bool = true, redrawn: Bool = false) {
            (self.id, self.name, self.data, self.bytes) = (id, name, data, bytes ?? data.count)
            (self.keepsOriginal, self.redrawn) = (keepsOriginal, redrawn)
        }
    }

    /// What the runner works with, besides the engine.
    struct Setup: Sendable {
        var deviceId: String
        /// The record as text, "" for none, read for the steps and views that need it.
        var record: @Sendable () async -> String
        /// The upload rules for the pick (`HealthEngine.uploadRules`).
        var ask: LabFileReader.AskRules = { _, _ in .none }
        var sender = LabReadSender()
        /// A test's stand-in for `sender.send`; nil in the app.
        var send: (@Sendable (Data) async throws -> LabReadSender.Outcome)?
        var unitSystem = "si"
        /// Read as each view is drawn: a cloud connected or disconnected meanwhile counts at once.
        var cloudConnected: @Sendable () async -> Bool = { false }
        /// The `save` effect (UploadSave.swift): the one save door, given the state that asked for
        /// it, answering the event to step (`saved` or `saveFailed`); nil saves nothing.
        var save: (@Sendable (_ state: String, _ run: Int, _ attempt: Int) async -> String)?
        /// At most one view a frame: the latest state wins.
        var frame: Duration = .milliseconds(16)
        /// Told as each step starts (true) and ends (false): a test's, nil in the app.
        var watch: (@Sendable (Bool) -> Void)?
        var held = LabFileReader.Held()
    }

    nonisolated let model: UploadModel
    private let engine: HealthEngine
    private let setup: Setup
    private var held: LabFileReader.Held { setup.held }
    private var rules = LabFileReader.Rules.none
    /// The engine's upload: not started, starting (one start shared by every pick made before it
    /// answers), or started, its state as the engine's text.
    private enum Upload { case idle, starting(Task<UploadDoors.Answer<String>??, Never>), started(String) }
    private var upload = Upload.idle
    private var state: String? { if case .started(let text) = upload { text } else { nil } }
    /// Which pick is current: a newer pick, Close and Discard make an older one stale.
    private var picks = 0
    /// Events waiting for their step, and a pick's bytes to hold, in arrival order; `stepping`
    /// claims the queue while one runs.
    private enum Queued { case event(String), hold([Picked]) }
    private var waiting: [Queued] = []
    private var stepping = false
    /// Events queued and events stepped so far: an event's number is its place in the queue.
    private var queued = 0
    private var stepped = 0
    /// Each send in flight by file id, with a token of its own: an id and attempt recur in a later run.
    private var sends: [String: (token: UUID, task: Task<Void, Never>)] = [:]
    private var work: [UUID: Task<Void, Never>] = [:]
    private var view = ViewLoop.idle

    init(engine: HealthEngine, model: UploadModel, setup: Setup) {
        self.engine = engine
        self.model = model
        self.setup = setup
    }

    deinit {
        for send in sends.values { send.task.cancel() }
        for task in work.values { task.cancel() }
    }

    /// Picks `files`, in picked order, starting the engine's upload on the first pick. A pick
    /// replaces an earlier one through the engine's own events (`discard`, then `picked`). False
    /// when it does not run: a newer pick, Close or Discard came first (nothing held, nothing
    /// sent), or the engine lacks the doors (the model `unavailable`: the sheet says the pick was not read)
    /// or refused.
    func pick(_ files: [Picked], needsConsent: Bool) async -> Bool {
        picks += 1
        let mine = picks
        if case .idle = upload {
            let engine = engine
            upload = .starting(Task { try? await engine.perform { try $0.uploadStart(platform: "phone") } })
        }
        if case .starting(let start) = upload {
            let started = await start.value
            if case .starting = upload { // the first pick to resume settles the start, once
                switch started {
                case .answered(let initial)??: upload = .started(initial)
                case .refused(let refusal)??: upload = .idle; await model.show(.refused(refusal))
                default: upload = .idle; await model.show(.unavailable)
                }
            }
        }
        guard state != nil, mine == picks else { return false }
        // A ZIP's members are asked too, from its central directory: their paths, and each as the
        // file `convert` reads (`<zip>/<path>`). A name not asked keeps nothing (`Rules`).
        let members = files.flatMap { file in
            LabFileReader.pathExtension(file.name) == "zip" ? ((try? ZipReader.entries(of: file.data)) ?? []).map { (zip: file.name, entry: $0) } : []
        }
        let asked = await setup.ask(files.map { LabFileReader.UploadFile(name: $0.name, bytes: $0.bytes) }
                                        + members.map { LabFileReader.UploadFile(name: "\($0.zip)/\($0.entry.name)", bytes: $0.entry.size) },
                                    members.map(\.entry.name))
        guard mine == picks else { return false }
        await model.show(.starting)
        guard mine == picks else { return false }
        rules = asked
        // In one go, so the Discard's forgets land before the new bytes are held.
        queued += 2
        waiting += [.event(EngineNatives.json(["type": "discard"])), .hold(files),
                    .event(EngineNatives.json(["type": "picked", "needsConsent": needsConsent, "now": Self.now(), "files": files.map { file -> [String: Any] in
                        // A photo or a scan is picked `original: false`: the engine plans and stores no original for it.
                        ["id": file.id, "name": file.name, "bytes": file.bytes, "kind": LabFileReader.pathExtension(file.name) == "zip" ? "zip" : "file"]
                            .merging(file.keepsOriginal ? [:] : ["original": false]) { $1 }
                    }]))]
        await drain()
        return true
    }

    func consented() async { await submit(EngineNatives.json(["type": "consented"])) }
    func stop() async { await submit(EngineNatives.json(["type": "stop"])) }
    func retry(_ id: String) async { await submit(EngineNatives.json(["type": "retry", "id": id])) }
    func close() async {
        picks += 1
        await submit(EngineNatives.json(["type": "close"]))
    }
    func discard() async {
        picks += 1
        await submit(EngineNatives.json(["type": "discard"]))
    }

    /// The engine's state text and the bytes held, for a test.
    var stateText: String? { state }
    var heldBytes: Int { held.heldBytes }

    /// Queues one event; the first caller steps every queued event in order, each on the state
    /// the last step returned, so no two steps ever start from one state (uploadStepJson's rule).
    func submit(_ event: String) async {
        queue(event)
        await drain()
    }

    /// Queues one event without stepping it, answering its number: a view drawn through it
    /// (`UploadModel.drawnThrough`) shows its step. `drain()` then steps it.
    @discardableResult
    func queue(_ event: String) -> Int {
        queued += 1
        waiting.append(.event(event))
        return queued
    }

    func drain() async {
        guard !stepping else { return }
        stepping = true
        while !waiting.isEmpty {
            switch waiting.removeFirst() {
            case .hold(let files):
                for file in files { held.hold(file.data, as: file.id, name: file.name, redrawn: file.redrawn) }
            case .event(let event):
                let answer = await step(event)
                stepped += 1 // before anything awaits, so a view of this step's state counts it
                switch answer {
                case .answered: break
                case .refused(let refusal): await refuse(refusal)
                case nil: await refuse(nil)
                }
            }
        }
        stepping = false
    }

    /// One step on the current state; its effects started and a view asked for when it answers.
    private func step(_ event: String) async -> UploadDoors.Answer<Void>? {
        guard let current = state else { return .answered(()) }
        let (record, deviceId) = (await setup.record(), setup.deviceId)
        setup.watch?(true)
        let answer: UploadDoors.Answer<UploadStep>?? = try? await engine.perform {
            try $0.uploadStep(state: current, event: event, record: record, deviceId: deviceId)
        }
        setup.watch?(false)
        switch answer {
        case .answered(let step)??:
            upload = .started(step.state)
            step.effects.forEach(carryOut)
            askView()
            return .answered(())
        case .refused(let refusal)??: return .refused(refusal)
        default: return nil
        }
    }

    /// A step refused or failed: its event is lost, so the run cannot go on. The refusal stays on
    /// the model until the next pick; every task of the run is cancelled and the engine told `stop`,
    /// so no file waits forever. A `stop` that fails too leaves nothing held.
    private func refuse(_ refusal: UploadDoors.Refusal?) async {
        await model.show(.refused(refusal))
        for send in sends.values { send.task.cancel() }
        for task in work.values { task.cancel() }
        sends = [:]
        work = [:]
        if case .answered = await step(EngineNatives.json(["type": "stop"])) { return }
        held.forgetAll()
    }

    // MARK: Effects

    /// Starts one effect; its answer comes back as an event through `submit`.
    private func carryOut(_ effect: UploadDoors.Effect) {
        let (held, rules) = (held, rules)
        switch effect {
        case .list(let run, let id):
            answer {
                guard let members = try? held.list(id, rules: rules) else { return ["type": "zipFailed", "run": run, "zip": id] }
                return ["type": "listed", "run": run, "zip": id, "members": members.map { member -> [String: Any] in
                    ["id": member.id, "name": member.entry.name, "bytes": member.entry.size]
                }]
            }
        case .hash(let run, let id):
            answer {
                guard let hash = try? held.hash(id) else { return ["type": "hashFailed", "run": run, "id": id] }
                return ["type": "hashed", "run": run, "id": id, "hash": hash]
            }
        case .convert(let run, let id):
            answer {
                guard let document = try? held.convert(id, rules: rules) else { return ["type": "convertFailed", "run": run, "id": id, "reason": "unreadable"] }
                return ["type": "converted", "run": run, "id": id, "pages": document.pages.count, "truncated": document.truncated]
            }
        case .send(let run, let id, _, let flags):
            let token = UUID()
            let unitSystem = setup.unitSystem
            let sender = setup.send ?? { [sender = setup.sender] body in try await sender.send(body) }
            sends[id]?.task.cancel()
            sends[id] = (token, Task.detached { [weak self] in
                let outcome: LabReadSender.Outcome
                do {
                    // Pages forgotten or never made: nothing worth a request; the engine judges it.
                    guard let pages = held.pages(id) else { throw LabFileReader.Failure.empty }
                    outcome = try await sender(LabReadSender.body(pages: pages, unitSystem: unitSystem, flags: flags))
                } catch is CancellationError {
                    return // aborted: the engine already moved the file on
                } catch {
                    outcome = .local(.dropped) // nothing to send: no pages held for it
                }
                await self?.sent(id, token: token, event: Self.event(for: outcome, run: run, id: id))
            })
        case .abort(let ids):
            for id in ids { sends.removeValue(forKey: id)?.task.cancel() }
        case .forget(let ids):
            held.forget(ids)
        case .save(let run, let attempt):
            guard let save = setup.save, let saving = state else { break }
            Task.detached { [weak self] in
                let event = await save(saving, run, attempt)
                await self?.submit(event)
            }
        case .other:
            break
        }
    }

    /// Runs `work` off the actor and steps its answer; refusing the run cancels it.
    private func answer(_ make: @escaping @Sendable () -> [String: Any]) {
        let ticket = UUID()
        work[ticket] = Task.detached { [weak self] in
            let event = EngineNatives.json(make())
            guard !Task.isCancelled else { return }
            await self?.finished(ticket, event: event)
        }
    }

    private func finished(_ ticket: UUID, event: String) async {
        guard work.removeValue(forKey: ticket) != nil else { return }
        await submit(event)
    }

    private func sent(_ id: String, token: UUID, event: String) async {
        guard sends[id]?.token == token else { return }
        sends[id] = nil
        await submit(event)
    }

    /// How a send ended, as the engine's event: the stream's end, or a refusal before it.
    static func event(for outcome: LabReadSender.Outcome, run: Int, id: String) -> String {
        switch outcome {
        case .ended(let line):
            EngineNatives.json(["type": "streamEnded", "run": run, "id": id, "line": line ?? NSNull(), "now": now()])
        case .refused(let status, let body, let contentType):
            EngineNatives.json(["type": "sendFailed", "run": run, "id": id, "status": status, "body": body, "contentType": contentType ?? NSNull()])
        case .local(let local):
            EngineNatives.json(["type": "sendFailed", "run": run, "id": id, "status": NSNull(), "body": NSNull(), "contentType": NSNull(), "local": local.wire])
        }
    }

    // MARK: The view

    /// The record changed while the page is open (another device synced, an edit elsewhere): the view
    /// is drawn again from the engine with the current record, coalesced like any draw; nothing steps.
    /// The view door drops a Replace whose target left its slot (health-core replacesLost).
    func recordChanged() {
        if state != nil { askView() }
    }

    /// Asks for a view of the latest state: one is computed at a time, on the engine's queue, at
    /// most one a frame; steps meanwhile are drawn by the next.
    private func askView() {
        let was = view
        view = ViewLoop.transition(view, .asked)
        if was == .idle { Task { await drawViews() } }
    }

    private func drawViews() async {
        while view != .idle, let current = state {
            let through = stepped
            let (record, deviceId, cloud) = (await setup.record(), setup.deviceId, await setup.cloudConnected())
            let answer: UploadDoors.Answer<String>?? = try? await engine.perform {
                try $0.uploadView(state: current, record: record, now: .now, cloudConnected: cloud, deviceId: deviceId)
            }
            switch answer {
            case .answered(let drawn)??: await model.show(.drawn(drawn), through: through)
            case .refused(let refusal)??: await model.show(.refused(refusal))
            default: await model.show(.refused(nil))
            }
            try? await Task.sleep(for: setup.frame)
            view = ViewLoop.transition(view, .drawn)
        }
        view = .idle
    }

    private static func now() -> String { Date.now.formatted(HealthEngine.iso) }
}
