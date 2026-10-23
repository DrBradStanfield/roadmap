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

    /// Waits for `element` to hold the keyboard: a box focused by its screen (Brad 2026-10-23).
    private func hasFocus(_ element: XCUIElement) -> Bool {
        let focused = XCTNSPredicateExpectation(predicate: NSPredicate(format: "hasKeyboardFocus == true"), object: element)
        return XCTWaiter.wait(for: [focused], timeout: 5) == .completed
    }

    /// Waits for a box to show `text`: a unit switch converts it once the record's units land.
    private func shows(_ field: XCUIElement, _ text: String) -> Bool {
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", text), object: field)
        return XCTWaiter.wait(for: [shown], timeout: 5) == .completed
    }

    /// Welcome, Apple Health ("Not now"), then sex and birth, leaving the height screen
    /// up. With `reachable`, every button tapped must be on screen (AC8).
    @MainActor
    private func answerUpToHeight(_ app: XCUIApplication, reachable: Bool = false, shots prefix: String = "") throws {
        let start = app.buttons["welcome.start"]
        // A failure, never a skip, so a broken first run cannot pass unseen (Codex re-check R3).
        XCTAssertTrue(start.waitForExistence(timeout: 10), "the welcome screen shows on a fresh install (uninstall the app first)")
        XCTAssertTrue(app.buttons["welcome.existing"].exists, "the existing-user way in is offered (AC2)")
        snap(app, prefix + "1 welcome")
        press(start, "Get started", reachable)

        // Apple Health: go on without it, so no system sheet is needed.
        let notNow = app.buttons["onboarding.notNow"]
        XCTAssertTrue(notNow.waitForExistence(timeout: 5))
        snap(app, prefix + "2 apple health")
        if reachable { XCTAssertTrue(app.buttons["onboarding.allow"].isHittable, "Allow is reachable") }
        press(notNow, "Not now", reachable)

        // Sex: a tap is the answer and moves on, so there is no Continue (AC4).
        let female = app.buttons["onboarding.female"]
        XCTAssertTrue(female.waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["onboarding.continue"].exists, "the sex step has no Continue")
        snap(app, prefix + "3 sex")
        press(female, "Female", reachable)

        // Birth: a wheel's starting value is not an answer until it is moved (AC4).
        let next = app.buttons["onboarding.continue"]
        XCTAssertTrue(app.pickerWheels.element(boundBy: 1).waitForExistence(timeout: 5), "Female went straight on to birth")
        XCTAssertFalse(next.isEnabled, "the starting year is not an answer")
        // An exact year (age 46), so the plan's screenings are known: a swipe lands anywhere.
        app.pickerWheels.element(boundBy: 1).adjust(toPickerWheelValue: "1980")
        snap(app, prefix + "4 birth")
        XCTAssertTrue(next.isEnabled)
        press(next, "Continue", reachable)
        XCTAssertTrue(app.staticTexts["How tall are you?"].waitForExistence(timeout: 5))
    }

    /// The rest of `answerUpToHeight`: a height typed in the screen's units, leaving the
    /// weight screen up with nothing typed.
    @MainActor
    private func answerUpToWeight(_ app: XCUIApplication, reachable: Bool = false, shots prefix: String = "") throws {
        try answerUpToHeight(app, reachable: reachable, shots: prefix)
        let next = app.buttons["onboarding.continue"]
        XCTAssertFalse(next.isEnabled, "an empty box is not an answer")
        let feet = app.textFields["onboarding.feet"]
        if feet.exists {
            XCTAssertTrue(hasFocus(feet), "the feet box is focused")
            feet.typeText("5")
            app.textFields["onboarding.inches"].tap()
            app.textFields["onboarding.inches"].typeText("7")
        } else {
            let cm = app.textFields["onboarding.height"]
            XCTAssertTrue(hasFocus(cm), "the centimetre box is focused")
            cm.typeText("170")
        }
        snap(app, prefix + "5 height")
        XCTAssertTrue(next.isEnabled)
        press(next, "Continue", reachable)

        // Weight is required: no Skip, and Continue waits for a number (AC4).
        let weight = app.textFields["onboarding.weight"]
        XCTAssertTrue(weight.waitForExistence(timeout: 5))
        XCTAssertTrue(hasFocus(weight), "the weight box is focused")
        XCTAssertFalse(app.buttons["onboarding.skip"].exists, "weight has no Skip")
        XCTAssertFalse(next.isEnabled, "Continue waits for a weight")
        snap(app, prefix + "6 weight")
    }

    /// Types a weight in the screen's units and continues.
    @MainActor
    private func answerWeight(_ app: XCUIApplication, reachable: Bool = false) {
        let pounds = app.segmentedControls["onboarding.weightUnits"].buttons["lb"].isSelected
        app.textFields["onboarding.weight"].typeText(pounds ? "154" : "70")
        press(app.buttons["onboarding.continue"], "Continue", reachable)
    }

    private func press(_ button: XCUIElement, _ what: String, _ reachable: Bool) {
        if reachable { XCTAssertTrue(button.isHittable, "\(what) is reachable") }
        button.tap()
    }

    @MainActor
    func testNewUserReachesThePlan_AC1_AC4_AC7() throws {
        let app = launch()
        try answerUpToWeight(app)
        answerWeight(app)

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
        answerWeight(app)
        let cervical = app.staticTexts["Start cervical cancer screening"]
        XCTAssertTrue(cervical.waitForExistence(timeout: 10), "a woman's plan offers cervical screening")
        app.tabBars.buttons["My data"].tap()
        let male = app.buttons["Male"].firstMatch
        var tries = 0
        while !male.isHittable && tries < 15 { app.swipeUp(); tries += 1 }
        male.tap()
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
        answerWeight(app, reachable: true)
        XCTAssertTrue(app.tabBars.buttons["My plan"].waitForExistence(timeout: 10))
    }

    /// The unit switches are for entry only (AC6): a typed height converts, weight still
    /// opens in the record's units, a weight typed in the other unit is saved as the right
    /// weight, and the record's units never change.
    @MainActor
    func testTheUnitSwitchesAreForEntryOnly_AC6() throws {
        let app = launch()
        try answerUpToHeight(app)
        let heightUnits = app.segmentedControls["onboarding.heightUnits"]
        let metricRecord = heightUnits.buttons["cm"].isSelected
        if metricRecord {
            app.textFields["onboarding.height"].typeText("170")
            heightUnits.buttons["ft in"].tap()
            XCTAssertTrue(shows(app.textFields["onboarding.feet"], "5"), "170 cm is 5 ft")
            XCTAssertTrue(shows(app.textFields["onboarding.inches"], "7"), "and 7 in")
        } else {
            app.textFields["onboarding.feet"].typeText("5")
            app.textFields["onboarding.inches"].tap()
            app.textFields["onboarding.inches"].typeText("7")
            heightUnits.buttons["cm"].tap()
            XCTAssertTrue(shows(app.textFields["onboarding.height"], "170"), "5 ft 7 in is 170 cm")
        }
        snap(app, "height switched")
        app.buttons["onboarding.continue"].tap()

        let weight = app.textFields["onboarding.weight"]
        XCTAssertTrue(weight.waitForExistence(timeout: 5))
        let weightUnits = app.segmentedControls["onboarding.weightUnits"]
        XCTAssertTrue(weightUnits.buttons[metricRecord ? "kg" : "lb"].isSelected, "the height's switch left the record's units alone")
        // The other unit, then a weight in it: 154 lb is 69.9 kg; 70 kg is 154 lb.
        weightUnits.buttons[metricRecord ? "lb" : "kg"].tap()
        weight.typeText(metricRecord ? "154" : "70")
        app.buttons["onboarding.continue"].tap()
        XCTAssertTrue(app.tabBars.buttons["My plan"].waitForExistence(timeout: 10))

        app.tabBars.buttons["My data"].tap()
        // The weight card reads as one combined label ("Weight, …, 69.9, kg"), so match the number.
        let saved = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", metricRecord ? "69.9" : "154")).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 10), "the weight is saved as the right weight, in the record's units")
        let us = app.buttons["US"]
        var tries = 0
        while !us.isHittable && tries < 15 { app.swipeUp(); tries += 1 }
        XCTAssertEqual(us.isSelected, !metricRecord, "the record's units are unchanged")
        snap(app, "units unchanged")
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
        answerWeight(app)
        app.tabBars.buttons["My data"].tap()
        // Units other than the region's: the erase keeps them, and so must the questions (Codex R1).
        // The Units row sits low in About you, so scroll to it first.
        let delete = app.buttons["Delete all my data"]
        let usButton = app.buttons["US"]
        var tries = 0
        while !usButton.isHittable && tries < 15 { app.swipeUp(); tries += 1 }
        XCTAssertTrue(usButton.isHittable, "the Units control is reachable")
        let us = !usButton.isSelected
        app.buttons[us ? "US" : "Metric"].tap()
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

        // On to height, which shows the kept units: feet and inches, or one centimetre box.
        app.buttons["onboarding.notNow"].tap()
        app.buttons["onboarding.female"].tap()
        XCTAssertTrue(app.pickerWheels.element(boundBy: 1).waitForExistence(timeout: 5))
        app.pickerWheels.element(boundBy: 1).adjust(toPickerWheelValue: "1980")
        app.buttons["onboarding.continue"].tap()
        XCTAssertTrue(app.staticTexts["How tall are you?"].waitForExistence(timeout: 5))
        XCTAssertEqual(app.textFields["onboarding.feet"].exists, us, us ? "US units kept" : "metric kept")
    }

    /// Quitting at the weight question resumes there, not on My data (AC7).
    @MainActor
    func testQuittingAtWeightResumesThere_AC7() throws {
        let app = launch()
        try answerUpToWeight(app)
        app.terminate()
        let again = launch()
        XCTAssertTrue(again.textFields["onboarding.weight"].waitForExistence(timeout: 10), "the weight question again")
        XCTAssertFalse(again.buttons["onboarding.continue"].isEnabled, "still required: nothing typed")
        XCTAssertFalse(again.buttons["welcome.start"].exists)
    }
}
