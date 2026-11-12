import XCTest

/// US-25 AC10b (App Review 1.4.1): where the app says it is education, not medical advice, and
/// that each step cites its sources. The words are pinned in PlanLayoutTests.
final class ReviewPlacementUITests: XCTestCase {
    private let educationLine = "For education only, not medical advice. Talk to your doctor before you change anything about your health or medicines."

    override func setUp() {
        continueAfterFailure = false
    }

    /// Chat's empty state shows the education line, under the starter questions.
    @MainActor
    func testChatsEmptyStateShowsTheEducationLine_US25_AC10b() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "-welcomed", "YES", "-onboarded", "YES"]
        app.launch()
        openChat(app)
        let line = app.staticTexts[educationLine]
        XCTAssertTrue(line.waitForExistence(timeout: 5), "the education line in the empty chat")
        XCTAssertTrue(line.isHittable, "on screen, not scrolled away")
        XCTAssertLessThan(line.frame.maxY, app.textFields["Ask a question"].firstMatch.frame.minY, "above the question box")
        keepScreenshot(app.screenshot(), named: "chat empty")
    }

    /// The screens Brad checks by eye, on the fictional sample record (`--demo-record`, DEBUG only).
    /// Opt-in: TEST_RUNNER_REVIEW_SHOTS=1 with Application Support/Demo/health-roadmap.json seeded;
    /// any other run skips.
    @MainActor
    func testShootTheReviewPlacements() throws {
        guard ProcessInfo.processInfo.environment["REVIEW_SHOTS"] == "1" else {
            throw XCTSkip("Set TEST_RUNNER_REVIEW_SHOTS=1 with the Demo folder seeded.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--demo-record", "--ui-testing"]
        app.launch()
        let myHealth = app.tabBars.buttons["My health"]
        XCTAssertTrue(myHealth.waitForExistence(timeout: 15), "the tabs, not onboarding")
        myHealth.tap()

        // A closed card with its Sources mark, beside the chevron.
        let cited = app.buttons.matching(NSPredicate(format: "identifier == 'plan.suggestion' AND label CONTAINS 'Sources'")).firstMatch
        for _ in 0..<12 where !(cited.exists && cited.isHittable) { app.swipeUp() }
        XCTAssertTrue(cited.isHittable, "a card that cites sources marks it while closed")
        sleep(1)
        // The whole screen: on an iPad an iPhone app sits in a window, and its own shot is cut.
        keepScreenshot(XCUIScreen.main.screenshot(), named: "card sources")

        // The foot of My health: the disclaimer, unchanged.
        let foot = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Disclaimer'")).firstMatch
        for _ in 0..<25 where !(foot.exists && foot.isHittable) { app.swipeUp() }
        XCTAssertTrue(foot.isHittable, "the disclaimer at the foot of My health")
        sleep(1)
        keepScreenshot(XCUIScreen.main.screenshot(), named: "my health foot")

        openChat(app)
        XCTAssertTrue(app.staticTexts[educationLine].waitForExistence(timeout: 5), "the education line in the empty chat")
        sleep(1)
        keepScreenshot(XCUIScreen.main.screenshot(), named: "chat empty")
    }

    @MainActor
    private func openChat(_ app: XCUIApplication) {
        let chat = app.tabBars.buttons["Chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 15), "the tabs, not onboarding")
        chat.tap()
        // The consent screen is about sharing data; agreeing sends nothing until a question is asked.
        let agree = app.buttons["Agree and continue"]
        if agree.waitForExistence(timeout: 3) { agree.tap() }
    }
}
