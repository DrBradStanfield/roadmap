import Foundation

/// One report's choices on its review (US-52 AC8, AC13d): its ticks, test day and
/// document card. Held by the sheet, so a change made on a screen already shown carries
/// into save all (AC8b), and computed the same way for a report never opened.
struct LabChoices: Equatable {
    var ticked: Set<String> = []
    var testDay = Date.now
    /// The report printed no full day: Save waits until the user says the day is right (US-13 AC8's rule).
    var dayConfirmed = false
    /// The document card (AC13d): kept unless the record already holds one from this file.
    var keepDocument = false
    var documentTitle = ""
    var documentDateKnown = false
    var documentDate = Date.now

    init() {}

    /// A report's defaults, the one definition the review and save all share.
    init(review: LabReview) {
        if let document = review.document {
            keepDocument = !document.alreadySaved
            documentTitle = document.title
            if let day = document.documentDate, let date = DayText.noon(day) {
                documentDateKnown = true
                documentDate = date
            }
        }
        // A value the extractor asked about starts unticked: never saved unnoticed.
        ticked = Set(review.items.filter { $0.question == nil }.map(\.ref))
        if let day = review.reportDay, let date = DayText.noon(day) { testDay = date }
    }

    /// A ticked value with no day of its own takes the test's day.
    func needsTestDay(_ review: LabReview) -> Bool {
        review.items.contains { ticked.contains($0.ref) && $0.day == nil }
    }

    /// Why the values' Save waits, or nil when it can run.
    func valuesWait(_ review: LabReview) -> String? {
        if ticked.isEmpty { return "No values ticked" }
        if review.reportDay == nil && !dayConfirmed && needsTestDay(review) { return "Needs the test day" }
        return nil
    }
}

/// What one report's Save would do, decided without the screen (AC8b).
enum LabSavePlan: Equatable {
    case values(refs: [String], day: String)
    case document(DocumentChoice)
    /// Nothing to save, and why in plain words.
    case nothing(String)

    /// `archiveOnly`: the web's archive-only path (US-14 AC4, US-35 AC8): a document whose
    /// bytes a held metadata-only row stands for has its original filed behind that row,
    /// even with the keep tick off.
    init(result: LabResult, review: LabReview?, choices: LabChoices, archiveOnly: Bool) {
        guard result.failure == nil, result.extractionJSON != nil, let review else { self = .nothing("Could not be read"); return }
        if review.document != nil {
            if choices.keepDocument || archiveOnly {
                self = .document(DocumentChoice(kind: .document, sourceFileName: result.name, title: choices.documentTitle,
                                                documentDate: choices.documentDateKnown ? DayText.iso(choices.documentDate) : nil,
                                                mimeType: result.original?.mimeType ?? "", contentHash: result.original?.contentHash))
            } else {
                self = .nothing(review.document?.alreadySaved == true ? "Already in your record" : "Not ticked to save")
            }
        } else if !review.isLabReport {
            self = .nothing("No values or document found")
        } else if let wait = choices.valuesWait(review) {
            self = .nothing(wait)
        } else {
            self = .values(refs: review.items.map(\.ref).filter { choices.ticked.contains($0) }, day: DayText.iso(choices.testDay))
        }
    }

    static func archiveOnly(_ review: LabReview?, result: LabResult, cloudConnected: Bool) -> Bool {
        review?.document?.held == true && cloudConnected && result.original != nil
    }
}

/// One report saved by the existing calls (importLabs, then the original by saveDocument;
/// or the document by saveDocument): the review's Save and save all both run this.
struct LabReportSave: Equatable {
    /// What was saved, in the review's words; nil when nothing was.
    var outcome: String?
    var problem: String?
    var values = 0
    var documents = 0
    /// Why a save that ran wrote nothing new (every value refused or already there, the file already held).
    var nothingNew = "Already in your record"

    /// How save all counts it.
    var reportOutcome: ReportOutcome {
        guard outcome != nil else { return .notSaved(problem ?? "Not saved") }
        if values == 0 && documents == 0 { return .notSaved(problem ?? nothingNew) }
        return .saved(values: values, documents: documents)
    }

    @MainActor
    static func run(_ plan: LabSavePlan, result: LabResult, store: RecordStore) async -> LabReportSave {
        guard let json = result.extractionJSON else { return LabReportSave(problem: "Could not be read") }
        var done = LabReportSave()
        switch plan {
        case .nothing(let reason):
            done.problem = reason
        case .values(let refs, let day):
            switch await store.importLabs(extractionJSON: json, refs: refs, reportDay: day) {
            case .failure(let refusal):
                done.problem = refusal.message
            case .success(let summary):
                done.outcome = describe(summary)
                done.values = summary.saved
                if summary.skipped == 0, let refused = summary.refused.first { done.nothingNew = refused.message }
                // The lab report's original, kept in the cloud as the web's hidden row (the
                // engine keeps it only there); the values are already saved.
                guard let original = result.original else { break }
                let choice = DocumentChoice(kind: .labArchive, sourceFileName: result.name, reportDay: day, mimeType: original.mimeType, contentHash: original.contentHash)
                switch await store.saveDocument(extractionJSON: json, choice: choice, original: original) {
                case .saved(let count, let stored, let unstored, let stale):
                    let line = originalLine(count: count, stored: stored, unstored: unstored, stale: stale, kept: "The original report is kept in your cloud.")
                    done.outcome = [done.outcome, line].compactMap { $0 }.joined(separator: "\n")
                case .refused(let message):
                    done.problem = message
                }
            }
        case .document(let choice):
            switch await store.saveDocument(extractionJSON: json, choice: choice, original: result.original) {
            case .saved(let count, let stored, let unstored, let stale):
                let first = count > 0 ? "The document is saved to your record." : "Your record already holds this file, so nothing new was saved."
                let line = originalLine(count: count, stored: stored, unstored: unstored, stale: stale, kept: "The original file is kept in your cloud.")
                done.outcome = [first, line].compactMap { $0 }.joined(separator: "\n")
                done.documents = count > 0 ? 1 : 0
            case .refused(let message):
                done.problem = message
            }
        }
        return done
    }

    /// What a save says of the original: `kept` when the cloud took it; that it changed
    /// since the review read it; the web's words (US-14 AC4) when the cloud did not take
    /// it; nothing when none was offered or nothing was new.
    static func originalLine(count: Int, stored: Bool?, unstored: Int, stale: Bool, kept: String) -> String? {
        if stale { return "The original changed or could not be read, so only its text was saved." }
        return switch stored {
        case true?: kept
        case false? where count > 0 || unstored > 0: "The original file couldn't be stored; its details are saved."
        default: nil
        }
    }

    static func describe(_ summary: LabSaveSummary) -> String {
        var parts = ["\(summary.saved) value\(summary.saved == 1 ? "" : "s") saved to your record."]
        if summary.skipped > 0 { parts.append("\(summary.skipped) left as they were: that day already had a value.") }
        for refused in summary.refused { parts.append(refused.line ?? "Not saved, \(refused.label): \(refused.message)") }
        return parts.joined(separator: "\n")
    }

    /// One waiting report saved as its own Save would (AC8b): its review read against the
    /// record as it is now, its held choices or its defaults, then `run`.
    @MainActor
    static func saveWaiting(_ result: LabResult, held: LabChoices?, engine: HealthEngine, store: RecordStore) async -> ReportOutcome {
        guard result.failure == nil, let json = result.extractionJSON else { return .notSaved("Could not be read") }
        let review: LabReview
        do {
            review = try await engine.labReview(extractionJSON: json, now: .now, recordJSON: store.recordJSON, sourceFileName: result.name,
                                                contentHash: result.original?.contentHash ?? "", deviceId: store.deviceId)
        } catch {
            return .notSaved("Could not be read")
        }
        let plan = LabSavePlan(result: result, review: review, choices: held ?? LabChoices(review: review),
                               archiveOnly: LabSavePlan.archiveOnly(review, result: result, cloudConnected: store.cloudErase != nil))
        if case .nothing(let reason) = plan { return .notSaved(reason) }
        return await run(plan, result: result, store: store).reportOutcome
    }
}
