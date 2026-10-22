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

    let isLabReport: Bool
    let reportDay: String?
    let items: [Item]
    let notSaved: [NotSaved]
    let unreadCount: Int
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
    /// The review of the server's extraction (the `data` object, as JSON text).
    func labReview(extractionJSON: String, now: Date) throws -> LabReview {
        let json = try call("labReviewJson", [extractionJSON, now.formatted(Self.iso)])
        return try JSONDecoder().decode(LabReview.self, from: Data(json.utf8))
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
