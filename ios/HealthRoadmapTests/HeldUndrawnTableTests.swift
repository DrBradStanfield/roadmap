import XCTest
@testable import HealthRoadmap

/// Lead S67 (US-25 AC16f): "a record held with no drawing" is one named state on the store,
/// `RecordStore.heldUndrawn`, read by both `redraw` and `applyInTurn`. Its 16 rows, written out:
/// only an undrawn, problem-free, stored record that predates no erase is held. The instance
/// property on real stores: EraseHeldUndrawnTests.erasedUndrawn.
final class HeldUndrawnTableTests: XCTestCase {
    func testEachRow_US25_AC16f() {
        // (drawn, problem, recordJSON, predatesErase, held)
        let rows: [(Bool, Bool, String, Bool, Bool)] = [
            (false, false, "{}", false, true),
            (false, false, "{}", true, false),
            (false, false, "", false, false),
            (false, false, "", true, false),
            (false, true, "{}", false, false),
            (false, true, "{}", true, false),
            (false, true, "", false, false),
            (false, true, "", true, false),
            (true, false, "{}", false, false),
            (true, false, "{}", true, false),
            (true, false, "", false, false),
            (true, false, "", true, false),
            (true, true, "{}", false, false),
            (true, true, "{}", true, false),
            (true, true, "", false, false),
            (true, true, "", true, false),
        ]
        for (drawn, problem, json, predatesErase, held) in rows {
            XCTAssertEqual(
                RecordStore.heldUndrawn(drawn: drawn, problem: problem, recordJSON: json, predatesErase: predatesErase), held,
                "drawn \(drawn), problem \(problem), json \(json.isEmpty ? "empty" : "set"), predatesErase \(predatesErase)"
            )
        }
    }
}
