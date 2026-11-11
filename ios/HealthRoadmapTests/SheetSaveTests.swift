import SwiftUI
import XCTest
@testable import HealthRoadmap

/// US-25 AC21d (break-test 2026-11-06): a double tap on a sheet's save, or on a row of the
/// Add supplement sheet, saves once and finishes once. US-25 AC21e (iPhone survey S5,
/// 2026-11-11): a sheet's save is one state, changed only by `SheetSave.transition`.
@MainActor
final class SheetSaveTests: XCTestCase {
    private final class Box { var saving = false; var saves = 0; var finishes = 0 }
    private typealias State = SheetSave.State<[String]>
    private typealias Event = SheetSave.Event<[String]>

    func testASecondRunWhileSavingDoesNothing_US25_AC21d() async {
        let box = Box()
        let saving = Binding(get: { box.saving }, set: { box.saving = $0 })
        let done = expectation(description: "the first save finishes")
        let save: () async -> RecordStore.ApplyResult = {
            box.saves += 1
            try? await Task.sleep(for: .milliseconds(100))
            return .saved()
        }
        SheetSave.run(saving, save) { _ in box.finishes += 1; done.fulfill() }
        XCTAssertTrue(box.saving, "saving is set in the tap")
        SheetSave.run(saving, save) { _ in box.finishes += 1 }
        await fulfillment(of: [done], timeout: 5)
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(box.saves, 1, "the second tap wrote nothing")
        XCTAssertEqual(box.finishes, 1, "the sheet closes once")
        XCTAssertFalse(box.saving, "Cancel works again")
    }

    /// A refused run clears `saving` and hands the words on, as a saved one does.
    func testRunRoutesThroughTheTransition_US25_AC21e() async {
        let box = Box()
        let saving = Binding(get: { box.saving }, set: { box.saving = $0 })
        let done = expectation(description: "the refusal lands")
        var words: String?
        SheetSave.run(saving, { .refused(message: "Not today", existingId: "row-a") }) { result in
            if case .refused(let why, _) = result { words = why }
            done.fulfill()
        }
        XCTAssertTrue(box.saving)
        await fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(words, "Not today")
        XCTAssertFalse(box.saving, "a refusal frees the sheet")
    }

    // The events, every one the sheets send, with each kind of landing.
    private static let events: [(String, Event)] = [
        ("tapped", .tapped),
        ("landed saved", .landed(.saved(), asks: .findRows)),
        ("landed refused, no row", .landed(.refused(message: "Not today", existingId: nil), asks: .findRows)),
        ("landed refused, row, never asks", .landed(.refused(message: "Held", existingId: "row-a"), asks: .never)),
        ("landed refused, row, finds rows", .landed(.refused(message: "Held", existingId: "row-a"), asks: .findRows)),
        ("landed refused, row, holds it", .landed(.refused(message: "Held", existingId: "row-a"), asks: .holding { [$0] })),
        ("landed refused, empty row, holds it", .landed(.refused(message: "Held", existingId: ""), asks: .holding { $0.isEmpty ? [] : [$0] })),
        ("rowsFound rows", .rowsFound(["row-b"])),
        ("rowsFound empty", .rowsFound([])),
        ("rowsFound nil", .rowsFound(nil)),
        ("confirmed", .confirmed),
        ("declined", .declined),
        ("typed", .typed),
        ("unitChosen", .unitChosen),
        ("unitLanded refused", .unitLanded("Unit refused")),
        ("unitLanded taken", .unitLanded(nil)),
    ]

    /// Every state x every event: the state that follows. Unlisted pairs keep the state.
    func testEveryStateAndEvent_US25_AC21e() {
        let editing: State = .editing(message: "Old words")
        let table: [(State, [String: State])] = [
            (.editing(message: nil), ["tapped": .saving, "typed": .editing(message: nil), "unitChosen": .saving]),
            (editing, ["tapped": .saving, "typed": .editing(message: nil), "unitChosen": .saving]),
            (.saving, [
                "landed saved": .done,
                "landed refused, no row": .editing(message: "Not today"),
                "landed refused, row, never asks": .editing(message: "Held"),
                "landed refused, row, finds rows": .findingRows(words: "Held"),
                "landed refused, row, holds it": .asking(["row-a"]),
                "landed refused, empty row, holds it": .editing(message: "Held"),
                "unitLanded refused": .editing(message: "Unit refused"),
                "unitLanded taken": .editing(message: nil),
            ]),
            (.findingRows(words: "Held"), [
                "rowsFound rows": .asking(["row-b"]),
                "rowsFound empty": .editing(message: "Held"),
                "rowsFound nil": .editing(message: "Held"),
            ]),
            (.asking(["row-a"]), ["confirmed": .saving, "declined": .editing(message: nil)]),
            (.done, [:]),
        ]
        for (state, moves) in table {
            for (name, event) in Self.events {
                let next = SheetSave.transition(state, event)
                XCTAssertEqual(next, moves[name] ?? state, "\(state) + \(name)")
            }
        }
    }

    /// Bug 1: from the refusal to the replace question, Save stays held and a tap claims nothing.
    func testFindingRowsHoldsSaveUntilTheQuestion_US25_AC21e() {
        var state: State = .editing(message: nil)
        XCTAssertTrue(SheetSave.send(&state, .tapped))
        SheetSave.send(&state, .landed(.refused(message: "Held", existingId: "row-a"), asks: .findRows))
        XCTAssertEqual(state, .findingRows(words: "Held"))
        XCTAssertTrue(state.busy, "Save, Cancel and swipe-down wait while the rows are read")
        XCTAssertFalse(SheetSave.send(&state, .tapped), "a second Save starts nothing")
        SheetSave.send(&state, .rowsFound(["row-a", "row-b"]))
        XCTAssertEqual(state.held, ["row-a", "row-b"])
        XCTAssertFalse(state.busy)
    }

    /// Bug 2: rows that cannot be read never ask, so no replace names no rows.
    func testRowsThatCannotBeReadShowTheWords_US25_AC21e() {
        for found in [nil, []] as [[String]?] {
            let next = SheetSave.transition(State.findingRows(words: "Held"), .rowsFound(found))
            XCTAssertEqual(next, .editing(message: "Held"))
            XCTAssertEqual(next.message, "Held")
            XCTAssertNil(next.held)
        }
    }

    /// Bug 3: a Save during an Lp(a) unit choice does nothing.
    func testASaveDuringAUnitChoiceDoesNothing_US25_AC21e() {
        var state: State = .editing(message: nil)
        XCTAssertTrue(SheetSave.send(&state, .unitChosen))
        XCTAssertFalse(SheetSave.send(&state, .tapped), "Save waits for the unit")
        XCTAssertFalse(SheetSave.send(&state, .unitChosen), "a second choice waits too")
        SheetSave.send(&state, .unitLanded(nil))
        XCTAssertEqual(state, .editing(message: nil))
        XCTAssertTrue(SheetSave.send(&state, .tapped))
    }

    /// Bug 4: two fast "Taking again" taps start one apply.
    func testTwoFastTapsClaimOnce_US25_AC21e() {
        var state: SheetSave.State<SheetSave.NoHeld> = .editing(message: nil)
        XCTAssertTrue(SheetSave.send(&state, .tapped))
        XCTAssertFalse(SheetSave.send(&state, .tapped))
    }

    /// A closed sheet ignores every later event.
    func testDoneIsTerminal_US25_AC21e() {
        for (name, event) in Self.events {
            XCTAssertEqual(SheetSave.transition(State.done, event), .done, name)
        }
        var state: State = .done
        XCTAssertFalse(SheetSave.send(&state, .tapped))
        XCTAssertFalse(state.busy)
    }
}
