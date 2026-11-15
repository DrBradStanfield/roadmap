import Foundation
import Observation

/// What the shared upload's screen draws from (design PR 14; drawn by the review page, PR 15):
/// one state, set only by the runner, on the main actor.
@MainActor @Observable
final class UploadModel {
    enum State: Equatable {
        /// The engine lacks the shared upload's doors: the app keeps today's flow.
        case unavailable
        /// Started, no view drawn yet.
        case starting
        /// The latest view, health-core UploadView as the engine's JSON text.
        case drawn(String)
        /// A door refused, in its own words; nil when the engine call itself failed.
        case refused(UploadDoors.Refusal?)
    }
    private(set) var state: State = .starting

    func show(_ state: State) {
        if self.state != state { self.state = state }
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
    /// One picked file, its bytes read: a ZIP by its name.
    struct Picked: Sendable {
        let id: String
        let name: String
        let data: Data
    }

    /// What the runner works with, besides the engine.
    struct Setup: Sendable {
        var deviceId: String
        /// The record as text, "" for none, read for the steps and views that need it.
        var record: @Sendable () async -> String
        /// The upload rules for the pick (`HealthEngine.uploadRules`).
        var ask: LabFileReader.AskRules = LabFileReader.swiftRules
        var sender = LabReadSender()
        var unitSystem = "si"
        var cloudConnected = false
        /// The `save` effect, left to the one save door (a later PR).
        var save: @Sendable (_ run: Int, _ attempt: Int) async -> Void = { _, _ in }
        /// At most one view a frame: the latest state wins.
        var frame: Duration = .milliseconds(16)
    }

    nonisolated let model: UploadModel
    private let engine: HealthEngine
    private let setup: Setup
    private let held = LabFileReader.Held()
    private var rules = LabFileReader.Rules.swift
    /// The engine's state, as its text; nil until the first pick.
    private var state: String?
    /// Events waiting for their step, in arrival order; `stepping` claims the queue while one runs.
    private var waiting: [String] = []
    private var stepping = false
    private var sends: [String: (attempt: Int, task: Task<Void, Never>)] = [:]
    private var view = ViewLoop.idle

    /// Called as each step starts (true) and ends (false). Nil in the app; set only by a test.
    nonisolated(unsafe) static var stepWatch: (@Sendable (Bool) -> Void)?

    init(engine: HealthEngine, model: UploadModel, setup: Setup) {
        self.engine = engine
        self.model = model
        self.setup = setup
    }

    /// Picks `files`, in picked order, starting the engine's upload on the first pick. False, and
    /// the model `unavailable`, when the engine lacks the doors or cannot run them: the app keeps
    /// today's flow.
    func pick(_ files: [Picked], needsConsent: Bool) async -> Bool {
        if state == nil {
            let started: UploadDoors.Answer<String>?? = try? await engine.perform { try $0.uploadStart(platform: "phone") }
            switch started {
            case .answered(let initial)??: state = initial
            case .refused(let refusal)??: await model.show(.refused(refusal)); return false
            default: await model.show(.unavailable); return false
            }
        }
        for file in files { held.hold(file.data, as: file.id, name: file.name) }
        rules = await setup.ask(files.map { LabFileReader.UploadFile(name: $0.name, bytes: $0.data.count) }, [])
        await submit(EngineNatives.json(["type": "picked", "needsConsent": needsConsent, "now": Self.now(), "files": files.map { file -> [String: Any] in
            ["id": file.id, "name": file.name, "bytes": file.data.count, "kind": LabFileReader.pathExtension(file.name) == "zip" ? "zip" : "file"]
        }]))
        return true
    }

    func consented() async { await submit(EngineNatives.json(["type": "consented"])) }
    func stop() async { await submit(EngineNatives.json(["type": "stop"])) }
    func close() async { await submit(EngineNatives.json(["type": "close"])) }
    func discard() async { await submit(EngineNatives.json(["type": "discard"])) }
    func retry(_ id: String) async { await submit(EngineNatives.json(["type": "retry", "id": id])) }

    /// The engine's state text and the bytes held, for a test.
    var stateText: String? { state }
    var heldBytes: Int { held.heldBytes }

    /// Queues one event; the first caller steps every queued event in order, each on the state
    /// the last step returned, so no two steps ever start from one state (uploadStepJson's rule).
    func submit(_ event: String) async {
        waiting.append(event)
        guard !stepping else { return }
        stepping = true
        while !waiting.isEmpty {
            let event = waiting.removeFirst()
            guard let current = state else { continue }
            let (record, deviceId) = (await setup.record(), setup.deviceId)
            Self.stepWatch?(true)
            let answer: UploadDoors.Answer<UploadStep>?? = try? await engine.perform {
                try $0.uploadStep(state: current, event: event, record: record, deviceId: deviceId)
            }
            Self.stepWatch?(false)
            switch answer {
            case .answered(let step)??:
                state = step.state
                step.effects.forEach(carryOut)
                askView()
            case .refused(let refusal)??: await model.show(.refused(refusal))
            default: await model.show(.refused(nil))
            }
        }
        stepping = false
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
        case .send(let run, let id, let attempt, let flags):
            let (sender, unitSystem) = (setup.sender, setup.unitSystem)
            sends[id]?.task.cancel()
            sends[id] = (attempt, Task.detached { [weak self] in
                let outcome: LabReadSender.Outcome
                do {
                    // Pages forgotten or never made: nothing worth a request; the engine judges it.
                    guard let pages = held.pages(id) else { throw LabFileReader.Failure.empty }
                    outcome = try await sender.send(LabReadSender.body(pages: pages, unitSystem: unitSystem, flags: flags))
                } catch is CancellationError {
                    return // aborted: the engine already moved the file on
                } catch {
                    outcome = LabReadSender.noAnswer
                }
                await self?.sent(id, attempt: attempt, event: Self.event(for: outcome, run: run, id: id))
            })
        case .abort(let ids):
            for id in ids { sends.removeValue(forKey: id)?.task.cancel() }
        case .forget(let ids):
            held.forget(ids)
        case .save(let run, let attempt):
            let save = setup.save
            Task.detached { await save(run, attempt) }
        case .other:
            break
        }
    }

    /// Runs `work` off the actor and steps its answer.
    private func answer(_ work: @escaping @Sendable () -> [String: Any]) {
        Task.detached { [weak self] in await self?.submit(EngineNatives.json(work())) }
    }

    private func sent(_ id: String, attempt: Int, event: String) async {
        if sends[id]?.attempt == attempt { sends[id] = nil }
        await submit(event)
    }

    /// How a send ended, as the engine's event: the stream's end, or a refusal before it.
    static func event(for outcome: LabReadSender.Outcome, run: Int, id: String) -> String {
        switch outcome {
        case .ended(let line):
            EngineNatives.json(["type": "streamEnded", "run": run, "id": id, "line": line ?? NSNull(), "now": now()])
        case .refused(let status, let body, let contentType):
            EngineNatives.json(["type": "sendFailed", "run": run, "id": id, "status": status ?? NSNull(), "body": body ?? NSNull(), "contentType": contentType ?? NSNull()])
        }
    }

    // MARK: The view

    /// Asks for a view of the latest state: one is computed at a time, on the engine's queue, at
    /// most one a frame; steps meanwhile are drawn by the next.
    private func askView() {
        let was = view
        view = ViewLoop.transition(view, .asked)
        if was == .idle { Task { await drawViews() } }
    }

    private func drawViews() async {
        while view != .idle, let current = state {
            let (record, deviceId, cloud) = (await setup.record(), setup.deviceId, setup.cloudConnected)
            let answer: UploadDoors.Answer<String>?? = try? await engine.perform {
                try $0.uploadView(state: current, record: record, now: .now, cloudConnected: cloud, deviceId: deviceId)
            }
            switch answer {
            case .answered(let drawn)??: await model.show(.drawn(drawn))
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
