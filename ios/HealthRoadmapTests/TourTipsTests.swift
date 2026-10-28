import XCTest
@testable import HealthRoadmap

/// US-57: the tour after onboarding. Three tips in order, each shown once; closing one
/// moves on, "Skip tour" ends it, and it never restarts. TipKit itself is not configured
/// under unit tests (AC10), so these test the pure order and the launch arguments.
final class TourTipsTests: XCTestCase {
    func testTheTourStartsAtTheSnapshotOnlyOnce() {
        XCTAssertEqual(TourStep.notStarted.started(), .snapshot)
        for step in [TourStep.snapshot, .foundation, .bloodTests, .done] {
            XCTAssertEqual(step.started(), step, "a started or finished tour never restarts (AC1)")
        }
    }

    func testClosingEachTipShowsTheNextThenEnds() {
        var step = TourStep.notStarted.started()
        step = step.closing(.snapshot)
        XCTAssertEqual(step, .foundation)
        step = step.closing(.foundation)
        XCTAssertEqual(step, .bloodTests)
        step = step.closing(.bloodTests)
        XCTAssertEqual(step, .done, "the last tip ends the tour (AC2)")
    }

    func testClosingATipThatIsNotShowingChangesNothing() {
        // A late status update from an earlier tip must not skip the one now due.
        XCTAssertEqual(TourStep.foundation.closing(.snapshot), .foundation)
        XCTAssertEqual(TourStep.done.closing(.bloodTests), .done)
        XCTAssertEqual(TourStep.notStarted.closing(.snapshot), .notStarted, "no tip shows before onboarding ends")
    }

    func testSkipEndsTheTourFromAnyTip() {
        for step in [TourStep.snapshot, .foundation, .bloodTests] {
            XCTAssertEqual(step.ended(), .done, "AC3")
            XCTAssertEqual(step.ended().started(), .done, "a skipped tour never comes back")
        }
    }

    /// Review R2(b): the third save ends a tour still running; it never starts one that
    /// never ran (a phone onboarded before the tour).
    func testEndingLeavesAnUnstartedTourAlone() {
        XCTAssertEqual(TourStep.notStarted.ended(), .notStarted)
        XCTAssertEqual(TourStep.done.ended(), .done)
    }

    func testEachTipShowsAtItsOwnStepOnly() {
        // The tips' rules compare Tour.step to these raw values; the order must hold.
        XCTAssertEqual(TourStep.allCases.map(\.rawValue), [0, 1, 2, 3, 4])
    }

    /// Brad 2026-10-25: exactly three tips, one short line each.
    func testThreeTipsOneShortLineEach_AC4_AC6_AC7() {
        XCTAssertEqual(TourStep.allCases.filter(\.isTip), [.snapshot, .foundation, .bloodTests])
        XCTAssertEqual([SnapshotTip.step, FoundationTip.step, BloodTestsTip.step], [.snapshot, .foundation, .bloodTests],
                       "each tip carries its own step")
        XCTAssertEqual([SnapshotTip.tab, FoundationTip.tab, BloodTestsTip.tab], [.plan, .plan, .data],
                       "and its own tab: a hidden tab's tip never shows over another")
        XCTAssertEqual(SnapshotTip.line, "A snapshot of your health. Tap any tile to learn more.")
        XCTAssertEqual(FoundationTip.line, "Start here. Each step comes with the reason and the evidence.")
        XCTAssertEqual(BloodTestsTip.line, "The more data you add, the more personal your plan. You can upload lab reports to fill these in for you.")
        XCTAssertNil(SnapshotTip().message, "one line: the title alone")
        XCTAssertNil(FoundationTip().message)
        XCTAssertNil(BloodTestsTip().message)
        XCTAssertEqual(BloodTestsTip.actionTitle, "Add a lab report")
    }

    /// Brad 2026-10-25: every tip ends on one row, "Skip tour", "1/3", "Next"; the last
    /// tip's "Next" reads "Done". Tip 3 keeps its lab upload above the row (AC2, AC3, AC7).
    func testEveryTipHasSkipACounterAndNext_AC2_AC3() {
        XCTAssertEqual(SnapshotTip().actions.map(\.id), [Tour.skipAction, Tour.nextAction])
        XCTAssertEqual(FoundationTip().actions.map(\.id), [Tour.skipAction, Tour.nextAction])
        XCTAssertEqual(BloodTestsTip().actions.map(\.id), [Tour.uploadAction, Tour.skipAction, Tour.nextAction],
                       "the lab upload first, then the row")
        XCTAssertEqual([SnapshotTip.counter, FoundationTip.counter, BloodTestsTip.counter], ["1/3", "2/3", "3/3"])
        XCTAssertEqual([SnapshotTip.spokenCounter, FoundationTip.spokenCounter, BloodTestsTip.spokenCounter],
                       ["Tip 1 of 3", "Tip 2 of 3", "Tip 3 of 3"], "what VoiceOver reads")
        XCTAssertEqual([SnapshotTip.nextTitle, FoundationTip.nextTitle, BloodTestsTip.nextTitle], ["Next", "Next", "Done"])
    }

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
