import XCTest
@testable import HealthRoadmap

/// US-57 AC8, AC9: one prompt after the person's third save offers a backup to their own
/// cloud. It shows once, whether they back up or dismiss it, never while a cloud is
/// connected, and never while a tour tip is still due.
final class CloudPromptTests: XCTestCase {
    private func prompt(_ defaults: UserDefaults = fresh()) -> CloudPrompt { CloudPrompt(defaults: defaults) }

    private static func fresh() -> UserDefaults {
        UserDefaults(suiteName: "CloudPromptTests-\(UUID().uuidString)")!
    }

    func testNotDueBeforeTheThirdSave() {
        let prompt = prompt()
        XCTAssertFalse(prompt.isDue(connected: false, tourRunning: false))
        prompt.saved()
        prompt.saved()
        XCTAssertFalse(prompt.isDue(connected: false, tourRunning: false), "two saves are not enough")
    }

    func testDueAfterTheThirdSave() {
        let prompt = prompt()
        for _ in 0..<3 { prompt.saved() }
        XCTAssertTrue(prompt.isDue(connected: false, tourRunning: false))
    }

    func testShowsOnceWhateverTheAnswer() {
        // "Back up", "Not now" and a swipe all mark it shown the same way.
        let prompt = prompt()
        for _ in 0..<3 { prompt.saved() }
        prompt.shown()
        XCTAssertFalse(prompt.isDue(connected: false, tourRunning: false))
        for _ in 0..<10 { prompt.saved() }
        XCTAssertFalse(prompt.isDue(connected: false, tourRunning: false), "more saves never bring it back")
    }

    func testShownSurvivesARelaunch() {
        let defaults = Self.fresh()
        let first = prompt(defaults)
        for _ in 0..<3 { first.saved() }
        first.shown()
        XCTAssertFalse(prompt(defaults).isDue(connected: false, tourRunning: false))
    }

    func testTheCountSurvivesARelaunch() {
        let defaults = Self.fresh()
        prompt(defaults).saved()
        prompt(defaults).saved()
        let third = prompt(defaults)
        third.saved()
        XCTAssertTrue(third.isDue(connected: false, tourRunning: false))
    }

    func testNeverWhileACloudIsConnected() {
        let prompt = prompt()
        for _ in 0..<3 { prompt.saved() }
        XCTAssertFalse(prompt.isDue(connected: true, tourRunning: false))
        XCTAssertTrue(prompt.isDue(connected: false, tourRunning: false), "still due if the cloud is disconnected again")
    }

    func testWaitsForTheTour() {
        let prompt = prompt()
        for _ in 0..<3 { prompt.saved() }
        XCTAssertFalse(prompt.isDue(connected: false, tourRunning: true))
        XCTAssertTrue(prompt.isDue(connected: false, tourRunning: false))
    }

    func testOnlyACountIsKept() {
        let defaults = Self.fresh()
        let prompt = prompt(defaults)
        for _ in 0..<7 { prompt.saved() }
        XCTAssertEqual(defaults.integer(forKey: "backup.saves"), 3, "the count stops at 3")
    }
}
