import XCTest
@testable import HealthRoadmap

/// Lead S55 (US-25 AC16f, AC21): whether the record can be read or written is one named state,
/// `RecordStore.Hold`, read by `readable`, `applyInTurn`, the uploads and the charts. Its 16 rows,
/// written out. Folds in HeldUndrawnTableTests (lead S67): `.heldUndrawn` is its one held row.
/// The instance property on real stores: EraseHeldUndrawnTests, PredatesEraseReadersTests.
final class HoldTableTests: XCTestCase {
    func testEachRow_US25_AC16f_AC21() {
        // (drawn, problem, recordJSON empty, predatesErase) -> hold
        let rows: [(Bool, Bool, Bool, Bool, RecordStore.Hold)] = [
            (false, false, false, false, .heldUndrawn),
            (false, false, false, true, .predatesErase),
            (false, false, true, false, .empty),
            (false, false, true, true, .predatesErase),
            (false, true, false, false, .unreadable(kept: true)),
            (false, true, false, true, .predatesErase),
            (false, true, true, false, .unreadable(kept: false)),
            (false, true, true, true, .predatesErase),
            (true, false, false, false, .readable),
            (true, false, false, true, .predatesErase),
            // Cannot occur: every drawing is engine.screen of the stored record and screen("") throws
            // (ios/engine/my-data.ts readRecord), .unreadable clears both together, and init shows the
            // load at once. Before S55 an edit here was written; now it is refused, the safe side (owner ruling a).
            (true, false, true, false, .empty),
            (true, false, true, true, .predatesErase),
            (true, true, false, false, .unreadable(kept: true)),
            (true, true, false, true, .predatesErase),
            (true, true, true, false, .unreadable(kept: false)),
            (true, true, true, true, .predatesErase),
        ]
        for (drawn, problem, empty, predatesErase, hold) in rows {
            XCTAssertEqual(
                RecordStore.hold(drawn: drawn, problem: problem, recordJSONEmpty: empty, predatesErase: predatesErase), hold,
                "drawn \(drawn), problem \(problem), json \(empty ? "empty" : "set"), predatesErase \(predatesErase)"
            )
        }
    }

    /// Charts read a drawn, held or not-yet-loaded record; never an unreadable one or one an erase replaced.
    func testChartsAllowed_US25_AC21() {
        let rows: [(RecordStore.Hold, Bool)] = [
            (.readable, true), (.heldUndrawn, true), (.empty, true),
            (.unreadable(kept: true), false), (.unreadable(kept: false), false), (.predatesErase, false),
        ]
        for (hold, allowed) in rows { XCTAssertEqual(RecordStore.chartsAllowed(hold), allowed, "\(hold)") }
    }
}
