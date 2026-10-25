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
    /// `tips`: the tour's tips on, from an empty TipKit store (US-57 AC10); otherwise hidden.
    private func launch(textSize: String? = nil, tips: Bool = false) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"] + (tips ? ["--show-tips"] : [])
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

    /// Types `text` and waits for the box to show exactly it. Under load the keyboard has
    /// echoed a key twice ("170" showed "1700"); a box that differs is emptied and typed again.
    @MainActor
    private func enter(_ text: String, in field: XCUIElement) {
        for _ in 0..<3 {
            field.typeText(text)
            if shows(field, text) { return }
            let typed = (field.value as? String) ?? ""
            field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: typed.count))
        }
        XCTFail("the box never showed \(text)")
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
            enter("5", in: feet)
            app.textFields["onboarding.inches"].tap()
            enter("7", in: app.textFields["onboarding.inches"])
        } else {
            let cm = app.textFields["onboarding.height"]
            XCTAssertTrue(hasFocus(cm), "the centimetre box is focused")
            enter("170", in: cm)
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
        enter(pounds ? "154" : "70", in: app.textFields["onboarding.weight"])
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
        XCTAssertFalse(app.staticTexts[Self.tourLines[0]].waitForExistence(timeout: 2), "--ui-testing hides the tour (US-57 AC10)")
        snap(app, "7 plan")
        app.terminate()
        let again = launch()
        XCTAssertFalse(again.buttons["welcome.start"].waitForExistence(timeout: 3))
        XCTAssertFalse(again.buttons["onboarding.continue"].exists)
    }

    /// US-57's three tips, word for word (Brad 2026-10-25).
    static let tourLines = [
        "A snapshot of your health. Tap any tile to learn more.",
        "Start here. Each step comes with the reason and the evidence.",
        "The more data you add, the more personal your plan. You can upload lab reports to fill these in for you.",
    ]

    /// US-57: after onboarding, the three tips in order, one at a time, each with "Skip
    /// tour", its counter and "Next"; tip 2's "Next" opens My data at Blood tests, where
    /// tip 3's "Done" ends the tour for good; a tile explains itself (AC1-AC7; Brad
    /// 2026-10-25, review R5).
    @MainActor
    func testTheTourWalksItsThreeTips_US57() throws {
        let app = launch(tips: true)
        try answerUpToWeight(app)
        answerWeight(app)

        let snapshot = app.staticTexts[Self.tourLines[0]]
        let foundation = app.staticTexts[Self.tourLines[1]]
        let bloodTests = app.staticTexts[Self.tourLines[2]]
        XCTAssertTrue(snapshot.waitForExistence(timeout: 10), "tip 1 shows on My plan after onboarding")
        XCTAssertFalse(foundation.exists, "one tip at a time")
        XCTAssertTrue(app.buttons["Skip tour"].exists, "the tour can be skipped")
        XCTAssertTrue(app.staticTexts["Tip 1 of 3"].exists, "VoiceOver reads the counter in words")
        XCTAssertFalse(app.buttons["Close"].exists, "no x: Next and Skip tour do its work")
        for name in ["Skip tour", "Next"] {
            let frame = app.buttons[name].firstMatch.frame
            XCTAssertGreaterThanOrEqual(frame.width, 44, "\(name) is a 44-point target (AC11, review R1)")
            XCTAssertGreaterThanOrEqual(frame.height, 44, "\(name) is a 44-point target (AC11, review R1)")
        }
        snap(app, "tour 1 snapshot")
        tapNext(app)
        XCTAssertTrue(snapshot.waitForNonExistence(timeout: 5))

        XCTAssertTrue(foundation.waitForExistence(timeout: 10), "tip 2 follows tip 1")
        XCTAssertTrue(app.staticTexts["Tip 2 of 3"].exists)
        XCTAssertTrue(app.tabBars.buttons["My plan"].isSelected, "tip 2 is on My plan")
        snap(app, "tour 2 foundation")
        tapNext(app)

        // Tip 2's Next crosses to My data and brings Blood tests into view: no swipe here.
        XCTAssertTrue(bloodTests.waitForExistence(timeout: 10), "tip 3 shows at Blood tests on My data")
        XCTAssertTrue(app.tabBars.buttons["My data"].isSelected, "Next opened My data")
        XCTAssertTrue(app.staticTexts["Tip 3 of 3"].exists)
        XCTAssertTrue(app.buttons["Add a lab report"].exists, "tip 3 keeps its lab upload")
        snap(app, "tour 3 blood tests")
        let done = app.buttons["Done"].firstMatch
        XCTAssertTrue(done.exists, "the last tip's Next reads Done")
        done.tap()
        XCTAssertTrue(bloodTests.waitForNonExistence(timeout: 5), "Done ends the tour")
        XCTAssertFalse(app.staticTexts["Add medical records"].waitForExistence(timeout: 2), "Done opens nothing")

        // Back at the Blood tests header, on screen: the tour has ended (review R5).
        app.tabBars.buttons["My plan"].tap()
        app.tabBars.buttons["My data"].tap()
        XCTAssertTrue(scrollTo(app.staticTexts["Blood tests"], in: app), "the header tip 3 anchors to is on screen")
        XCTAssertFalse(bloodTests.waitForExistence(timeout: 3), "tip 3 never shows again")

        // Every tile explains itself, for good (AC5).
        app.tabBars.buttons["My plan"].tap()
        let tile = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Ideal Body Weight'")).firstMatch
        for _ in 0..<4 where !tile.isHittable { app.swipeDown() }
        tile.tap()
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'A healthy weight for your height and sex'")).firstMatch.waitForExistence(timeout: 5),
                      "the tile's what-it-is")
        snap(app, "tour tile explainer")
        app.buttons["Done"].tap()
        XCTAssertFalse(snapshot.waitForExistence(timeout: 2), "tip 1 never shows again")
    }

    /// A tap outside a tip only dismisses it and counts as closed, so the tour moves on
    /// without switching tabs (review R2a); tip 3 then waits for My data, which brings it
    /// into view, and its action opens the lab upload and ends the tour (AC2, AC7).
    @MainActor
    func testATapOutsideMovesOnAndTipThreeOpensTheLabUpload_US57() throws {
        let app = launch(tips: true)
        try answerUpToWeight(app)
        answerWeight(app)
        let snapshot = app.staticTexts[Self.tourLines[0]]
        let foundation = app.staticTexts[Self.tourLines[1]]
        let bloodTests = app.staticTexts[Self.tourLines[2]]
        XCTAssertTrue(snapshot.waitForExistence(timeout: 10))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.8)).tap()
        XCTAssertTrue(snapshot.waitForNonExistence(timeout: 5))
        XCTAssertTrue(foundation.waitForExistence(timeout: 10), "a tap outside tip 1 moves on to tip 2")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        XCTAssertTrue(foundation.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["My plan"].isSelected, "a tap outside never switches tabs")
        app.swipeDown()
        XCTAssertFalse(foundation.waitForExistence(timeout: 3), "tip 2 does not come back: the tour moved on")

        app.tabBars.buttons["My data"].tap()
        XCTAssertTrue(bloodTests.waitForExistence(timeout: 10), "tip 3 shows once My data opens, scrolled into view")
        app.buttons["Add a lab report"].tap()
        XCTAssertTrue(app.staticTexts["Add medical records"].waitForExistence(timeout: 5), "the action opens the lab upload")
        snap(app, "tour lab upload")
        app.buttons["Close"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Add medical records"].waitForNonExistence(timeout: 5))
        app.tabBars.buttons["My plan"].tap()
        app.tabBars.buttons["My data"].tap()
        XCTAssertTrue(scrollTo(app.staticTexts["Blood tests"], in: app))
        XCTAssertFalse(bloodTests.waitForExistence(timeout: 3), "the upload ended the tour: tip 3 never shows again")
    }

    /// "Skip tour" ends it: with each later anchor on screen, no later tip shows (AC3, review R5).
    @MainActor
    func testSkipEndsTheTour_US57() throws {
        let app = launch(tips: true)
        try answerUpToWeight(app)
        answerWeight(app)
        let snapshot = app.staticTexts[Self.tourLines[0]]
        XCTAssertTrue(snapshot.waitForExistence(timeout: 10))
        app.buttons["Skip tour"].tap()
        XCTAssertTrue(snapshot.waitForNonExistence(timeout: 5))
        XCTAssertTrue(scrollTo(app.staticTexts["Foundation"], in: app), "the Foundation section, where tip 2 anchors, is on screen")
        XCTAssertFalse(app.staticTexts[Self.tourLines[1]].waitForExistence(timeout: 3), "no tip 2")
        app.tabBars.buttons["My data"].tap()
        XCTAssertTrue(scrollTo(app.staticTexts["Blood tests"], in: app), "the Blood tests header is on screen")
        XCTAssertFalse(app.staticTexts[Self.tourLines[2]].waitForExistence(timeout: 3), "no tip 3")
    }

    /// At the largest accessibility text size a tip scrolls rather than clips, and its
    /// Skip tour, counter and Next stay reachable (AC11, review R3).
    @MainActor
    func testATipWorksAtTheLargestTextSize_US57() throws {
        let app = launch(textSize: "UICTContentSizeCategoryAccessibilityXXXL", tips: true)
        try answerUpToWeight(app, reachable: true)
        answerWeight(app, reachable: true)
        let snapshot = app.staticTexts[Self.tourLines[0]]
        XCTAssertTrue(snapshot.waitForExistence(timeout: 10))
        snap(app, "tour 1 snapshot AX5")
        let skip = app.buttons["Skip tour"]
        for _ in 0..<4 where !skip.isHittable { app.popovers.firstMatch.swipeUp() }
        XCTAssertTrue(skip.isHittable, "Skip tour can be reached")
        let next = app.buttons["Next"].firstMatch
        for _ in 0..<4 where !next.isHittable { app.popovers.firstMatch.swipeUp() }
        XCTAssertTrue(next.isHittable, "Next can be reached")
        XCTAssertTrue(app.staticTexts["Tip 1 of 3"].exists, "and the counter is there")
        snap(app, "tour 1 snapshot AX5 controls")
        next.tap()
        XCTAssertTrue(snapshot.waitForNonExistence(timeout: 5))
    }

    /// US-57 AC8, AC9 wiring (review R1, R5): with the tips hidden, onboarding's answers do
    /// not count, two saves of the person's own show nothing, the third shows the cloud
    /// prompt once (it also ends the hidden tour, R2b), and it never comes back.
    @MainActor
    func testTheThirdOwnSaveOffersACloudCopyOnce_US57() throws {
        let app = launch()
        try answerUpToWeight(app)
        answerWeight(app)
        XCTAssertTrue(app.tabBars.buttons["My plan"].waitForExistence(timeout: 10))
        let prompt = app.staticTexts["Back up your record"]
        XCTAssertFalse(prompt.waitForExistence(timeout: 3), "onboarding's answers are not the person's saves")
        app.tabBars.buttons["My data"].tap()
        // About you's sex switch (a segmented control); a bare "Male" query matched an
        // element that took no tap, so only the first of three edits landed.
        let sex = app.segmentedControls.containing(.button, identifier: "Male").firstMatch
        XCTAssertTrue(scrollTo(sex, in: app))
        let male = sex.buttons["Male"]
        let female = sex.buttons["Female"]
        pick(male, in: sex)
        pick(female, in: sex)
        XCTAssertFalse(prompt.waitForExistence(timeout: 3), "two saves are not enough")
        pick(male, in: sex)
        XCTAssertTrue(prompt.waitForExistence(timeout: 8), "the third own save offers the cloud copy")
        snap(app, "cloud prompt")
        app.buttons["backup.notNow"].tap()
        XCTAssertTrue(prompt.waitForNonExistence(timeout: 5))
        pick(female, in: sex)
        app.tabBars.buttons["My plan"].tap()
        XCTAssertFalse(prompt.waitForExistence(timeout: 4), "once only")
    }

    /// Taps a sex segment once the switch is enabled again (it is disabled while the last
    /// edit lands, and drops a tap then by design), then waits for the tap to show. The
    /// switch is first scrolled clear of the navigation bar and the tab bar: a tap on a
    /// segment sitting under the nav bar is "hittable" yet lands on the bar, so it never
    /// reaches the picker (the second and third taps of this test did exactly that).
    @MainActor
    private func pick(_ segment: XCUIElement, in control: XCUIElement) {
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isEnabled == true"), object: control)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 10), .completed, "the switch is enabled again")
        let screen = XCUIApplication().windows.firstMatch.frame
        for _ in 0..<10 where control.frame.minY < screen.height * 0.25 || control.frame.maxY > screen.height * 0.7 {
            let up = control.frame.minY > screen.height * 0.5
            let from = screen.height * (up ? 0.6 : 0.3), to = screen.height * (up ? 0.4 : 0.6)
            let start = XCUIApplication().coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: from / screen.height))
            let end = XCUIApplication().coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: to / screen.height))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        segment.tap()
        let shown = XCTNSPredicateExpectation(predicate: NSPredicate(format: "isSelected == true"), object: segment)
        XCTAssertEqual(XCTWaiter.wait(for: [shown], timeout: 5), .completed, "\(segment.label) shows as picked")
    }

    /// Scrolls the screen until `element` can be tapped.
    @MainActor
    private func scrollTo(_ element: XCUIElement, in app: XCUIApplication) -> Bool {
        _ = element.waitForExistence(timeout: 5)
        for _ in 0..<10 where !(element.exists && element.isHittable) { app.swipeUp() }
        return element.exists && element.isHittable
    }

    /// Taps the tip's "Next".
    @MainActor
    private func tapNext(_ app: XCUIApplication) {
        let next = app.buttons["Next"].firstMatch
        XCTAssertTrue(next.waitForExistence(timeout: 5), "the tip has its Next")
        next.tap()
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
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Next, Apple asks for access. Tap Turn On All, then Allow.")).firstMatch.exists,
                      "the hint above the button says what Apple's sheet asks (Brad 2026-10-25)")
        snap(app, "health hint")
        allow.tap()
        let sheet = XCUIApplication(bundleIdentifier: "com.apple.HealthPrivacyService")
        XCTAssertTrue(sheet.cells["UIA.Health.AuthSheet.AllCategoryButton"].waitForExistence(timeout: 10), "Apple's Health sheet appears")
        XCTAssertTrue(sheet.switches["UIA.Health.Read.Sex.SwitchCell.Switch"].exists, "it asks to read sex")
        XCTAssertTrue(sheet.switches["UIA.Health.Read.DateofBirth.SwitchCell.Switch"].exists, "and date of birth")
        XCTAssertTrue(sheet.switches["UIA.Health.Read.Weight.SwitchCell.Switch"].exists, "and weight")
        snap(app, "health sheet")
    }

    /// US-56 AC4, AC5: onboarding asked for nothing ("Not now"); My data's access card asks
    /// Apple's sheet to read exactly the five live types, and none of onboarding's six.
    /// Answering the sheet is checked by hand, as AC3's is.
    @MainActor
    func testTheAccessCardAsksForOnlyTheFiveLiveTypes_US56_AC4() throws {
        let app = launch()
        try answerUpToWeight(app)
        answerWeight(app)
        XCTAssertTrue(app.tabBars.buttons["My data"].waitForExistence(timeout: 10))
        app.tabBars.buttons["My data"].tap()
        let show = app.buttons["Show from Apple Health"]
        XCTAssertTrue(scrollTo(show, in: app), "the access card shows in Vitals before access")
        XCTAssertTrue(app.staticTexts["Heart, sleep and fitness"].exists)
        snap(app, "us56 access card")
        show.tap()
        let sheet = XCUIApplication(bundleIdentifier: "com.apple.HealthPrivacyService")
        XCTAssertTrue(sheet.cells["UIA.Health.AuthSheet.AllCategoryButton"].waitForExistence(timeout: 10), "Apple's Health sheet appears")
        snap(app, "us56 health sheet")
        let asked = sheet.switches.allElementsBoundByIndex.map(\.identifier).filter { $0.hasPrefix("UIA.Health.Read.") }.sorted()
        XCTAssertEqual(asked, ["CardioFitness", "HeartRate", "RestingHeartRate", "Sleep", "Steps"].map { "UIA.Health.Read.\($0).SwitchCell.Switch" },
                       "only the five live types are read")
        XCTAssertTrue(sheet.switches.allElementsBoundByIndex.allSatisfy { !$0.identifier.hasPrefix("UIA.Health.Write.") }, "nothing is written")
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
