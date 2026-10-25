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

/// The engine's words for a save it refused.
struct LabRefusal: Error, Equatable {
    let message: String
}
