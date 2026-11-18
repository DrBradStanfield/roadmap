import Foundation

/// The shared upload's doors as the runner reads them (design PR 14, ios/engine/upload-doors.ts):
/// the state stays the engine's text, split from its effects inside JavaScript, so no number in
/// it is ever re-written by Swift. A door's refusal is one typed value, never a throw.
enum UploadDoors {
    /// `{ok: false, reason, message}`: why a door would not answer, in its own words.
    struct Refusal: Decodable, Sendable, Equatable, Error {
        let reason: String
        let message: String
    }

    /// One effect, as health-core's UploadEffect names it; one this build does not know is `other`.
    enum Effect: Decodable, Sendable {
        case list(run: Int, id: String)
        case hash(run: Int, id: String)
        case convert(run: Int, id: String)
        case send(run: Int, id: String, attempt: Int, flags: LabReadSender.Flags)
        case abort(ids: [String])
        case forget(ids: [String])
        case save(run: Int, attempt: Int)
        case other

        private enum Key: String, CodingKey { case type, run, id, ids, attempt, flags }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            let run = { try c.decode(Int.self, forKey: .run) }, id = { try c.decode(String.self, forKey: .id) }
            let ids = { try c.decode([String].self, forKey: .ids) }, attempt = { try c.decode(Int.self, forKey: .attempt) }
            switch try c.decode(String.self, forKey: .type) {
            case "list": self = .list(run: try run(), id: try id())
            case "hash": self = .hash(run: try run(), id: try id())
            case "convert": self = .convert(run: try run(), id: try id())
            case "send": self = .send(run: try run(), id: try id(), attempt: try attempt(), flags: try c.decode(LabReadSender.Flags.self, forKey: .flags))
            case "abort": self = .abort(ids: try ids())
            case "forget": self = .forget(ids: try ids())
            case "save": self = .save(run: try run(), attempt: try attempt())
            default: self = .other
            }
        }
    }

    /// A door's answer: what it gave, or its refusal.
    enum Answer<T: Sendable>: Sendable {
        case answered(T)
        case refused(Refusal)
    }

    /// A door's text as it answered, or its refusal (`JSON.stringify` puts `ok` first).
    static func answer(_ text: String) -> Answer<String> {
        guard text.hasPrefix(#"{"ok":false"#), let refusal = try? JSONDecoder().decode(Refusal.self, from: Data(text.utf8)) else { return .answered(text) }
        return .refused(refusal)
    }

    /// Splits `{state, effects}` in the engine, where the state's text is made: `[state, effects]`.
    static let splitScript = "(a) => { const o = JSON.parse(a); return JSON.stringify([JSON.stringify(o.state), o.effects]); }"
}

extension HealthEngine {
    /// A new upload's state; nil from an engine without the shared upload's doors.
    func uploadStart(platform: String) throws -> UploadDoors.Answer<String>? {
        try doorUploadStartJson(platform: platform).map(UploadDoors.answer)
    }

    /// One step: the next state's text and its effects; nil from an engine without the door.
    func uploadStep(state: String, event: String, record: String, deviceId: String) throws -> UploadDoors.Answer<UploadStep>? {
        guard let text = try doorUploadStepJson(stateJson: state, eventJson: event, recordJson: record, deviceId: deviceId) else { return nil }
        if case .refused(let refusal) = UploadDoors.answer(text) { return .refused(refusal) }
        let parts = try evaluate(UploadDoors.splitScript).call(withArguments: [text])?.toString() ?? ""
        guard let array = try? JSONSerialization.jsonObject(with: Data(parts.utf8)) as? [Any], array.count == 2, let next = array[0] as? String else {
            throw EngineError.callFailed("the upload step")
        }
        return .answered(UploadStep(state: next, effects: try JSONDecoder().decode([UploadDoors.Effect].self, from: JSONSerialization.data(withJSONObject: array[1]))))
    }

    /// The drawable view's text, or its refusal; nil from an engine without the door.
    func uploadView(state: String, record: String, now: Date, cloudConnected: Bool, deviceId: String) throws -> UploadDoors.Answer<String>? {
        try doorUploadViewJson(stateJson: state, recordJson: record, nowIso: now.formatted(HealthEngine.iso),
                               cloudConnected: cloudConnected, deviceId: deviceId).map(UploadDoors.answer)
    }
}

/// One step's answer: the next state, as the engine's text, and the effects to carry out.
struct UploadStep: Sendable {
    let state: String
    let effects: [UploadDoors.Effect]
}
