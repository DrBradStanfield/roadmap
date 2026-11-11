import XCTest
@testable import HealthRoadmap

/// US-52 AC8b: the upload sheet's one named state, moved only by `transition`. Every
/// event, from the step it belongs to, and the steps it leaves alone.
final class LabUploadFlowTests: XCTestCase {
    typealias Step = LabUploadFlow.Step

    private static let at = Date(timeIntervalSince1970: 0)
    private static let docs = [LabFileReader.Document(name: "a.pdf", pages: [], truncated: false),
                               LabFileReader.Document(name: "b.pdf", pages: [], truncated: false)]
    private static let results = ["a.pdf", "b.pdf", "c.pdf"].map { LabResult(name: $0, truncated: false, extractionJSON: "{}", failure: nil) }
    private static let summary = SaveAllSummary(SaveAllProgress(reports: [0, 1, 2], outcomes: [
        0: .saved(values: 2, documents: 0, notes: ["Glucose: misread"]), 1: .notSaved("Needs the test day"), 2: .saved(values: 3, documents: 0)]))

    /// A step in words, so the table can compare steps that hold files and reports.
    private static func words(_ step: Step) -> String {
        switch step {
        case .choose: "choose"
        case .consent(let d): "consent \(d.count)"
        case .working(let what, let p, let back): "working \(what) \(p.map { "\($0.done)/\($0.total)" } ?? "-") back:\(words(back))"
        case .review(let r, let i, let from): "review \(i)/\(r.count)\(from == nil ? "" : " from summary \(from!.notSaved.map(\.index))")"
        case .savingAll(_, let p): "savingAll \(p.reports) done:\(p.done) inFlight:\(p.inFlight.sorted())"
        case .saveAllDone(_, let s): "saveAllDone values:\(s.values) docs:\(s.documents) notSaved:\(rows(s.notSaved)) partly:\(rows(s.partlySaved)) stopped:\(s.stopped.map { "\($0)" } ?? "-")"
        case .failed(let m): "failed \(m)"
        case .finished: "finished"
        }
    }

    private static func rows(_ rows: [SaveAllSummary.Row]) -> [String] {
        rows.map { "\($0.index) \($0.notes.joined(separator: " / "))" }
    }

    private static func saving(_ reports: [Int], inFlight: Set<Int> = [], outcomes: [Int: ReportOutcome] = [:]) -> Step {
        .savingAll(results, SaveAllProgress(reports: reports, inFlight: inFlight, outcomes: outcomes))
    }

    func testEveryEventMovesTheStepAsTheTableSays_US52_AC8b() {
        let review0 = Step.review(Self.results, index: 0)
        let review1 = Step.review(Self.results, index: 1)
        let review2 = Step.review(Self.results, index: 2)
        let fromSummary = Step.review(Self.results, index: 1, from: Self.summary)
        let table: [(String, Step, LabUploadFlow.Event, String)] = [
            ("a pick starts a read", .choose, .picked, "working Reading the file on your iPhone - back:choose"),
            ("a second pick while reading is ignored", .working("x", nil, back: .choose), .picked, "working x - back:choose"),
            ("a folder counts its reports", .working("x", nil, back: .choose), .readProgress(done: 1, total: 9, at: Self.at), "working Reading report 2 of 9 1/9 back:choose"),
            ("consent before the first send", .working("x", nil, back: .choose), .needsConsent(Self.docs), "consent 2"),
            ("each report sent in turn", .consent(Self.docs), .sending(1, of: Self.docs, at: Self.at), "working Reading the values in b.pdf 1/2 back:choose"),
            ("the answers open the first review", .working("x", nil, back: .choose), .extracted(Self.results), "review 0/3"),
            ("Try again reads, and Cancel comes back", review1, .retrying(at: 1), "working Reading the values in b.pdf - back:review 1/3"),
            ("Try again's answer replaces the review", .working("x", nil, back: review1), .retried(Self.results, at: 1), "review 1/3"),
            ("Cancel goes where the read came from", .working("x", nil, back: review1), .cancel, "review 1/3"),
            ("Cancel on a first read goes to the sources", .working("x", nil, back: .choose), .cancel, "choose"),
            ("a read that fails", .working("x", nil, back: .choose), .failed("No"), "failed No"),
            ("choose another file", .failed("No"), .restart, "choose"),
            ("Skip moves to the next report", review0, .next(nil), "review 1/3"),
            ("Done on the last report closes", review2, .next(.saved(values: 1, documents: 0)), "finished"),
            ("save all takes the report shown and every one after it", review1, .saveAll, "savingAll [1, 2] done:0 inFlight:[]"),
            ("a report starts saving", Self.saving([1, 2]), .reportStarted(1), "savingAll [1, 2] done:0 inFlight:[1]"),
            ("a result lands", Self.saving([0, 1, 2], inFlight: [0]), .reportFinished(0, .saved(values: 2, documents: 0)), "savingAll [0, 1, 2] done:1 inFlight:[]"),
            ("a report that fails is listed and the run goes on", Self.saving([0, 1, 2], outcomes: [0: .saved(values: 2, documents: 0)]), .reportFinished(1, .notSaved("Refused by the cloud")),
             "savingAll [0, 1, 2] done:2 inFlight:[]"),
            ("the last result finishes, shown in picked order whatever order they came", Self.saving([0, 1, 2], outcomes: [2: .saved(values: 1, documents: 0), 1: .notSaved("Could not be read")]),
             .reportFinished(0, .saved(values: 0, documents: 1)), "saveAllDone values:1 docs:1 notSaved:[\"1 Could not be read\"] partly:[] stopped:-"),
            ("a report saved with notes is partly saved, its notes listed; one fully saved only counts", Self.saving([0, 1], outcomes: [0: .saved(values: 2, documents: 0)]),
             .reportFinished(1, .saved(values: 1, documents: 0, notes: ["Glucose: misread", "The original was not stored"])),
             "saveAllDone values:3 docs:0 notSaved:[] partly:[\"1 Glucose: misread / The original was not stored\"] stopped:-"),
            ("a refusal that would repeat stops the run, saying why once; what was saved stays", Self.saving([0, 1, 2], outcomes: [0: .saved(values: 4, documents: 0)]), .stopped(1, .noCloud),
             "saveAllDone values:4 docs:0 notSaved:[\"1 Your cloud was disconnected, so this was not saved.\", \"2 Not tried\"] partly:[] stopped:noCloud"),
            ("a not-saved report opens from the summary", .saveAllDone(Self.results, Self.summary), .open(1), "review 1/3 from summary [1]"),
            ("a partly saved report opens from the summary too", .saveAllDone(Self.results, Self.summary), .open(0), "review 0/3 from summary [1]"),
            ("Skip on it goes back to the summary", fromSummary, .next(nil), "saveAllDone values:5 docs:0 notSaved:[\"1 Needs the test day\"] partly:[\"0 Glucose: misread\"] stopped:-"),
            ("its own Save takes it off the not-saved list and adds its counts", fromSummary, .next(.saved(values: 2, documents: 1)),
             "saveAllDone values:7 docs:1 notSaved:[] partly:[\"0 Glucose: misread\"] stopped:-"),
            ("its own Save that wrote nothing keeps it listed, with the new reason", fromSummary, .next(.notSaved("Your record changed")),
             "saveAllDone values:5 docs:0 notSaved:[\"1 Your record changed\"] partly:[\"0 Glucose: misread\"] stopped:-"),
            ("a partly saved report saved again keeps its earlier counts; its notes are the latest", .review(Self.results, index: 0, from: Self.summary),
             .next(.saved(values: 0, documents: 0, notes: ["Glucose: misread again"])),
             "saveAllDone values:5 docs:0 notSaved:[\"1 Needs the test day\"] partly:[\"0 Glucose: misread again\"] stopped:-"),
            ("no save all from a report opened from the summary", fromSummary, .saveAll, "review 1/3 from summary [1]"),
            ("the summary's Done closes", .saveAllDone(Self.results, Self.summary), .done, "finished"),
            ("Close cannot be beaten by a late cancel during save all", Self.saving([1, 2]), .cancel, "savingAll [1, 2] done:0 inFlight:[]"),
            ("a late result outside save all changes nothing", review0, .reportFinished(0, .saved(values: 1, documents: 0)), "review 0/3"),
            ("Stop sharing goes to the sources", .choose, .restart, "choose"),
        ]
        for (name, from, event, expected) in table {
            XCTAssertEqual(Self.words(LabUploadFlow.transition(from, event)), expected, name)
        }
    }
}
