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
    private func launch(textSize: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        if let textSize { app.launchArguments += ["-UIPreferredContentSizeCategoryName", textSize] }
        app.launch()
        return app
    }

    @MainActor
    private func snap(_ app: XCUIApplication, _ name: String) {
        keepScreenshot(app.screenshot(), named: name)
    }

    /// Welcome, Apple Health ("Not now"), then sex, birth and height, leaving the weight
    /// screen up. With `reachable`, every button tapped must be on screen (AC8).
    @MainActor
    private func answerUpToWeight(_ app: XCUIApplication, reachable: Bool = false, shots prefix: String = "") throws {
        func press(_ button: XCUIElement, _ what: String) {
            if reachable { XCTAssertTrue(button.isHittable, "\(what) is reachable") }
            button.tap()
        }
        let start = app.buttons["welcome.start"]
        // A failure, never a skip, so a broken first run cannot pass unseen (Codex re-check R3).
        XCTAssertTrue(start.waitForExistence(timeout: 10), "the welcome screen shows on a fresh install (uninstall the app first)")
        XCTAssertTrue(app.buttons["welcome.existing"].exists, "the existing-user way in is offered (AC2)")
        snap(app, prefix + "1 welcome")
        press(start, "Get started")

        // Apple Health: go on without it, so no system sheet is needed.
        let notNow = app.buttons["onboarding.notNow"]
        XCTAssertTrue(notNow.waitForExistence(timeout: 5))
        snap(app, prefix + "2 apple health")
        if reachable { XCTAssertTrue(app.buttons["onboarding.allow"].isHittable, "Allow is reachable") }
        press(notNow, "Not now")

        // Sex must be answered before Continue works (AC4).
        let next = app.buttons["onboarding.continue"]
        XCTAssertTrue(next.waitForExistence(timeout: 5))
        XCTAssertFalse(next.isEnabled, "Continue waits for an answer")
        press(app.buttons["onboarding.female"], "Female")
        snap(app, prefix + "3 sex")
        XCTAssertTrue(next.isEnabled)
        press(next, "Continue")

        // Birth and height: a wheel's starting value is not an answer until it is moved (AC4).
        XCTAssertTrue(app.pickerWheels.element(boundBy: 1).waitForExistence(timeout: 5))
        XCTAssertFalse(next.isEnabled, "the starting year is not an answer")
        // An exact year (age 46), so the plan's screenings are known: a swipe lands anywhere.
        app.pickerWheels.element(boundBy: 1).adjust(toPickerWheelValue: "1980")
        snap(app, prefix + "4 birth")
        XCTAssertTrue(next.isEnabled)
        press(next, "Continue")
        XCTAssertTrue(app.staticTexts["How tall are you?"].waitForExistence(timeout: 5))
        XCTAssertFalse(next.isEnabled, "the starting height is not an answer")
        app.pickerWheels.firstMatch.swipeUp()
        snap(app, prefix + "5 height")
        press(next, "Continue")

        XCTAssertTrue(app.buttons["onboarding.skip"].waitForExistence(timeout: 5))
        snap(app, prefix + "6 weight")
        if reachable { XCTAssertTrue(app.buttons["onboarding.skip"].isHittable && next.isHittable, "Skip and Continue are reachable") }
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

    /// The plan follows an edit made on My data while it was hidden (US-25 AC6): it
    /// plans again on return, and never shows the older plan.
    @MainActor
    func testThePlanFollowsAnEditMadeOnMyData_US25_AC6() throws {
        let app = launch()
        try answerUpToWeight(app)
        app.buttons["onboarding.skip"].tap()
        let cervical = app.staticTexts["Start cervical cancer screening"]
        XCTAssertTrue(cervical.waitForExistence(timeout: 10), "a woman's plan offers cervical screening")
        app.tabBars.buttons["My data"].tap()
        app.buttons["Male"].firstMatch.tap()
        app.tabBars.buttons["My plan"].tap()
        XCTAssertTrue(app.staticTexts["Next Steps"].waitForExistence(timeout: 10) || app.staticTexts["Foundation"].waitForExistence(timeout: 5))
        XCTAssertFalse(cervical.exists, "the plan was worked out again for a man")
        snap(app, "8 plan after edit")
    }

    /// At the largest accessibility text size every screen still offers its buttons (AC8).
    @MainActor
    func testEveryStepWorksAtTheLargestTextSize_AC8() throws {
        let app = launch(textSize: "UICTContentSizeCategoryAccessibilityXXXL")
        let start = app.buttons["welcome.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        // The size took: at the default size Get started is about 50 points tall.
        XCTAssertGreaterThan(start.frame.height, 70, "the largest text size is applied")
        try answerUpToWeight(app, reachable: true, shots: "large ")
    }

    /// "Allow" shows Apple's Health sheet, which asks to read sex and date of birth (AC3).
    /// The sheet runs in Apple's own process and reports its buttons' positions only
    /// inside their rows, so a test cannot answer it; answering it is checked by hand.
    @MainActor
    func testAllowShowsAppleHealthAskingForSexAndBirthDate_AC3() throws {
        let app = launch()
        let start = app.buttons["welcome.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        let allow = app.buttons["onboarding.allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 5))
        allow.tap()
        let sheet = XCUIApplication(bundleIdentifier: "com.apple.HealthPrivacyService")
        XCTAssertTrue(sheet.cells["UIA.Health.AuthSheet.AllCategoryButton"].waitForExistence(timeout: 10), "Apple's Health sheet appears")
        XCTAssertTrue(sheet.switches["UIA.Health.Read.Sex.SwitchCell.Switch"].exists, "it asks to read sex")
        XCTAssertTrue(sheet.switches["UIA.Health.Read.DateofBirth.SwitchCell.Switch"].exists, "and date of birth")
        XCTAssertTrue(sheet.switches["UIA.Health.Read.Weight.SwitchCell.Switch"].exists, "and weight")
        snap(app, "health sheet")
    }

    /// "Delete all my data" brings the questions back, not the welcome screen (AC7).
    @MainActor
    func testDeletingAllMyDataStartsTheQuestionsAgain_AC7() throws {
        let app = launch()
        try answerUpToWeight(app)
        app.buttons["onboarding.skip"].tap()
        app.tabBars.buttons["My data"].tap()
        // Units other than the region's: the erase keeps them, and so must the questions (Codex R1).
        let us = !app.buttons["US"].isSelected
        app.buttons[us ? "US" : "Metric"].tap()
        let delete = app.buttons["Delete all my data"]
        while !delete.isHittable { app.swipeUp() }
        delete.tap()
        app.buttons["Delete everything"].firstMatch.tap()
        // The alert's own button, then the words that say it is done.
        XCTAssertTrue(app.alerts.buttons["Delete everything"].waitForExistence(timeout: 5))
        app.alerts.buttons["Delete everything"].tap()
        XCTAssertTrue(app.alerts.buttons["OK"].waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()

        XCTAssertTrue(app.buttons["onboarding.notNow"].waitForExistence(timeout: 10), "the questions again")
        XCTAssertFalse(app.buttons["welcome.start"].exists, "not the welcome screen")
        snap(app, "after delete")

        // On to height, which shows the kept units: feet and inches, or one centimetre wheel.
        app.buttons["onboarding.notNow"].tap()
        app.buttons["onboarding.female"].tap()
        app.buttons["onboarding.continue"].tap()
        XCTAssertTrue(app.pickerWheels.element(boundBy: 1).waitForExistence(timeout: 5))
        app.pickerWheels.element(boundBy: 1).adjust(toPickerWheelValue: "1980")
        app.buttons["onboarding.continue"].tap()
        XCTAssertTrue(app.staticTexts["How tall are you?"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.pickerWheels.count, us ? 2 : 1, us ? "US units kept" : "metric kept")
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
