import XCTest
@testable import HealthRoadmap

/// US-25 AC8: the app asks for an App Store rating only once someone has used it:
/// values saved on at least three separate days, then their plan opened. Never on
/// the first day, and at most once per app version (Apple caps it at three a year).
final class ReviewPromptTests: XCTestCase {
    private let day: TimeInterval = 86_400
    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    private func prompt() -> ReviewPrompt {
        ReviewPrompt(defaults: UserDefaults(suiteName: "ReviewPromptTests-\(UUID().uuidString)")!, version: "1.0")
    }

    func testANewUserIsNotAsked() {
        let prompt = prompt()
        prompt.recordChanged(at: start)
        XCTAssertFalse(prompt.planOpened())
    }

    func testSavesOnThreeDaysThenOpeningThePlanAsksOnce() {
        let prompt = prompt()
        prompt.recordChanged(at: start)
        prompt.recordChanged(at: start + day)
        XCTAssertFalse(prompt.planOpened(), "two days of use is not enough")
        prompt.recordChanged(at: start + 2 * day)
        XCTAssertTrue(prompt.planOpened())
        XCTAssertFalse(prompt.planOpened(), "once per version")
    }

    func testManySavesOnOneDayCountOnce() {
        let prompt = prompt()
        for minute in 0..<10 { prompt.recordChanged(at: start + Double(minute) * 60) }
        XCTAssertFalse(prompt.planOpened())
    }

    func testANewVersionMayAskAgain() {
        let defaults = UserDefaults(suiteName: "ReviewPromptTests-\(UUID().uuidString)")!
        let first = ReviewPrompt(defaults: defaults, version: "1.0")
        for n in 0..<3 { first.recordChanged(at: start + Double(n) * day) }
        XCTAssertTrue(first.planOpened())

        let next = ReviewPrompt(defaults: defaults, version: "1.1")
        XCTAssertTrue(next.planOpened())
    }
}
