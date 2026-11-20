import Foundation
import JavaScriptCore

/// The shared upload's one Save (design PR 15, US-52 AC8c, AC13d, US-14 AC10): health-core
/// `uploadSave` through the `uploadSaveJson` door writes the values, documents and originals in
/// one step; the record it answers is written as a document save's is, before the page says saved.
struct UploadSaveAnswer: Decodable, Sendable {
    struct Outcome: Decodable, Equatable, Sendable {
        let values: Int
        let documents: Int
        let archived: Int
        let unstored: Int?
    }
    let ok: Bool
    let record: String?
    /// The erase the cloud record is at after the save; nil on the phone's file.
    let erase: String?
    let outcome: Outcome?
    let message: String?
    /// The engine's stamp on the answer (`stamped`), set in Swift.
    var order: Int?

    private enum CodingKeys: String, CodingKey { case ok, record, erase, outcome, message }
}

extension HealthEngine {
    /// Saves an upload in the `saving` phase; nil from an engine without the door. `originals`:
    /// file id to MIME type for each original held; `read` gives an original's bytes by file id
    /// (nil when they cannot be read now), called on the engine's queue as each is written.
    func uploadSave(state: String, recordJSON: String, erase: String, now: Date, deviceId: String,
                    originals: [String: String], read: @escaping @Sendable (String) -> Data?) async throws -> UploadSaveAnswer? {
        let reader: @convention(block) (String) -> JSValue = { id in
            let context = JSContext.current()!
            return read(id).map { EngineNatives.arrayBuffer($0, in: context) } ?? JSValue(nullIn: context)
        }
        let originalsJSON = String(decoding: try JSONEncoder().encode(originals), as: UTF8.self)
        let stampedAnswer = try await doorUploadSaveJson(stateJson: state, recordJson: recordJSON, erase: erase, nowIso: now.formatted(Self.iso),
                                                         deviceId: deviceId, originalsJson: originalsJSON,
                                                         readOriginal: unsafeBitCast(reader, to: AnyObject.self), read: stamped)
        guard let (json, order) = stampedAnswer else { return nil }
        var answer = try JSONDecoder().decode(UploadSaveAnswer.self, from: Data(json.utf8))
        answer.order = order
        return answer
    }
}
