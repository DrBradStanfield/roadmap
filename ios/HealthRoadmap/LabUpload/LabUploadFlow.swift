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
        /// Skip, Next report or Done on a review; `saved`: that report's own Save ran.
        case next(saved: Bool)
        /// Save all: every report from the one shown to the last (AC8b).
        case saveAll
        case reportStarted(Int)
        case reportFinished(Int, ReportOutcome)
        /// A refusal that would repeat for every report left (the record the run began on
        /// is gone): the run stops and says so once; what was saved stays saved.
        case stopped(Int, String)
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
        case (.review(let results, let index, let from?), .next(let saved)):
            return .saveAllDone(results, saved ? from.marking(savedAt: index) : from)
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
        case (.savingAll(let results, let progress), .stopped(let i, let reason)):
            return .saveAllDone(results, SaveAllSummary(progress, stoppedAt: i, reason: reason))
        case (.saveAllDone(let results, let summary), .open(let i)):
            return .review(results, index: i, from: summary)
        case (_, .done):
            return .finished
        default:
            return step
        }
    }
}

/// How one report fared in save all.
enum ReportOutcome: Equatable {
    case saved(values: Int, documents: Int)
    /// Not saved, with why in plain words ("Needs the test day").
    case notSaved(String)
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

/// What save all did, said once at its end (AC8b).
struct SaveAllSummary: Equatable {
    struct NotSaved: Equatable {
        let index: Int
        let reason: String
    }

    var values = 0
    var documents = 0
    /// In picked order.
    var notSaved: [NotSaved] = []
    /// Why the run stopped early; nil when every report was tried.
    var stopped: String?

    init(_ progress: SaveAllProgress, stoppedAt: Int? = nil, reason: String? = nil) {
        for index in progress.reports {
            switch progress.outcomes[index] {
            case .saved(let v, let d)?:
                values += v
                documents += d
            case .notSaved(let why)?:
                notSaved.append(.init(index: index, reason: why))
            case nil where index == stoppedAt:
                notSaved.append(.init(index: index, reason: reason ?? "Not saved"))
            case nil:
                notSaved.append(.init(index: index, reason: "Not tried"))
            }
        }
        stopped = reason
    }

    /// The summary once a report opened from it was saved by its own Save.
    func marking(savedAt index: Int) -> SaveAllSummary {
        var next = self
        next.notSaved.removeAll { $0.index == index }
        return next
    }
}
