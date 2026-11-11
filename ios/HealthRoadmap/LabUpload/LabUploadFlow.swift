import Foundation

/// The upload sheet's one named state (US-52 AC8b; CLAUDE.md, a mode is one named state):
/// each screen is a step, moved only by `transition`. LabUploadFlowTests holds the table.
enum LabUploadFlow {
    indirect enum Step {
        case choose
        case consent([LabFileReader.Document])
        /// What is happening now, how far through the reports the send is (nil before it
        /// starts), and where Cancel goes: the sources, or the review a Try again left (AC7a).
        case working(String, LabReadingDiagram.Progress?, back: Step)
        /// `from`: the save-all summary this report was opened from; its Skip or Done goes back there.
        case review([LabResult], index: Int, from: SaveAllSummary? = nil)
        case savingAll([LabResult], SaveAllProgress)
        case saveAllDone([LabResult], SaveAllSummary)
        case failed(String)
        /// The last report is done with: the sheet closes.
        case finished
    }

    enum Event {
        /// A source picked a file; only the sources take one, so a double tap starts one read.
        case picked
        case readProgress(done: Int, total: Int, at: Date)
        case needsConsent([LabFileReader.Document])
        case sending(Int, of: [LabFileReader.Document], at: Date)
        case extracted([LabResult])
        case retrying(at: Int)
        case retried([LabResult], at: Int)
        case cancel
        case failed(String)
        case restart
        /// Skip, Next report or Done on a review, with what that report's own Save did (nil: it did not run).
        case next(ReportOutcome?)
        /// Save all: every report from the one shown to the last (AC8b).
        case saveAll
        case reportStarted(Int)
        case reportFinished(Int, ReportOutcome)
        /// A refusal that would repeat for every report left (the record the review showed
        /// is gone): the run stops at that report and says why once; what was saved stays saved.
        case stopped(Int, SaveAllStop)
        /// A not-saved report tapped in the summary.
        case open(Int)
        case done
    }

    static func transition(_ step: Step, _ event: Event) -> Step {
        switch (step, event) {
        case (.choose, .picked):
            return .working("Reading the file on your iPhone", nil, back: .choose)
        case (.working(_, _, let back), .readProgress(let done, let total, let at)):
            return .working("Reading report \(done + 1) of \(total)", .init(done: done, total: total, started: at), back: back)
        case (_, .needsConsent(let documents)):
            return .consent(documents)
        case (_, .sending(let n, let documents, let at)):
            return .working("Reading the values in \(documents[n].name)", .init(done: n, total: documents.count, started: at), back: .choose)
        case (_, .extracted(let results)):
            return .review(results, index: 0)
        case (.review(let results, let index, _), .retrying(let at)) where at == index:
            return .working("Reading the values in \(results[index].name)", nil, back: step)
        case (.working(_, _, .review(_, _, let from)), .retried(let results, let at)):
            return .review(results, index: at, from: from)
        case (.working(_, _, let back), .cancel):
            return back
        case (_, .failed(let message)):
            return .failed(message)
        case (_, .restart):
            return .choose
        case (.review(let results, let index, let from?), .next(let outcome)):
            return .saveAllDone(results, outcome.map { from.adding($0, at: index) } ?? from)
        case (.review(let results, let index, .none), .next):
            return index + 1 < results.count ? .review(results, index: index + 1) : .finished
        case (.review(let results, let index, .none), .saveAll):
            return .savingAll(results, SaveAllProgress(reports: Array(index..<results.count)))
        case (.savingAll(let results, var progress), .reportStarted(let i)):
            progress.inFlight.insert(i)
            return .savingAll(results, progress)
        case (.savingAll(let results, var progress), .reportFinished(let i, let outcome)):
            progress.inFlight.remove(i)
            progress.outcomes[i] = outcome
            return progress.done == progress.total ? .saveAllDone(results, SaveAllSummary(progress)) : .savingAll(results, progress)
        case (.savingAll(let results, var progress), .stopped(let i, let why)):
            progress.outcomes[i] = .notSaved(why.words)
            return .saveAllDone(results, SaveAllSummary(progress, stopped: why))
        case (.saveAllDone(let results, let summary), .open(let i)):
            return .review(results, index: i, from: summary)
        case (_, .done):
            return .finished
        default:
            return step
        }
    }
}

/// How one report fared, in save all or by its own Save: what was saved, and each part not
/// saved in the person's words (a value the engine refused, the original's problem, or why
/// nothing was: "Needs the test day").
struct ReportOutcome: Equatable {
    var values = 0
    var documents = 0
    var notes: [String] = []
    var savedNothing: Bool { values + documents == 0 }

    static func saved(values: Int, documents: Int, notes: [String] = []) -> ReportOutcome {
        ReportOutcome(values: values, documents: documents, notes: notes)
    }

    static func notSaved(_ reason: String) -> ReportOutcome { ReportOutcome(notes: [reason]) }
}

/// Why save all stopped: a refusal that would repeat for every report left, said once (AC8b).
enum SaveAllStop: Error, Equatable {
    case noCloud, recordChanged, unreadable

    var words: String {
        switch self {
        case .noCloud: "Your cloud was disconnected, so this was not saved."
        case .recordChanged: "Your record changed while this was open, so this was not saved."
        case .unreadable: "Your record could not be read, so this was not saved."
        }
    }
}

/// Save all under way. Keyed by report index, so results may arrive in any order and
/// still show in picked order; `inFlight` lets a later parallel send fit the same shape.
struct SaveAllProgress: Equatable {
    /// The waiting reports, in picked order.
    let reports: [Int]
    var inFlight: Set<Int> = []
    var outcomes: [Int: ReportOutcome] = [:]
    var done: Int { outcomes.count }
    var total: Int { reports.count }
}

/// What save all did, said once at its end (AC8b). The totals and lists derive from each
/// report's outcome, so a report saved later from the summary moves both.
struct SaveAllSummary: Equatable {
    struct Row: Equatable {
        let index: Int
        let notes: [String]
    }

    /// In picked order; a report not tried has no outcome.
    let reports: [Int]
    var outcomes: [Int: ReportOutcome]
    /// Why the run stopped early; nil when every report was tried.
    var stopped: SaveAllStop?

    init(_ progress: SaveAllProgress, stopped: SaveAllStop? = nil) {
        reports = progress.reports
        outcomes = progress.outcomes
        self.stopped = stopped
    }

    var values: Int { outcomes.values.reduce(0) { $0 + $1.values } }
    var documents: Int { outcomes.values.reduce(0) { $0 + $1.documents } }

    /// The reports that saved nothing, or were not tried.
    var notSaved: [Row] {
        reports.compactMap { index in
            guard let outcome = outcomes[index] else { return Row(index: index, notes: ["Not tried"]) }
            return outcome.savedNothing ? Row(index: index, notes: outcome.notes) : nil
        }
    }

    /// The reports that saved something, with what they did not.
    var partlySaved: [Row] {
        reports.compactMap { index in
            guard let outcome = outcomes[index], !outcome.savedNothing, !outcome.notes.isEmpty else { return nil }
            return Row(index: index, notes: outcome.notes)
        }
    }

    /// The summary once a report opened from it ran its own Save: what that save wrote adds
    /// to what the report saved before (still in the record), and its notes are the latest.
    func adding(_ outcome: ReportOutcome, at index: Int) -> SaveAllSummary {
        var next = self
        let before = outcomes[index] ?? ReportOutcome()
        next.outcomes[index] = .saved(values: before.values + outcome.values, documents: before.documents + outcome.documents, notes: outcome.notes)
        return next
    }
}
