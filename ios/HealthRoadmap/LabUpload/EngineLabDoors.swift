import Foundation

/// The engine doors "Add medical records" uses (US-52). Each runs health-core in
/// JavaScriptCore; these only carry text and bytes across.
extension HealthEngine {
    /// The review of the server's extraction (the `data` object, as JSON text). With the
    /// record, the file's name and the original's hash, a document says whether it is
    /// already saved and whether a held row stands for it (AC13d, US-14 AC4).
    func labReview(extractionJSON: String, now: Date, recordJSON: String = "", sourceFileName: String = "", contentHash: String = "", deviceId: String = "") throws -> LabReview {
        let json = try call("labReviewJson", [extractionJSON, now.formatted(Self.iso), recordJSON, sourceFileName, contentHash, deviceId])
        return try JSONDecoder().decode(LabReview.self, from: Data(json.utf8))
    }

    /// Each file read, named as health-core stores a `sourceFileName` (the document dedup
    /// key, AC13d): a ZIP member by the web's zipMemberName, any other file on one line and
    /// cut to its cap. One engine call per read; on a failure the names stay as read.
    func named(_ documents: [LabFileReader.Document]) async -> [LabFileReader.Document] {
        let files: [[String: String]] = documents.map { document in
            document.zipMember.map { ["zip": $0.zip, "path": $0.path] } ?? ["name": document.name]
        }
        guard let json = try? JSONEncoder().encode(files),
              let answer = try? await callAsync("fileNamesJson", [String(decoding: json, as: UTF8.self)]),
              let names = try? JSONDecoder().decode([String].self, from: Data(answer.utf8)), names.count == documents.count
        else { return documents }
        var named = documents
        for index in named.indices { named[index].name = names[index] }
        return named
    }

    /// Files one document, or a lab report's original, through health-core's saveDocuments
    /// (US-52 AC13d). `erase`: the cloud record's, or "" for the phone's file `recordJSON`.
    func documentSave(recordJSON: String, extractionJSON: String, choice: DocumentChoice, original: Data?, erase: String, now: Date, deviceId: String) async throws -> DocumentSaveAnswer {
        let choiceJSON = String(decoding: try JSONEncoder().encode(choice), as: UTF8.self)
        let bytes: Any = original.map { arrayBuffer($0) } ?? NSNull()
        let (json, order) = try await callAsync("documentSave", [recordJSON, extractionJSON, choiceJSON, bytes, erase, now.formatted(Self.iso), deviceId], read: stamped)
        var answer = try JSONDecoder().decode(DocumentSaveAnswer.self, from: Data(json.utf8))
        answer.order = order
        return answer
    }

    /// What saving `refs` on `reportDay` would do, or the engine's refusal. The record is not changed.
    func labSaveSummary(recordJSON: String, extractionJSON: String, refs: [String], reportDay: String, now: Date, deviceId: String) throws -> Result<LabSaveSummary, LabRefusal> {
        let refsJSON = String(decoding: try JSONEncoder().encode(refs), as: UTF8.self)
        let json = try call("labSaveSummaryJson", [recordJSON, extractionJSON, refsJSON, reportDay, now.formatted(Self.iso), deviceId])
        let answer = try JSONDecoder().decode(SummaryAnswer.self, from: Data(json.utf8))
        if answer.ok, let summary = answer.summary { return .success(summary) }
        return .failure(LabRefusal(message: answer.message ?? "These values could not be saved."))
    }
}

private struct SummaryAnswer: Decodable {
    let ok: Bool
    let summary: LabSaveSummary?
    let message: String?
}
