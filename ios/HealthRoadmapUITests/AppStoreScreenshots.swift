import XCTest

/// The App Store screenshots (US-25 AC10, ios/app-store.md step 6): My data, My plan, an opened card,
/// a value page and Chat, from the sample record. Opt-in: ios/scripts/app-store-shots.sh
/// seeds the record and sets TEST_RUNNER_APP_STORE_SHOTS; any other run skips.
final class AppStoreScreenshots: XCTestCase {
    @MainActor
    func testTakeTheAppStoreScreenshots() throws {
        guard ProcessInfo.processInfo.environment["APP_STORE_SHOTS"] == "1" else {
            throw XCTSkip("Run by ios/scripts/app-store-shots.sh, which seeds the sample record.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        app.launch()

        let tabs = app.tabBars
        XCTAssertTrue(tabs.buttons["My data"].waitForExistence(timeout: 15), "the seeded record opens on the tabs, not onboarding")
        tabs.buttons["My data"].tap()
        shoot(app, "1 my data")

        tabs.buttons["My plan"].tap()
        XCTAssertTrue(app.staticTexts["Next Steps"].waitForExistence(timeout: 10) || app.staticTexts["Requires Attention"].waitForExistence(timeout: 5))
        shoot(app, "2 my plan")

        // The first card on the plan, opened. Every shot is asserted: a missing one fails the run.
        let card = app.scrollViews.buttons.firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5), "a plan card")
        card.tap()
        shoot(app, "3 card opened")
        card.tap()

        tabs.buttons["My data"].tap()
        let weight = app.staticTexts["Weight"].firstMatch
        XCTAssertTrue(weight.waitForExistence(timeout: 5), "the Weight row")
        weight.tap()
        XCTAssertTrue(app.navigationBars["Weight"].waitForExistence(timeout: 5), "the weight page")
        shoot(app, "4 weight page")
        app.navigationBars.buttons.element(boundBy: 0).tap()

        // Chat past its consent screen, nothing sent: the agreement stays on this simulator.
        tabs.buttons["Chat"].tap()
        let agree = app.buttons["Agree and continue"]
        XCTAssertTrue(agree.waitForExistence(timeout: 5), "Chat's consent screen")
        agree.tap()
        XCTAssertTrue(app.textFields["Ask a question"].waitForExistence(timeout: 5) || app.textViews["Ask a question"].waitForExistence(timeout: 2), "the question box")
        shoot(app, "5 chat")
    }

    @MainActor
    private func shoot(_ app: XCUIApplication, _ name: String) {
        sleep(1) // let animations settle
        keepScreenshot(XCUIScreen.main.screenshot(), named: name)
    }
}
