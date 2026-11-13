import XCTest
@testable import HealthRoadmap

/// US-54 AC5 (iPhone survey S6, PR b): the new-user flow is one named state, changed only
/// by `OnboardingFlow.transition`. Every mode x every event names the mode and effects that
/// follow; the bugs S6 found each have their cell.
@MainActor
final class OnboardingFlowTests: XCTestCase {
    private typealias Flow = OnboardingFlow
    private typealias Page = OnboardingFlow.Page
    private let row1 = Flow.Replace(id: "row-1", value: 80)
    private let row2 = Flow.Replace(id: "row-2", value: 80)

    private var events: [(String, Flow.Event)] {
        [
            ("began sex", .began(Page(step: .sex))),
            ("began nil", .began(nil)),
            ("allowTapped", .allowTapped),
            ("connected sex", .connected(next: .sex)),
            ("connected nil", .connected(next: nil)),
            ("tapped", .tapped),
            ("landed advance", .landed(.advance, next: .height)),
            ("landed advance, last", .landed(.advance, next: nil)),
            ("landed words", .landed(.words("No"), next: .height)),
            ("landed unwritten", .landed(.unwritten("That could not be saved."), next: .height)),
            ("landed restart", .landed(.restart("Moved"), next: .height)),
            ("replanned sex", .replanned(Page(step: .sex))),
            ("replanned nil", .replanned(nil)),
            ("landed ask", .landed(.askReplace(row1), next: .height)),
            ("confirmed row-1", .confirmed(row1)),
            ("confirmed row-2", .confirmed(row2)),
            ("declined", .declined),
            ("wordsStale", .wordsStale),
            ("moved birth", .moved(Page(step: .birth))),
            ("reviewAccepted", .reviewAccepted),
        ]
    }

    private func page(_ step: OnboardingStep, _ save: Flow.Save = .editing(message: nil), fromSummary: Bool = false) -> Flow.Mode {
        .page(Page(step: step, fromSummary: fromSummary), save)
    }

    /// Every mode x every event: the mode and effects that follow. Unlisted pairs keep the
    /// mode and run nothing.
    func testEveryModeAndEvent_US54_AC5() {
        let birth = (page(.birth), [Flow.Effect.repin])
        let table: [(Flow.Mode, [String: (Flow.Mode, [Flow.Effect])])] = [
            // begin()'s early finish (an unreadable record) finishes once and never pinned.
            (.starting, ["began sex": (page(.sex), [.pin]), "began nil": (.finished(nil), [.finish])]),
            // Bug D: a second Allow while Apple Health answers starts nothing. Finished holds the
            // last page, so the cover slides down with it drawn (review F1).
            (.connecting, ["connected sex": (page(.sex), [.repin]), "connected nil": (.finished(Page(step: .health)), [.unpin, .finish])]),
            (page(.health), ["allowTapped": (.connecting, [.connect]), "moved birth": birth]),
            (page(.sex), ["tapped": (page(.sex, .saving), [.save(.sex)]), "moved birth": birth]),
            (page(.weight, .editing(message: "Old")), [
                "tapped": (page(.weight, .saving), [.save(.weight)]),
                "wordsStale": (page(.weight), []),
                "moved birth": birth,
            ]),
            // Bug E: a second tap while saving saves nothing; Back waits too.
            (page(.weight, .saving), [
                "landed advance": (page(.height), [.repin]),
                "landed advance, last": (.finished(Page(step: .weight)), [.unpin, .finish]),
                "landed words": (page(.weight, .editing(message: "No")), [.repin]),
                // Bug C, and AC11g: the words show and the pin stays (review F2).
                "landed unwritten": (page(.weight, .editing(message: "That could not be saved.")), []),
                // Refused on a record that moved under the page: it waits, words kept, and plans again
                // from the record now shown (US-54 AC5d, owner's ruling (c) on PR 1570).
                "landed restart": (page(.weight, .findingRows(words: "Moved")), [.restart]),
                "landed ask": (page(.weight, .asking(row1)), []),
            ]),
            (page(.weight, .asking(row1)), [
                "confirmed row-1": (page(.weight, .saving), [.replace(row1)]),
                "declined": (page(.weight, .declined(row1)), []),
                "moved birth": birth,
            ]),
            // Bug B: "Replace it" after the dialog's dismissal landed first still replaces.
            (page(.weight, .declined(row1)), [
                "confirmed row-1": (page(.weight, .saving), [.replace(row1)]),
                "tapped": (page(.weight, .saving), [.save(.weight)]),
                "wordsStale": (page(.weight), []),
                "moved birth": birth,
            ]),
            // An answer opened from the summary returns to it, whatever comes next.
            (page(.height, .saving, fromSummary: true), [
                "landed advance": (page(.review), [.repin]),
                "landed advance, last": (page(.review), [.repin]),
                "landed words": (page(.height, .editing(message: "No"), fromSummary: true), [.repin]),
                "landed unwritten": (page(.height, .editing(message: "That could not be saved."), fromSummary: true), []),
                "landed restart": (page(.height, .findingRows(words: "Moved"), fromSummary: true), [.restart]),
                "landed ask": (page(.height, .asking(row1), fromSummary: true), []),
            ]),
            // Planning again: every tap, Back and late landing waits; the plan lands once, with the
            // words, on the page the record now asks for, or finishes when it cannot be read.
            (page(.weight, .findingRows(words: "Moved")), [
                "replanned sex": (page(.sex, .editing(message: "Moved")), []),
                "replanned nil": (.finished(Page(step: .weight)), [.unpin, .finish]),
            ]),
            (page(.review), ["reviewAccepted": (.finished(Page(step: .review)), [.unpin, .finish]), "moved birth": birth]),
            // Bugs D, E: a late connect or a second Continue never finishes again.
            (.finished(Page(step: .review)), [:]),
            (.finished(nil), [:]),
        ]
        for (mode, moves) in table {
            for (name, event) in events {
                let (next, effects) = Flow.transition(mode, event)
                let expected = moves[name] ?? (mode, [])
                XCTAssertEqual(next, expected.0, "\(mode) + \(name)")
                XCTAssertEqual(effects, expected.1, "\(mode) + \(name): effects")
            }
        }
    }

    /// Runs `events` from `mode`: where it ends and every effect it named.
    private func run(_ mode: Flow.Mode, _ events: [Flow.Event]) -> (Flow.Mode, [Flow.Effect]) {
        events.reduce((mode, [])) { sofar, event in
            let (next, effects) = Flow.transition(sofar.0, event)
            return (next, sofar.1 + effects)
        }
    }

    /// Bug D: a double tap on Allow starts one connect, and a connect that lands after the
    /// flow finished calls finish() no second time.
    func testADoubleTapOnAllowConnectsOnce_BugD() {
        let (mode, effects) = run(page(.health), [.allowTapped, .allowTapped, .connected(next: nil), .connected(next: nil)])
        XCTAssertEqual(mode, .finished(Page(step: .health)))
        XCTAssertEqual(effects, [.connect, .unpin, .finish])
    }

    /// Bug E: a double tap on Continue saves once; a double tap on the summary's Continue
    /// finishes once (RootView.finishOnboarding is not idempotent).
    func testADoubleTapSavesOnceAndFinishesOnce_BugE() {
        XCTAssertEqual(run(page(.height), [.tapped, .tapped]).1, [.save(.height)])
        XCTAssertEqual(run(page(.review), [.reviewAccepted, .reviewAccepted]).1, [.unpin, .finish])
    }

    /// Bug B: "Replace it" replaces once, whichever SwiftUI sends first, the button's action
    /// or the dialog's dismissal.
    func testReplaceItCountsInEitherDismissalOrder_BugB() {
        let asking = page(.weight, .asking(row1))
        XCTAssertEqual(run(asking, [.declined, .confirmed(row1)]).1, [.replace(row1)])
        XCTAssertEqual(run(asking, [.confirmed(row1), .declined]).1, [.replace(row1)])
        XCTAssertEqual(run(asking, [.confirmed(row1), .declined]).0, page(.weight, .saving))
        // A late "Replace it" after the person typed again is ignored (owner's ruling N1).
        XCTAssertEqual(run(asking, [.declined, .wordsStale, .confirmed(row1)]).1, [])
    }

    /// Bug C: an answer the page cannot write shows words on the page, never a silent unlock.
    /// Nothing reached the engine, so the screen's pin is not moved (US-25 AC11g, review F2).
    func testAnAnswerThatCannotBeWrittenSaysSo_BugC() {
        let landing = Flow.landing(.stay, step: .height)
        XCTAssertEqual(landing, .unwritten("That could not be saved."))
        let (mode, effects) = run(page(.height), [.tapped, .landed(landing, next: .weight)])
        XCTAssertEqual(mode, page(.height, .editing(message: "That could not be saved.")))
        XCTAssertEqual(mode.save?.message, "That could not be saved.")
        XCTAssertFalse(mode.save?.busy ?? true, "the page takes another try")
        XCTAssertEqual(effects, [.save(.height)], "no repin")
    }

    /// AC5: "Replace it" writes the weight the person typed, converted once when it was saved,
    /// for the row the refusal named; nothing is read again.
    func testReplaceWritesTheWeightTyped_AC5() {
        let refused = RecordStore.ApplyResult.refused(message: "Today already has a weight.", existingId: "row-9")
        let landing = Flow.landing(.applied(refused, typed: 81.5), step: .weight)
        let (mode, effects) = run(page(.weight), [.tapped, .landed(landing, next: nil)])
        guard let held = mode.save?.held else { return XCTFail("asks before replacing: \(mode)") }
        XCTAssertEqual(held, Flow.Replace(id: "row-9", value: 81.5))
        XCTAssertEqual(run(mode, [.confirmed(held)]).1, [.replace(held)])
        XCTAssertEqual(effects, [.save(.weight)], "no write before the person says so")
    }

    /// F1: the page drawn once finished is the last one, so the cover never slides down empty;
    /// an unreadable record, which drew none, draws none.
    func testFinishedKeepsTheLastPageDrawn_US54_AC5d() {
        let (done, _) = run(page(.weight, .saving), [.landed(.advance, next: nil)])
        XCTAssertEqual(done.step, .weight)
        XCTAssertNil(done.save, "nothing to save: the page's taps change nothing")
        XCTAssertFalse(done.pinned)
        XCTAssertEqual(run(page(.review), [.reviewAccepted]).0.step, .review)
        XCTAssertNil(run(.starting, [.began(nil)]).0.step)
    }

    /// US-54 AC5d: a restart runs once per refused tap and never loops: a second landing, a
    /// tap or Back while it plans changes nothing, and only the first plan lands.
    func testARestartRunsOnceAndLandsOnce_US54_AC5d() {
        let moved = Flow.Event.landed(.restart("Moved"), next: nil)
        let (mode, effects) = run(page(.height, .saving), [moved, moved, .tapped, .moved(Page(step: .sex)),
                                                           .replanned(Page(step: .birth)), .replanned(Page(step: .sex))])
        XCTAssertEqual(effects, [.restart])
        XCTAssertEqual(mode, page(.birth, .editing(message: "Moved")))
    }
}
