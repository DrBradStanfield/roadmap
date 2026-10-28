import XCTest
@testable import HealthRoadmap

/// US-57 AC8, AC9: one prompt after the person's third save offers a backup to their own
/// cloud. It shows once, whether they back up or dismiss it, never while a cloud is
/// connected, and waits until the tour has ended (the third save ends it).
final class CloudPromptTests: XCTestCase {
    private func prompt(_ defaults: UserDefaults = fresh()) -> CloudPrompt { CloudPrompt(defaults: defaults) }

    private static func fresh() -> UserDefaults {
        UserDefaults(suiteName: "CloudPromptTests-\(UUID().uuidString)")!
    }

    func testNotDueBeforeTheThirdSave() {
        let prompt = prompt()
        XCTAssertFalse(prompt.isDue(connected: false))
        prompt.saved()
        prompt.saved()
        XCTAssertFalse(prompt.isDue(connected: false), "two saves are not enough")
    }

    func testDueAfterTheThirdSave() {
        let prompt = prompt()
        for _ in 0..<3 { prompt.saved() }
        XCTAssertTrue(prompt.isDue(connected: false))
    }

    func testShowsOnceWhateverTheAnswer() {
        // "Back up", "Not now" and a swipe all mark it shown the same way.
        let prompt = prompt()
        for _ in 0..<3 { prompt.saved() }
        prompt.shown()
        XCTAssertFalse(prompt.isDue(connected: false))
        for _ in 0..<10 { prompt.saved() }
        XCTAssertFalse(prompt.isDue(connected: false), "more saves never bring it back")
    }

    func testShownSurvivesARelaunch() {
        let defaults = Self.fresh()
        let first = prompt(defaults)
        for _ in 0..<3 { first.saved() }
        first.shown()
        XCTAssertFalse(prompt(defaults).isDue(connected: false))
    }

    func testTheCountSurvivesARelaunch() {
        let defaults = Self.fresh()
        prompt(defaults).saved()
        prompt(defaults).saved()
        let third = prompt(defaults)
        third.saved()
        XCTAssertTrue(third.isDue(connected: false))
    }

    func testNeverWhileACloudIsConnected() {
        let prompt = prompt()
        for _ in 0..<3 { prompt.saved() }
        XCTAssertFalse(prompt.isDue(connected: true))
        XCTAssertTrue(prompt.isDue(connected: false), "still due if the cloud is disconnected again")
    }

    /// Review R2(b): the third own save ends a tour still running, so the tour can never
    /// hold the prompt back.
    func testTheThirdSaveEndsTheTour() {
        let prompt = prompt()
        prompt.saved()
        prompt.saved()
        XCTAssertFalse(prompt.endsTour)
        prompt.saved()
        XCTAssertTrue(prompt.endsTour)
    }

    /// Review R1 (adversary, Codex): onboarding's answers, the last one included, are saves
    /// the engine counts, but not the person's own; only saves after it count.
    func testOnboardingsSavesNeverCount() {
        let prompt = prompt()
        prompt.ignoreSaves(upTo: 5)
        prompt.ownSaves(5)
        XCTAssertEqual(prompt.saves, 0, "finishing onboarding leaves the count at zero")
        prompt.ownSaves(6)
        XCTAssertEqual(prompt.saves, 1)
        prompt.ownSaves(8)
        XCTAssertEqual(prompt.saves, 3, "two saves seen at once count as two")
    }

    /// A spent prompt needs no waiting (/simplify 12).
    func testSpentOnceShown() {
        let prompt = prompt()
        XCTAssertFalse(prompt.isSpent)
        prompt.shown()
        XCTAssertTrue(prompt.isSpent)
    }

    func testOnlyACountIsKept() {
        let defaults = Self.fresh()
        let prompt = prompt(defaults)
        for _ in 0..<7 { prompt.saved() }
        XCTAssertEqual(defaults.integer(forKey: "backup.saves"), 3, "the count stops at 3")
    }
}
