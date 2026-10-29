import XCTest

/// Films Chat answering on a real iPhone from the fictional sample record (US-25 AC23), never the
/// owner's: `--demo-record` (DEBUG only, DemoRecord.swift) runs on Application Support/Demo
/// with cloud sync, Apple Health and reminders off. Opt-in: set TEST_RUNNER_CHAT_DEMO_FILM=1
/// on a Debug device run, after docs/examples/health-roadmap.sample.json was copied into
/// that folder as health-roadmap.json; any other run skips.
final class ChatDemoFilmUITests: XCTestCase {
    @MainActor
    func testChatAnswersFromTheDemoRecord() throws {
        guard ProcessInfo.processInfo.environment["CHAT_DEMO_FILM"] == "1" else {
            throw XCTSkip("Set TEST_RUNNER_CHAT_DEMO_FILM=1 on a Debug device run with the Demo folder seeded.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--demo-record", "--ui-testing"]
        app.launch()
        let chat = app.tabBars.buttons["Chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 15), "the tabs, not onboarding")
        chat.tap()
        let agree = app.buttons["Agree and continue"]
        if agree.waitForExistence(timeout: 3) { agree.tap() }

        let question = "Explain my cholesterol results"
        let starter = app.buttons[question]
        XCTAssertTrue(starter.waitForExistence(timeout: 5), "the starter question")
        starter.tap()

        // History is disabled while an answer streams, and enabled again once it ends, finished
        // or failed: so the error line, "No answer." and the cut-off message are checked too (Codex low).
        let history = app.buttons["History"]
        let state = { (enabled: Bool, timeout: TimeInterval) in
            XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == %@", NSNumber(value: enabled)), object: history)], timeout: timeout)
        }
        _ = state(false, 5)
        XCTAssertEqual(state(true, 60), .completed, "the answer ended within 60 s")
        XCTAssertFalse(app.staticTexts["chat.error"].exists, "no error line: \(app.staticTexts["chat.error"].label)")
        XCTAssertFalse(app.staticTexts.matching(NSPredicate(format: "label CONTAINS[c] %@", "cut off")).firstMatch.exists, "not cut off")
        let answer = app.staticTexts.allElementsBoundByIndex.map(\.label).filter { $0 != question }.max { $0.count < $1.count } ?? ""
        print("CHAT_DEMO_FILM answer first line: \(answer.split(separator: "\n").first ?? "")")
        XCTAssertFalse(app.staticTexts["No answer."].exists, "the server answered")
        XCTAssertGreaterThan(answer.count, 100, "an answer, not an error")
        sleep(4)
        keepScreenshot(app.screenshot(), named: "chat answer")
    }
}
