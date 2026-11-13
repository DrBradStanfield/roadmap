import XCTest
@testable import HealthRoadmap

/// Lead S67 (US-25 AC16f): "an erase held with no drawing" is one named state on the store,
/// `RecordStore.heldUndrawn`, read by both `redraw` and `applyInTurn`. It holds only when nothing
/// is drawn, there is no problem to show, a record is stored, and no later erase replaced it.
final class HeldUndrawnTableTests: XCTestCase {
    func testHeldOnlyWhenUndrawnWithoutProblemWithRecordAndNotPredatingAnErase() {
        for drawn in [false, true] {
            for problem in [false, true] {
                for json in ["", "{}"] {
                    for predatesErase in [false, true] {
                        let expected = !drawn && !problem && !json.isEmpty && !predatesErase
                        XCTAssertEqual(
                            RecordStore.heldUndrawn(drawn: drawn, problem: problem, recordJSON: json, predatesErase: predatesErase),
                            expected,
                            "drawn \(drawn), problem \(problem), json \(json.isEmpty ? "empty" : "set"), predatesErase \(predatesErase)"
                        )
                    }
                }
            }
        }
    }

    /// The one row that is held, spelled out, so a loop mistake cannot hide it.
    func testTheHeldRow() {
        XCTAssertTrue(RecordStore.heldUndrawn(drawn: false, problem: false, recordJSON: "{}", predatesErase: false))
        XCTAssertFalse(RecordStore.heldUndrawn(drawn: false, problem: false, recordJSON: "", predatesErase: false))
    }
}
