import Foundation

/// The engine's view of an extraction, for the review screen (US-52 AC8;
/// ios/engine/lab-review.ts). Swift shows it; the engine decides every day and row.
struct LabReview: Decodable, Equatable, Sendable {
    struct Item: Decodable, Equatable, Identifiable, Sendable {
        let ref: String
        let label: String
        let value: String
        let unit: String
        /// The value's own day; nil means the report's day.
        let day: String?
        /// The extractor was unsure or guessed the unit: the review flags it.
        let check: Bool
        /// The extractor's own question ("Was this a blood test?"): shown, and the value starts unticked.
        let question: String?
        var id: String { ref }
    }

    struct NotSaved: Decodable, Equatable, Sendable {
        let label: String
        let reason: String
    }

    /// A letter, discharge summary or other document, as the web's review card shows it (AC13d).
    struct Document: Decodable, Equatable, Sendable {
        /// The model's classification, shown read-only ("clinic_letter").
        let classification: String
        let title: String
        /// A past day, or nil: "Date unknown".
        let documentDate: String?
        /// The first 300 characters of the text.
        let preview: String
        /// The record already holds a document from a file of this name: the keep tick starts off.
        let alreadySaved: Bool
        /// A metadata-only row holds these bytes (a failed save, or the connector's; US-14 AC4):
        /// the card starts from its title and date, and the original is filed behind it even
        /// with the keep tick off, as the web archives it.
        let held: Bool
    }

    let isLabReport: Bool
    let reportDay: String?
    let items: [Item]
    let notSaved: [NotSaved]
    let unreadCount: Int
    let document: Document?
}

/// What the review chose to file for one file (US-52 AC13d): its document, with the
/// title and date the card shows, or a lab report's original. The engine builds the row.
struct DocumentChoice: Encodable, Equatable, Sendable {
    enum Kind: String, Encodable, Sendable { case document, labArchive }
    let kind: Kind
    let sourceFileName: String
    var title: String?
    /// nil: "Date unknown".
    var documentDate: String?
    var reportDay: String?
    /// The original's type; "" when there is none.
    let mimeType: String
    /// The original's 'sha256-<hex>' as the review read it; nil when there is none.
    var contentHash: String?
}

/// The engine's answer to a document save: the record it wrote, or why not.
struct DocumentSaveAnswer: Decodable, Equatable, Sendable {
    let ok: Bool
    let record: String?
    /// The erase the cloud record is at after the save; nil on the phone's file.
    let erase: String?
    let saved: Int?
    /// Originals a held row already stood in for that still could not be stored (US-14 AC4).
    let unstored: Int?
    /// The original reached the cloud; nil when none was offered to one.
    let stored: Bool?
    /// The original changed or could not be read after the review: only its text was saved.
    let stale: Bool?
    let message: String?
    /// In the cloud: the engine's stamp, set in Swift (`HealthEngine.stamp`).
    var order: Int? = nil
}

/// What saving the ticked values would do (labSaveSummary).
struct LabSaveSummary: Decodable, Equatable, Sendable {
    struct Refused: Decodable, Equatable, Sendable {
        let label: String
        let message: String
    }

    let saved: Int
    let skipped: Int
    let refused: [Refused]
}

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

/// The engine's words for a save it refused.
struct LabRefusal: Error, Equatable {
    let message: String
}

private struct SummaryAnswer: Decodable {
    let ok: Bool
    let summary: LabSaveSummary?
    let message: String?
}
