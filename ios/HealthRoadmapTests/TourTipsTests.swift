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
            XCTAssertEqual(step.skipped(), .done, "AC3")
            XCTAssertEqual(step.skipped().started(), .done, "a skipped tour never comes back")
        }
        XCTAssertEqual(TourStep.notStarted.skipped(), .notStarted)
    }

    func testEachTipShowsAtItsOwnStepOnly() {
        // The tips' rules compare Tour.step to these raw values; the order must hold.
        XCTAssertEqual(TourStep.allCases.map(\.rawValue), [0, 1, 2, 3, 4])
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
