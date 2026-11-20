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

extension RecordStore {
    /// Saves the upload whose state is `state`, in the record's turn, as `saveDocument` files one
    /// document: in the cloud through the engine's session at the erase the screen shows, then drawn;
    /// on the phone over the record the save began from, written to the file before it answers.
    func saveUpload(state: String, originals: [String: String], read: @escaping @Sendable (String) -> Data?) async -> Result<UploadSaveAnswer.Outcome, LabRefusal> {
        let seen = pinned ?? screen
        return await chain { await self.saveUploadInTurn(state: state, originals: originals, read: read, as: seen) }.value
    }

    private func saveUploadInTurn(state: String, originals: [String: String], read: @escaping @Sendable (String) -> Data?, as seen: Screen) async -> Result<UploadSaveAnswer.Outcome, LabRefusal> {
        guard shows(seen) else { return .failure(LabRefusal(message: Self.recordChanged)) }
        if case .predatesErase = hold { return .failure(LabRefusal(message: Self.recordChanged)) }
        if seen.erase == nil, let problem { return .failure(LabRefusal(message: problem.words)) }
        let before = recordJSON
        do {
            let answer = try await engine.uploadSave(state: state, recordJSON: seen.erase == nil ? before : "", erase: seen.erase ?? "",
                                                     now: .now, deviceId: deviceId, originals: originals, read: read)
            guard let answer, answer.ok, let next = answer.record, let outcome = answer.outcome else {
                return .failure(LabRefusal(message: answer?.message ?? Self.uploadNotSaved))
            }
            if let erase = seen.erase {
                // The engine's session took it; the screen follows unless it has moved on to another record.
                guard cloudErase == erase, let nextErase = answer.erase else { return .success(outcome) }
                if next != recordJSON {
                    await draw(next, order: answer.order, as: .cloudEdited(erase: nextErase), holdUndrawn: true)
                    onEdit?()
                }
                return .success(outcome)
            }
            guard try await commitPhoneDocument(next, over: before) else {
                return .failure(LabRefusal(message: "Your record changed while this was saving, so it was not saved. Save again."))
            }
            return .success(outcome)
        } catch {
            return .failure(LabRefusal(message: Self.uploadNotSaved))
        }
    }

    /// A refused or failed save, in the words a document save already uses.
    static let uploadNotSaved = "That could not be saved."
}
