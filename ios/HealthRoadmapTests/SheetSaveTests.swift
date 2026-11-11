import SwiftUI
import XCTest
@testable import HealthRoadmap

/// US-25 AC21d (break-test 2026-11-06): a double tap on a sheet's save, or on a row of the
/// Add supplement sheet, saves once and finishes once. US-25 AC21e (iPhone survey S5,
/// 2026-11-11): a sheet's save is one state, changed only by `SheetSave.transition`.
@MainActor
final class SheetSaveTests: XCTestCase {
    private typealias State = SheetSave.State<[String]>
    private typealias Event = SheetSave.Event<[String]>

    /// A second tap on a sheet's save while the first is landing claims nothing, and the
    /// save closes the sheet once, never leaving Cancel disabled. Every sheet saves this way.
    func testASecondTapWhileSavingDoesNothing_US25_AC21d() {
        var state: SheetSave.State<SheetSave.NoHeld> = .editing(message: nil)
        XCTAssertTrue(SheetSave.send(&state, .tapped), "the first tap starts the save")
        XCTAssertTrue(state.busy, "Save, Cancel and swipe-down wait")
        XCTAssertFalse(SheetSave.send(&state, .tapped), "the second tap writes nothing")
        SheetSave.send(&state, .landed(.saved(), closes: true, asks: .never))
        XCTAssertEqual(state, .done, "the sheet closes once")
        XCTAssertFalse(state.busy, "Cancel works again")
    }

    /// The no-question sheets' door: a second submit while the first save is landing makes
    /// no second save call, and the result lands once (the sheet closes once).
    func testASecondSubmitWhileSavingSavesOnce_US25_AC21d() async {
        final class Box { var state: SheetSave.State<SheetSave.NoHeld> = .editing(message: nil); var saves = 0; var closes = 0 }
        let box = Box()
        let state = Binding(get: { box.state }, set: { box.state = $0 })
        let closed = expectation(description: "the sheet closes")
        let save: () async -> RecordStore.ApplyResult = {
            box.saves += 1
            try? await Task.sleep(for: .milliseconds(100))
            return .saved()
        }
        SheetSave.submit(state, dismiss: { box.closes += 1; closed.fulfill() }, save)
        XCTAssertTrue(box.state.busy, "the tap claims the save at once")
        SheetSave.submit(state, dismiss: { box.closes += 1 }, save)
        await fulfillment(of: [closed], timeout: 5)
        try? await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(box.saves, 1, "the second tap wrote nothing")
        XCTAssertEqual(box.closes, 1, "the sheet closes once")
        XCTAssertEqual(box.state, .done)
    }

    // The events, every one the sheets send, with each kind of landing.
    private static let events: [(String, Event)] = [
        ("tapped", .tapped),
        ("landed saved", .landed(.saved(), closes: true, asks: .findRows)),
        ("landed saved, stays open", .landed(.saved(), closes: false, asks: .never)),
        ("landed refused, stays open", .landed(.refused(message: "Not today", existingId: nil), closes: false, asks: .never)),
        ("landed refused, no row", .landed(.refused(message: "Not today", existingId: nil), closes: true, asks: .findRows)),
        ("landed refused, row, never asks", .landed(.refused(message: "Held", existingId: "row-a"), closes: true, asks: .never)),
        ("landed refused, row, finds rows", .landed(.refused(message: "Held", existingId: "row-a"), closes: true, asks: .findRows)),
        ("landed refused, row, holds it", .landed(.refused(message: "Held", existingId: "row-a"), closes: true, asks: .holding { [$0] })),
        ("landed refused, empty row, holds it", .landed(.refused(message: "Held", existingId: ""), closes: true, asks: .holding { $0.isEmpty ? [] : [$0] })),
        ("rowsFound rows", .rowsFound(["row-b"])),
        ("rowsFound empty", .rowsFound([])),
        ("rowsFound nil", .rowsFound(nil)),
        ("confirmed row-a", .confirmed(["row-a"])),
        ("confirmed row-b", .confirmed(["row-b"])),
        ("declined", .declined),
        ("wordsStale", .wordsStale),
        ("unitChosen", .unitChosen),
        ("unitLanded refused", .unitLanded("Unit refused")),
        ("unitLanded taken", .unitLanded(nil)),
    ]

    /// Every state x every event: the state that follows. Unlisted pairs keep the state.
    func testEveryStateAndEvent_US25_AC21e() {
        let editing: State = .editing(message: "Old words")
        let table: [(State, [String: State])] = [
            // A "Replace it" with no question open is ignored (owner's ruling N1).
            (.editing(message: nil), ["tapped": .saving, "wordsStale": .editing(message: nil), "unitChosen": .saving]),
            (editing, ["tapped": .saving, "wordsStale": .editing(message: nil), "unitChosen": .saving]),
            (.saving, [
                "landed saved": .done,
                "landed saved, stays open": .editing(message: nil),
                "landed refused, stays open": .editing(message: "Not today"),
                "landed refused, no row": .editing(message: "Not today"),
                "landed refused, row, never asks": .editing(message: "Held"),
                "landed refused, row, finds rows": .findingRows(words: "Held"),
                "landed refused, row, holds it": .asking(["row-a"]),
                "landed refused, empty row, holds it": .editing(message: "Held"),
                "unitLanded refused": .editing(message: "Unit refused"),
                "unitLanded taken": .editing(message: nil),
                "declined": .saving, // a dialog's late dismissal after "Replace it"
            ]),
            (.findingRows(words: "Held"), [
                "rowsFound rows": .asking(["row-b"]),
                "rowsFound empty": .editing(message: "Held"),
                "rowsFound nil": .editing(message: "Held"),
            ]),
            // "Replace it" counts only for the rows its dialog asked about.
            (.asking(["row-a"]), ["confirmed row-a": .saving, "declined": .declined(["row-a"])]),
            // Dismissed: the person sees editing; a late "Replace it" for the same rows still
            // replaces, and any edit or a new Save forgets the question.
            (.declined(["row-a"]), [
                "tapped": .saving,
                "wordsStale": .editing(message: nil),
                "unitChosen": .saving,
                "confirmed row-a": .saving,
            ]),
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
        SheetSave.send(&state, .landed(.refused(message: "Held", existingId: "row-a"), closes: true, asks: .findRows))
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

    /// Bug 4: two fast "Taking again" taps start one apply; its save leaves the section
    /// open, so the next tap starts a new one.
    func testTwoFastTapsClaimOnce_US25_AC21e() {
        var state: SheetSave.State<SheetSave.NoHeld> = .editing(message: nil)
        XCTAssertTrue(SheetSave.send(&state, .tapped))
        XCTAssertFalse(SheetSave.send(&state, .tapped))
        SheetSave.send(&state, .landed(.saved(), closes: false, asks: .never))
        XCTAssertEqual(state, .editing(message: nil))
        XCTAssertTrue(SheetSave.send(&state, .tapped))
    }

    /// "Replace it" then the dialog's late dismissal: the replace goes ahead.
    func testALateDeclineAfterReplaceIsIgnored_US25_AC21e() {
        var state: State = .asking(["row-a"])
        XCTAssertTrue(SheetSave.send(&state, .confirmed(["row-a"])))
        SheetSave.send(&state, .declined)
        XCTAssertEqual(state, .saving)
    }

    /// The dialog's dismissal first, then "Replace it": the tap still claims the replace,
    /// and the rows it sends are the ones its dialog showed (they ride on the event).
    func testADeclineBeforeReplaceStillReplaces_US25_AC21e() {
        var state: State = .asking(["row-a"])
        SheetSave.send(&state, .declined)
        XCTAssertEqual(state, .declined(["row-a"]))
        XCTAssertFalse(state.busy, "Save is live again")
        XCTAssertNil(state.message, "no words show")
        XCTAssertNil(state.held, "the dialog does not show again")
        let shown: [String] = ["row-a"]
        XCTAssertTrue(SheetSave.send(&state, .confirmed(shown)), "the replace starts")
        XCTAssertEqual(state, .saving)
        XCTAssertFalse(SheetSave.send(&state, .confirmed(shown)), "a second press starts nothing")
    }

    /// The owner's ruling N1: a "Replace it" that lands after the person dismissed the
    /// question and then changed the value or the unit is ignored, so the write is what
    /// they chose. Only the new unit's save is claimed.
    func testALateReplaceAfterAChangeIsIgnored_US25_AC21e() {
        let shown: [String] = ["row-a"]
        var (state, claims) = outcome([.declined, .unitChosen, .unitLanded(nil), .confirmed(shown)])
        XCTAssertEqual(state, .editing(message: nil), "declined, unit changed, late confirmed")
        XCTAssertEqual(claims, ["unitChosen"], "the unit's save only, never the replace")

        (state, claims) = outcome([.declined, .wordsStale, .confirmed(shown)])
        XCTAssertEqual(state, .editing(message: nil), "declined, typed, late confirmed")
        XCTAssertEqual(claims, [], "no save")

        // A Day picker change sends wordsStale, as typing does.
        (state, claims) = outcome([.declined, .wordsStale, .confirmed(shown)])
        XCTAssertEqual(state, .editing(message: nil), "declined, day changed, late confirmed")
        XCTAssertEqual(claims, [], "no save")

        (state, claims) = outcome([.declined, .confirmed(["row-b"])])
        XCTAssertEqual(state, .declined(shown), "a replace for other rows")
        XCTAssertEqual(claims, [], "no save")
    }

    /// Starts at the question about row-a and sends `events` in order. `transition` is pure,
    /// so the outcome depends only on which events come between, not on which turn each
    /// lands in. `claims`: the events whose `send` started a save.
    private func outcome(_ events: [Event]) -> (State, claims: [String]) {
        var state: State = .asking(["row-a"])
        var claims: [String] = []
        for event in events {
            guard SheetSave.send(&state, event) else { continue }
            switch event {
            case .confirmed(let held): claims.append("confirmed \(held)")
            case .unitChosen: claims.append("unitChosen")
            default: claims.append("other")
            }
        }
        return (state, claims)
    }

    /// "Replace it" and the dialog's dismissal, in either order SwiftUI runs them, end in
    /// the one outcome the person chose; a replace is sent once, with the rows it was shown.
    func testReplaceAndDismissalInEitherOrderEndAsChosen_US25_AC21e() {
        let shown: [String] = ["row-a"]
        var (state, claims) = outcome([.confirmed(shown), .declined])
        XCTAssertEqual(state, .saving, "confirmed then declined")
        XCTAssertEqual(claims, ["confirmed [\"row-a\"]"], "the replace is sent once")

        (state, claims) = outcome([.declined, .confirmed(shown)])
        XCTAssertEqual(state, .saving, "declined then confirmed, via declined(row-a)")
        XCTAssertEqual(claims, ["confirmed [\"row-a\"]"], "sent once, with the rows the dialog showed")

        (state, claims) = outcome([.declined])
        XCTAssertEqual(state, .declined(shown), "declined alone")
        XCTAssertEqual(claims, [], "no save")
    }

    /// Each view's choice of landing (R3): a flip of any one fails here.
    func testEachViewsLandingChoice_US25_AC21e() {
        let named = RecordStore.ApplyResult.refused(message: "Held", existingId: "row-a")
        func bp(replace: Bool, _ result: RecordStore.ApplyResult) -> State {
            SheetSave.transition(.saving, .landed(result, closes: BloodPressureSheet.closes, asks: BloodPressureSheet.asks(replace: replace)))
        }
        XCTAssertEqual(bp(replace: false, named), .findingRows(words: "Held"), "a first save asks after reading the rows")
        XCTAssertEqual(bp(replace: true, named), .editing(message: "Held"), "a refused replace never asks again")
        XCTAssertEqual(bp(replace: false, .saved()), .done, "a save closes the sheet")

        typealias Value = SheetSave.State<ValueEntrySheet.Held>
        func value(canReplace: Bool, _ result: RecordStore.ApplyResult) -> Value {
            SheetSave.transition(.saving, .landed(result, closes: ValueEntrySheet.closes, asks: ValueEntrySheet.asks(canReplace: canReplace, number: 4.5)))
        }
        XCTAssertEqual(value(canReplace: true, named), .asking(ValueEntrySheet.Held(id: "row-a", value: 4.5)))
        XCTAssertEqual(value(canReplace: false, named), .editing(message: "Held"))
        XCTAssertEqual(value(canReplace: true, .saved()), .done)

        let taken = SheetSave.transition(SheetSave.State<SheetSave.NoHeld>.saving, .landed(.saved(), closes: SupplementsSection.closes, asks: .never))
        XCTAssertEqual(taken, .editing(message: nil), "the section stays open for the next Taking again")
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
