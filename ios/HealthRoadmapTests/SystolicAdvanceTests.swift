import XCTest
@testable import HealthRoadmap

/// US-02 AC12 (lead H73): the blood pressure sheet's systolic moves the focus to the diastolic by
/// health-core's rule, read through the engine, with US-02 AC6b and AC6c's pause rules. One named
/// state, changed only by `SystolicAdvance.transition`: every state by every event below.
final class SystolicAdvanceTests: XCTestCase {
    private typealias S = SystolicAdvance
    private let idle = S.idle
    private let asking = S.asking(systolic: "75", diastolic: "")
    private let pausing = S.pausing(systolic: "75")

    /// Every event, with the same text as `asking` and `pausing` hold, and with other text.
    private var events: [(String, S.Event)] {
        [
            ("typed 120", .typed(systolic: "120", diastolic: "")),
            ("judged advance", .judged(systolic: "75", diastolic: "", word: .advance)),
            ("judged defer", .judged(systolic: "75", diastolic: "", word: .`defer`)),
            ("judged stay", .judged(systolic: "75", diastolic: "", word: .stay)),
            ("judged, no door", .judged(systolic: "75", diastolic: "", word: nil)),
            ("judged other text", .judged(systolic: "7", diastolic: "", word: .advance)),
            ("judged other diastolic", .judged(systolic: "75", diastolic: "8", word: .advance)),
            ("pause ended, focused", .pauseEnded(systolic: "75", focused: true)),
            ("pause ended, left", .pauseEnded(systolic: "75", focused: false)),
            ("pause ended, other text", .pauseEnded(systolic: "7", focused: true)),
        ]
    }

    func testEveryStateByEveryEvent_US02_AC12() throws {
        let typed = S.asking(systolic: "120", diastolic: "")
        // [state: [event label: (next state, moves)]]
        let table: [(String, S, [String: (S, Bool)])] = [
            ("idle", idle, [
                "typed 120": (typed, false),
                "judged advance": (idle, false), "judged defer": (idle, false), "judged stay": (idle, false),
                "judged, no door": (idle, false), "judged other text": (idle, false), "judged other diastolic": (idle, false),
                "pause ended, focused": (idle, false), "pause ended, left": (idle, false), "pause ended, other text": (idle, false),
            ]),
            ("asking", asking, [
                "typed 120": (typed, false),
                "judged advance": (idle, true), "judged defer": (pausing, false), "judged stay": (idle, false),
                "judged, no door": (idle, false), "judged other text": (asking, false), "judged other diastolic": (asking, false),
                "pause ended, focused": (asking, false), "pause ended, left": (asking, false), "pause ended, other text": (asking, false),
            ]),
            ("pausing", pausing, [
                "typed 120": (typed, false),
                "judged advance": (pausing, false), "judged defer": (pausing, false), "judged stay": (pausing, false),
                "judged, no door": (pausing, false), "judged other text": (pausing, false), "judged other diastolic": (pausing, false),
                "pause ended, focused": (idle, true), "pause ended, left": (idle, false), "pause ended, other text": (pausing, false),
            ]),
        ]
        for (name, state, row) in table {
            XCTAssertEqual(row.count, events.count, "\(name): every event has a cell")
            for (label, event) in events {
                let (want, moves) = try XCTUnwrap(row[label], "\(name) x \(label)")
                let got = S.transition(state, event)
                XCTAssertEqual(got.state, want, "\(name) x \(label)")
                XCTAssertEqual(got.moves, moves, "\(name) x \(label): moves")
            }
        }
    }

    /// AC6c: "65" edited to "6" during the pause cancels it; the old pause's end moves nothing.
    func testAnEditDuringThePauseCancelsIt_US02_AC6c() {
        var state = S.transition(.idle, .typed(systolic: "65", diastolic: "")).state
        state = S.transition(state, .judged(systolic: "65", diastolic: "", word: .`defer`)).state
        XCTAssertEqual(state, .pausing(systolic: "65"))
        state = S.transition(state, .typed(systolic: "6", diastolic: "")).state
        state = S.transition(state, .judged(systolic: "6", diastolic: "", word: .stay)).state
        let end = S.transition(state, .pauseEnded(systolic: "65", focused: true))
        XCTAssertEqual(end.state, .idle)
        XCTAssertFalse(end.moves, "the focus stays in the systolic")
    }

    /// The engine answers health-core's word through the optional door.
    func testTheEngineAnswersHealthCoresWord_US02_AC12() throws {
        let engine = try HealthEngine()
        let word = { (s: String, d: String) in try engine.blocking { try $0.bpSysAdvance(systolic: s, diastolic: d) } }
        XCTAssertEqual(try word("120", ""), .advance)
        XCTAssertEqual(try word("75", ""), .`defer`)
        XCTAssertEqual(try word("12", ""), .stay)
        XCTAssertEqual(try word("120", "80"), .stay, "a typed diastolic is never jumped into")
    }
}
