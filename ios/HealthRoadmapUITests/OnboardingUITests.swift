import XCTest

/// US-54 on screen: a fresh install goes from the welcome screen through the four
/// questions to My plan. Run it on a fresh install (uninstall first): it writes the
/// answers into the app's record, so never on a phone holding a real record.
final class OnboardingUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    /// The app, flagged so its session never reaches Clarity (US-25 AC19).
    @MainActor
    private func launch() -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()
        return app
    }

    /// Keeps a screenshot of each step in the test result, for checking the screens by eye.
    @MainActor
    private func snap(_ app: XCUIApplication, _ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    /// Welcome, Apple Health ("Not now"), then sex, birth and height, leaving the weight screen up.
    @MainActor
    private func answerUpToWeight(_ app: XCUIApplication) throws {
        let start = app.buttons["welcome.start"]
        // A failure, never a skip, so a broken first run cannot pass unseen (Codex re-check R3).
        XCTAssertTrue(start.waitForExistence(timeout: 10), "the welcome screen shows on a fresh install (uninstall the app first)")
        XCTAssertTrue(app.buttons["welcome.existing"].exists, "the existing-user way in is offered (AC2)")
        snap(app, "1 welcome")
        start.tap()

        // Apple Health: go on without it, so no system sheet is needed.
        let notNow = app.buttons["onboarding.notNow"]
        XCTAssertTrue(notNow.waitForExistence(timeout: 5))
        snap(app, "2 apple health")
        notNow.tap()

        // Sex must be answered before Continue works (AC4).
        let next = app.buttons["onboarding.continue"]
        XCTAssertTrue(next.waitForExistence(timeout: 5))
        XCTAssertFalse(next.isEnabled, "Continue waits for an answer")
        app.buttons["onboarding.female"].tap()
        snap(app, "3 sex")
        XCTAssertTrue(next.isEnabled)
        next.tap()

        // Birth and height: a wheel's starting value is not an answer until it is moved (AC4).
        XCTAssertTrue(app.staticTexts["When were you born?"].waitForExistence(timeout: 5))
        XCTAssertFalse(next.isEnabled, "the starting year is not an answer")
        app.pickerWheels.element(boundBy: 1).swipeDown()
        snap(app, "4 birth")
        XCTAssertTrue(next.isEnabled)
        next.tap()
        XCTAssertTrue(app.staticTexts["How tall are you?"].waitForExistence(timeout: 5))
        XCTAssertFalse(next.isEnabled, "the starting height is not an answer")
        app.pickerWheels.firstMatch.swipeUp()
        snap(app, "5 height")
        next.tap()

        XCTAssertTrue(app.buttons["onboarding.skip"].waitForExistence(timeout: 5))
        snap(app, "6 weight")
    }

    @MainActor
    func testNewUserReachesThePlan_AC1_AC4_AC7() throws {
        let app = launch()
        try answerUpToWeight(app)
        app.buttons["onboarding.skip"].tap()

        // The plan, not the form, and the flow does not come back (AC7).
        XCTAssertFalse(app.buttons["onboarding.continue"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.tabBars.buttons["My plan"].isSelected)
        snap(app, "7 plan")
        app.terminate()
        let again = launch()
        XCTAssertFalse(again.buttons["welcome.start"].waitForExistence(timeout: 3))
        XCTAssertFalse(again.buttons["onboarding.continue"].exists)
    }

    /// Quitting at the weight question resumes there, not on My data (AC7).
    @MainActor
    func testQuittingAtWeightResumesThere_AC7() throws {
        let app = launch()
        try answerUpToWeight(app)
        app.terminate()
        let again = launch()
        XCTAssertTrue(again.buttons["onboarding.skip"].waitForExistence(timeout: 10), "the weight question again")
        XCTAssertFalse(again.buttons["welcome.start"].exists)
    }
}
