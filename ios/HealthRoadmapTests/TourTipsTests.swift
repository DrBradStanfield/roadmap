import XCTest
@testable import HealthRoadmap

/// US-57: the tour after onboarding. Three tips in order, each shown once; closing one
/// moves on, "Skip tour" ends it, and it never restarts. The tour is one state
/// (`TourState`), changed only by its pure `transition`; a due tip shows when its anchor is
/// on screen with the list at rest, never on a timer (AC2). TipKit, which keeps the step, is
/// not configured under unit tests (AC10).
final class TourTipsTests: XCTestCase {
    private typealias Row = (event: String, state: TourState, effects: [TourState.Effect])

    private static let events: [(String, TourState.Event)] = [
        ("started", .started),
        ("ended", .ended),
        ("looked 2 on", .looked(.foundation, onScreen: true)),
        ("looked 2 off", .looked(.foundation, onScreen: false)),
        ("noAnchor 2", .noAnchor(.foundation)),
        ("closed 2", .closed(.foundation)),
        ("closed 3", .closed(.bloodTests)),
        ("acted 3", .acted(.bloodTests)),
        ("skipped 2", .skipped(.foundation)),
        ("skipped 3", .skipped(.bloodTests)),
        ("gone 2", .gone(.foundation)),
        ("gone 3", .gone(.bloodTests)),
    ]

    private static func unchanged(_ state: TourState, except rows: [String: (TourState, [TourState.Effect])]) -> [Row] {
        events.map { name, _ in rows[name].map { (name, $0.0, $0.1) } ?? (name, state, []) }
    }

    private static let table: [(TourState, [Row])] = [
        (.notStarted, unchanged(.notStarted, except: ["started": (.waiting(.snapshot), [])])),
        (.waiting(.foundation), unchanged(.waiting(.foundation), except: [
            "ended": (.finished, []),
            // At rest with the card on screen: the tip shows.
            "looked 2 on": (.showing(.foundation), []),
            // At rest with the card off screen: bring it in, and show the tip once it arrives.
            "looked 2 off": (.bringing(.foundation), [.bringIntoView(.foundation)]),
            // No Weight & diabetes card: the step passes, with its closed event (review R4).
            "noAnchor 2": (.waiting(.bloodTests), [.logged(.foundation, skipped: false)]),
        ])),
        (.bringing(.foundation), unchanged(.bringing(.foundation), except: [
            "ended": (.finished, []),
            // Arrived: the tip shows.
            "looked 2 on": (.showing(.foundation), []),
            // Came to rest elsewhere (the person's or iOS's scroll): scroll again.
            "looked 2 off": (.bringing(.foundation), [.bringIntoView(.foundation)]),
            "noAnchor 2": (.waiting(.bloodTests), [.logged(.foundation, skipped: false)]),
        ])),
        (.showing(.foundation), unchanged(.showing(.foundation), except: [
            "ended": (.finished, []),
            // Next or a tap outside: tip 3 waits for this popover to go.
            "closed 2": (.leaving(.foundation, then: .nextTip), [.logged(.foundation, skipped: false)]),
            "skipped 2": (.finished, [.logged(.foundation, skipped: true), .tourEnded]),
            // Gone without a close (the system took it): counted as closed, the tour moves on.
            "gone 2": (.waiting(.bloodTests), [.logged(.foundation, skipped: false)]),
        ])),
        (.showing(.bloodTests), unchanged(.showing(.bloodTests), except: [
            "ended": (.finished, []),
            // Done ends the tour and opens nothing.
            "closed 3": (.finished, [.logged(.bloodTests, skipped: false), .tourEnded]),
            // "Add a lab report": the upload opens once the popover has gone.
            "acted 3": (.leaving(.bloodTests, then: .labUpload), [.logged(.bloodTests, skipped: false)]),
            "skipped 3": (.finished, [.logged(.bloodTests, skipped: true), .tourEnded]),
            "gone 3": (.finished, [.logged(.bloodTests, skipped: false), .tourEnded]),
        ])),
        (.leaving(.foundation, then: .nextTip), unchanged(.leaving(.foundation, then: .nextTip), except: [
            "ended": (.finished, []),
            // A late dismissal ("closed 2") changes nothing; once gone, tip 3 is due.
            "gone 2": (.waiting(.bloodTests), []),
        ])),
        (.leaving(.bloodTests, then: .labUpload), unchanged(.leaving(.bloodTests, then: .labUpload), except: [
            "ended": (.finished, []),
            "gone 3": (.finished, [.openLabUpload, .tourEnded]),
        ])),
        (.finished, unchanged(.finished, except: [:])),
    ]

    func testEveryStateAndEvent_US57_AC2() {
        var rows = 0
        for (state, expected) in Self.table {
            for (row, (name, event)) in zip(expected, Self.events) {
                let (next, effects) = TourState.transition(state, event)
                XCTAssertEqual(next, row.state, "\(state) x \(name)")
                XCTAssertEqual(effects, row.effects, "\(state) x \(name): effects")
                rows += 1
            }
        }
        XCTAssertEqual(rows, 96)
    }

    /// The whole walk, from onboarding's end to Done: each tip's close event once, then the tour's end.
    func testTheThreeTipsInOrder_AC2() {
        var state = TourState.notStarted
        let walk: [TourState.Event] = [.started, .looked(.snapshot, onScreen: true), .closed(.snapshot), .gone(.snapshot),
                                       .looked(.foundation, onScreen: true), .closed(.foundation), .gone(.foundation),
                                       .looked(.bloodTests, onScreen: true), .closed(.bloodTests)]
        var seen: [TourState.Effect] = []
        for event in walk {
            let (next, effects) = TourState.transition(state, event)
            state = next
            seen += effects
        }
        XCTAssertEqual(state, .finished)
        XCTAssertEqual(seen, [.logged(.snapshot, skipped: false), .logged(.foundation, skipped: false), .logged(.bloodTests, skipped: false), .tourEnded])
    }

    /// AC1: the step kept across launches. A closed tip is kept as passed even while its
    /// popover goes, so it never shows again; a kept step resumes as due.
    func testTheKeptStepAndWhatItResumesAs_AC1() {
        XCTAssertEqual(TourState.notStarted.step, .notStarted)
        XCTAssertEqual(TourState.waiting(.foundation).step, .foundation)
        XCTAssertEqual(TourState.showing(.foundation).step, .foundation)
        XCTAssertEqual(TourState.leaving(.foundation, then: .nextTip).step, .bloodTests)
        XCTAssertEqual(TourState.leaving(.bloodTests, then: .labUpload).step, .done)
        XCTAssertEqual(TourState.finished.step, .done)
        XCTAssertEqual(TourStep.allCases.map(TourState.init), [.notStarted, .waiting(.snapshot), .waiting(.foundation), .waiting(.bloodTests), .finished])
        XCTAssertEqual(TourStep.allCases.map(\.rawValue), [0, 1, 2, 3, 4], "the kept raw values never move")
        XCTAssertEqual([TourState.notStarted, .waiting(.snapshot), .showing(.snapshot), .leaving(.snapshot, then: .nextTip), .finished].map(\.isRunning),
                       [false, true, true, true, false], "the rating prompt waits while a tip is due, up or going (AC8)")
    }

    // MARK: What the list shows

    private static let screen = CGRect(x: 0, y: 62, width: 402, height: 700)
    private static let targets: [TourStep: TourTarget] = [.snapshot: TourTarget(id: "first", atTop: false), .foundation: TourTarget(id: "card", atTop: false),
                                                           .bloodTests: TourTarget(id: "blood", atTop: true)]

    func testATipLooksOnlyWhenTheListIsOnScreenAndAtRest_AC2() {
        var sight = TourSight(shown: false, bounds: Self.screen, anchors: [.bloodTests: CGRect(x: 20, y: 80, width: 362, height: 44)], targets: Self.targets)
        XCTAssertNil(sight.look(.bloodTests, bringing: false, rested: false), "another tab, a pushed page or a sheet: nothing yet")
        sight.shown = true
        XCTAssertEqual(sight.look(.bloodTests, bringing: false, rested: false), .looked(.bloodTests, onScreen: true))
        sight.coverUp = true
        XCTAssertNil(sight.look(.bloodTests, bringing: false, rested: false), "the first-run cover still going: nothing yet")
        sight.coverUp = false
        sight.moving = true
        XCTAssertNil(sight.look(.bloodTests, bringing: false, rested: false), "moving: wait for rest")
        sight.moving = false
        sight.anchors[.bloodTests] = nil
        XCTAssertEqual(sight.look(.bloodTests, bringing: false, rested: false), .looked(.bloodTests, onScreen: false), "its row not drawn: scroll to it")
        sight.targets[.foundation] = nil
        XCTAssertEqual(sight.look(.foundation, bringing: false, rested: false), .noAnchor(.foundation), "no card for this record: the step passes (review R4)")
    }

    func testOnScreenMeansEnoughOfTheAnchorToPointAt_AC2() {
        var sight = TourSight(shown: true, bounds: Self.screen, targets: Self.targets)
        let at = { (y: CGFloat, height: CGFloat) -> Bool in
            sight.anchors[.foundation] = CGRect(x: 20, y: y, width: 362, height: height)
            return sight.onScreen(.foundation)
        }
        XCTAssertTrue(at(300, 120), "wholly in view")
        XCTAssertFalse(at(40, 44), "partly under the status bar")
        XCTAssertFalse(at(740, 120), "cut off by the tab bar")
        XCTAssertFalse(at(900, 120), "below the screen")
        XCTAssertTrue(at(20, 1200), "a card taller than the screen at the largest text size: 44 points show")
    }


    /// A scroll the app starts is not reported by the scroll phase: its end is read from where the
    /// anchor sits (top or middle, as the scroll puts it) or the list's limit, never a clock.
    func testTheToursScrollEndsWhereItPutsTheAnchor_AC12() {
        var sight = TourSight(shown: true, bounds: Self.screen, targets: Self.targets)
        sight.scroll = TourScroll(offset: 1000, range: -62...3800)
        sight.anchors[.bloodTests] = CGRect(x: 20, y: 400, width: 362, height: 60)
        XCTAssertNil(sight.look(.bloodTests, bringing: true, rested: false), "on screen but still on its way to the top")
        XCTAssertEqual(sight.look(.bloodTests, bringing: false, rested: false), .looked(.bloodTests, onScreen: true),
                       "already on screen when it fell due: no scroll needed")
        sight.anchors[.bloodTests] = CGRect(x: 20, y: 57, width: 362, height: 60)
        XCTAssertEqual(sight.look(.bloodTests, bringing: true, rested: false), .looked(.bloodTests, onScreen: true),
                       "at the top, 5 points into the list's section spacing, as measured: arrived")
        sight.anchors[.bloodTests] = CGRect(x: 20, y: 90, width: 362, height: 60)
        XCTAssertNil(sight.look(.bloodTests, bringing: true, rested: false), "28 points short: still on its way")
        sight.anchors[.bloodTests] = CGRect(x: 20, y: 500, width: 362, height: 60)
        sight.scroll?.offset = 3800
        XCTAssertEqual(sight.look(.bloodTests, bringing: true, rested: false), .looked(.bloodTests, onScreen: true),
                       "near the end of the list it can rise no further: arrived")
        sight.anchors[.snapshot] = CGRect(x: 20, y: 250, width: 362, height: 60)
        sight.scroll?.offset = -62
        XCTAssertTrue(sight.arrived(.snapshot), "the first row above the middle, the list at its top: arrived")
        sight.scroll?.offset = 10
        XCTAssertFalse(sight.arrived(.snapshot), "still moving down towards it")
        sight.anchors[.bloodTests] = CGRect(x: 20, y: 400, width: 362, height: 60)
        sight.scroll?.offset = 1000
        XCTAssertEqual(sight.look(.bloodTests, bringing: true, rested: true), .looked(.bloodTests, onScreen: false),
                       "the person's scroll stopped it short: scroll again")
    }

    // MARK: The guide, from what the list reports

    @MainActor
    private func makeGuide(at step: TourStep) -> (TourGuide, scrolls: () -> [String], kept: () -> [TourStep]) {
        var scrolls: [String] = []
        var kept: [TourStep] = []
        let guide = TourGuide(step: step) { kept.append($0) }
        guide.scroll = { scrolls.append($0.id) }
        guide.targets(Self.targets)
        guide.listBounds(Self.screen)
        return (guide, { scrolls }, { kept })
    }

    /// The failure this design replaces (docs/gotchas.md): the tap that closed tip 2 also
    /// scrolled the list to the top. Tip 3 waits for rest, scrolls its heading back, and shows.
    @MainActor
    func testTheListMovingAwayNeverLosesTheDueTip_AC2() {
        let (guide, scrolls, kept) = makeGuide(at: .bloodTests)
        let heading = CGRect(x: 20, y: 62, width: 362, height: 48)
        guide.listMoving(true)                      // iOS's scroll to the top, from the tap by the clock
        guide.listShown(true)
        XCTAssertEqual(scrolls(), [], "nothing while the list moves")
        guide.anchor(.bloodTests, at: nil)
        guide.listMoving(false)
        XCTAssertEqual(scrolls(), ["blood"], "at rest, the heading off screen: scroll it in")
        guide.listMoving(true)
        guide.anchor(.bloodTests, at: heading)
        XCTAssertEqual(guide.state, .bringing(.bloodTests), "never mid-scroll")
        guide.listMoving(false)
        XCTAssertEqual(guide.state, .showing(.bloodTests), "at rest with the heading on screen: tip 3 shows")
        XCTAssertEqual(kept(), [], "showing keeps the same step")
    }

    /// The person scrolls away while tip 3 is due: the list is brought back when it stops.
    @MainActor
    func testScrollingAwayWhileATipIsDueBringsItBack_AC2() {
        let (guide, scrolls, _) = makeGuide(at: .bloodTests)
        guide.anchor(.bloodTests, at: CGRect(x: 20, y: 300, width: 362, height: 48))
        guide.listMoving(true)
        guide.listShown(true)
        guide.anchor(.bloodTests, at: CGRect(x: 20, y: -400, width: 362, height: 48))
        guide.listMoving(false)
        XCTAssertEqual(scrolls(), ["blood"])
        XCTAssertEqual(guide.state, .bringing(.bloodTests))
        guide.anchor(.bloodTests, at: CGRect(x: 20, y: 62, width: 362, height: 48))
        XCTAssertEqual(guide.state, .showing(.bloodTests), "an anchor that comes on screen while at rest (no scroll animation) shows")
    }

    /// A sheet or another tab holds a due tip; it shows once the list is back.
    @MainActor
    func testADueTipWaitsForTheListToBeOnScreen_AC2() {
        let (guide, scrolls, _) = makeGuide(at: .snapshot)
        guide.anchor(.snapshot, at: CGRect(x: 20, y: 300, width: 362, height: 60))
        XCTAssertEqual(guide.state, .waiting(.snapshot))
        guide.listShown(true)
        XCTAssertEqual(guide.state, .showing(.snapshot))
        XCTAssertEqual(scrolls(), [], "already on screen: no scroll")
    }

    /// Next on tip 1: tip 2 waits for tip 1's popover to go, then for its card.
    @MainActor
    func testTheNextTipWaitsForThePopoverToGo_AC2() {
        let (guide, scrolls, kept) = makeGuide(at: .snapshot)
        guide.anchor(.snapshot, at: CGRect(x: 20, y: 300, width: 362, height: 60))
        guide.anchor(.foundation, at: CGRect(x: 20, y: 400, width: 362, height: 200))
        guide.listShown(true)
        guide.send(.closed(.snapshot))
        XCTAssertEqual(guide.state, .leaving(.snapshot, then: .nextTip), "tip 1's popover is still going")
        XCTAssertEqual(kept(), [.foundation], "tip 1 is kept as passed at once")
        guide.send(.gone(.snapshot))
        XCTAssertEqual(guide.state, .showing(.foundation), "the card on screen at rest: tip 2 shows")
        XCTAssertEqual(scrolls(), [])
    }

    /// No Weight & diabetes card: tip 2 passes as closed and tip 3 is due (review R4).
    @MainActor
    func testAStepWithNoAnchorPassesOnceDue_R4() {
        let (guide, _, kept) = makeGuide(at: .foundation)
        var targets = Self.targets
        targets[.foundation] = nil
        guide.targets(targets)
        XCTAssertEqual(guide.state, .waiting(.foundation), "not before the list is on screen")
        guide.listShown(true)
        XCTAssertEqual(guide.state, .bringing(.bloodTests), "tip 3 is due, its heading being brought in")
        XCTAssertEqual(kept(), [.bloodTests])
    }

    /// AC3, AC7: Skip ends the tour from any tip; tip 3's action opens the upload once its popover has gone.
    @MainActor
    func testSkipEndsTheTourAndTheUploadOpensAfterThePopover_AC3_AC7() {
        for step in [TourStep.snapshot, .foundation, .bloodTests] {
            let (guide, _, kept) = makeGuide(at: step)
            var ended = 0
            guide.ended = { ended += 1 }
            guide.anchor(step, at: CGRect(x: 20, y: 300, width: 362, height: 60))
            guide.listShown(true)
            XCTAssertEqual(guide.state, .showing(step))
            guide.send(.skipped(step))
            XCTAssertEqual(guide.state, .finished, "tip \(step.rawValue)")
            XCTAssertEqual(kept(), [.done])
            XCTAssertEqual(ended, 1, "the cloud prompt is offered")
            XCTAssertFalse(guide.start(), "a skipped tour never restarts")
        }
        let (guide, _, _) = makeGuide(at: .bloodTests)
        var opened = 0
        guide.openLabUpload = { opened += 1 }
        guide.anchor(.bloodTests, at: CGRect(x: 20, y: 62, width: 362, height: 48))
        guide.listShown(true)
        guide.send(.acted(.bloodTests))
        XCTAssertEqual(opened, 0, "not over the popover")
        guide.send(.gone(.bloodTests))
        XCTAssertEqual(opened, 1)
        XCTAssertEqual(guide.state, .finished)
    }

    /// Onboarding ends over a list already drawn: what it reported before the start counts, so
    /// tip 1 shows at once (a guide that dropped frames before the start left it waiting for good).
    @MainActor
    func testTheFirstTipShowsOverTheListDrawnBeforeTheStart_AC1() {
        let (guide, scrolls, _) = makeGuide(at: .notStarted)
        guide.anchor(.snapshot, at: CGRect(x: 20, y: 300, width: 362, height: 60))
        guide.listShown(true)
        XCTAssertTrue(guide.start())
        XCTAssertEqual(guide.state, .showing(.snapshot))
        XCTAssertEqual(scrolls(), [])
    }

    @MainActor
    func testTheTourStartsOnlyOnceAndTheThirdSaveEndsIt_AC1_R2b() {
        let (guide, _, kept) = makeGuide(at: .notStarted)
        XCTAssertTrue(guide.start())
        XCTAssertFalse(guide.start(), "once only")
        guide.send(.ended)
        XCTAssertEqual(guide.state, .finished)
        XCTAssertEqual(kept(), [.snapshot, .done])
        let (unstarted, _, _) = makeGuide(at: .notStarted)
        unstarted.send(.ended)
        XCTAssertEqual(unstarted.state, .notStarted, "the third save never starts a tour that never ran")
    }

    // MARK: The tips

    /// Brad 2026-10-25: exactly three tips, one short line each, all on My health (US-73 AC11).
    func testThreeTipsOneShortLineEach_AC4_AC6_AC7() {
        XCTAssertEqual(TourStep.allCases.filter(\.isTip), [.snapshot, .foundation, .bloodTests])
        XCTAssertEqual([SnapshotTip.step, FoundationTip.step, BloodTestsTip.step], [.snapshot, .foundation, .bloodTests],
                       "each tip carries its own step")
        XCTAssertEqual(SnapshotTip.line, "Your numbers, grouped by topic. Tap any row for its history and what it means.")
        XCTAssertEqual(FoundationTip.line, "Each step comes with the reason and the evidence. Tap a card to read it.")
        XCTAssertEqual(BloodTestsTip.line, "The more data you add, the more personal your plan. You can upload lab reports to fill these in for you.")
        XCTAssertEqual(BloodTestsTip.actionTitle, "Add a lab report")
    }

    /// Brad 2026-10-25: every tip ends on one row, "Skip tour", "1/3", "Next"; the last
    /// tip's "Next" reads "Done". Tip 3 keeps its lab upload above the row (AC2, AC3, AC7).
    func testEveryTipHasSkipACounterAndNext_AC2_AC3() {
        XCTAssertNil(SnapshotTip.actionTitle, "tips 1 and 2: the row alone")
        XCTAssertNil(FoundationTip.actionTitle)
        XCTAssertEqual(BloodTestsTip.actionTitle, "Add a lab report", "tip 3's lab upload, above the row")
        XCTAssertEqual([SnapshotTip.counter, FoundationTip.counter, BloodTestsTip.counter], ["1/3", "2/3", "3/3"])
        XCTAssertEqual([SnapshotTip.spokenCounter, FoundationTip.spokenCounter, BloodTestsTip.spokenCounter],
                       ["Tip 1 of 3", "Tip 2 of 3", "Tip 3 of 3"], "what VoiceOver reads")
        XCTAssertEqual([SnapshotTip.nextTitle, FoundationTip.nextTitle, BloodTestsTip.nextTitle], ["Next", "Next", "Done"])
    }

    // MARK: Launch arguments (AC10)

    func testUnitTestsNeverConfigureTipKit() {
        XCTAssertEqual(TourSetup.mode(environment: ["XCTestConfigurationFilePath": "x"], arguments: []), .none)
        XCTAssertEqual(TourSetup.mode(environment: ["XCTestConfigurationFilePath": "x"], arguments: ["--ui-testing", "--show-tips"]), .none)
    }

    func testUITestsAndScreenshotsHideTheTips() {
        // Both UI suites and app-store-shots.sh launch with --ui-testing (AC10).
        XCTAssertEqual(TourSetup.mode(environment: [:], arguments: ["HealthRoadmap", Analytics.uiTestingArgument]), .hidden)
    }

    func testATourUITestCanTurnTheTipsOn() {
        XCTAssertEqual(TourSetup.mode(environment: [:], arguments: ["HealthRoadmap", "--ui-testing", TourSetup.showTipsArgument]), .fresh)
    }

    func testANormalLaunchShowsTips() {
        XCTAssertEqual(TourSetup.mode(environment: [:], arguments: ["HealthRoadmap"]), .normal)
        XCTAssertEqual(TourSetup.mode(environment: [:], arguments: ["HealthRoadmap", "--show-tips"]), .normal,
                       "--show-tips alone never resets a real person's tips")
    }
}
