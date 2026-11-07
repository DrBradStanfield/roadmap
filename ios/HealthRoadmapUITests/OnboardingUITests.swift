import XCTest

/// US-54 on screen: a fresh install goes from the welcome screen through the four
/// questions to My health. Run it on a fresh install (uninstall first): it writes the
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
        XCTAssertTrue(app.tabBars.buttons["My health"].isSelected)
        XCTAssertFalse(app.staticTexts[Self.tourLines[0]].waitForExistence(timeout: 2), "--ui-testing hides the tour (US-57 AC10)")
        snap(app, "7 plan")
        app.terminate()
        let again = launch()
        XCTAssertFalse(again.buttons["welcome.start"].waitForExistence(timeout: 3))
        XCTAssertFalse(again.buttons["onboarding.continue"].exists)
    }

    /// US-73 AC1 (US-25 AC26): My health has no title bar; its title and the Weight & diabetes
    /// heading scroll away with the page.
    @MainActor
    func testMyHealthHasNoTitleBarAndItsHeadingsScroll_US73_AC1() throws {
        let app = launch()
        try answerUpToWeight(app)
        answerWeight(app)

        XCTAssertTrue(app.tabBars.buttons["My health"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.tabBars.buttons["My health"].isSelected, "onboarding ends on My health")
        let heading = app.staticTexts["Weight & diabetes"]
        XCTAssertTrue(heading.waitForExistence(timeout: 10), "the first section's heading")
        XCTAssertFalse(app.navigationBars.firstMatch.exists, "no title bar")
        XCTAssertTrue(app.buttons["Settings"].exists, "the person button")
        snap(app, "my health top")

        let top = heading.frame.minY
        app.swipeUp()
        XCTAssertTrue(!heading.isHittable || heading.frame.minY < top - 40, "the heading scrolled away")
        snap(app, "my health scrolled")
    }

    /// US-57's three tips, word for word (Brad 2026-10-25).
    static let tourLines = [
        "Your numbers, grouped by topic. Tap any row for its history and what it means.",
        "Each step comes with the reason and the evidence. Tap a card to read it.",
        "The more data you add, the more personal your plan. You can upload lab reports to fill these in for you.",
    ]

    /// US-57 (US-73 AC11): after onboarding, the three tips in order on My health, one at a
    /// time, each with "Skip tour", its counter and "Next"; tip 3 brings Blood tests into view
    /// and its "Done" ends the tour for good; a tile's explainer lives on its row's page
    /// (AC1-AC7; Brad 2026-10-25, review R5; US-73 AC9).
    @MainActor
    func testTheTourWalksItsThreeTips_US57() throws {
        let app = launch(tips: true)
        try answerUpToWeight(app)
        answerWeight(app)

        let snapshot = app.staticTexts[Self.tourLines[0]]
        let foundation = app.staticTexts[Self.tourLines[1]]
        let bloodTests = app.staticTexts[Self.tourLines[2]]
        XCTAssertTrue(snapshot.waitForExistence(timeout: 10), "tip 1 shows on My health after onboarding")
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
        snap(app, "tour 2 foundation")
        tapNext(app)

        // Tip 3 brings Blood tests into view: no swipe here.
        XCTAssertTrue(bloodTests.waitForExistence(timeout: 10), "tip 3 shows at Blood tests")
        XCTAssertTrue(app.tabBars.buttons["My health"].isSelected, "the whole tour is on My health")
        XCTAssertTrue(app.staticTexts["Tip 3 of 3"].exists)
        XCTAssertTrue(app.buttons["Add a lab report"].exists, "tip 3 keeps its lab upload")
        snap(app, "tour 3 blood tests")
        let done = app.buttons["Done"].firstMatch
        XCTAssertTrue(done.exists, "the last tip's Next reads Done")
        done.tap()
        XCTAssertTrue(bloodTests.waitForNonExistence(timeout: 5), "Done ends the tour")
        XCTAssertFalse(app.staticTexts["Add medical records"].waitForExistence(timeout: 2), "Done opens nothing")

        // Back at the Blood tests header, on screen: the tour has ended (review R5).
        app.tabBars.buttons["Chat"].tap()
        app.tabBars.buttons["My health"].tap()
        XCTAssertTrue(scrollTo(app.staticTexts["Blood tests"].firstMatch, in: app), "the header tip 3 anchors to is on screen")
        XCTAssertFalse(bloodTests.waitForExistence(timeout: 3), "tip 3 never shows again")

        // A tile's explainer is on its row's page, for good (US-57 AC5, US-73 AC9).
        for _ in 0..<12 where !app.staticTexts["Weight & diabetes"].isHittable { app.swipeDown() }
        let weight = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'Weight,'")).firstMatch
        XCTAssertTrue(weight.waitForExistence(timeout: 5), "the weight row")
        weight.tap()
        let explainer = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'A healthy weight for your height and sex'")).firstMatch
        for _ in 0..<6 where !explainer.exists { app.swipeUp() }
        XCTAssertTrue(explainer.waitForExistence(timeout: 5), "ideal weight's what-it-is, on the weight page")
        snap(app, "tour tile explainer")
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertFalse(snapshot.waitForExistence(timeout: 2), "tip 1 never shows again")
    }

    /// A tap outside a tip only dismisses it and counts as closed, so the tour moves on
    /// without switching tabs (review R2a); tip 3 brings Blood tests into view, and its
    /// action opens the lab upload and ends the tour (AC2, AC7).
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
        // Above any popover; the list scrolls to its top, then tip 3 brings Blood tests back into view.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.08)).tap()
        XCTAssertTrue(foundation.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.tabBars.buttons["My health"].isSelected, "a tap outside never switches tabs")
        XCTAssertTrue(bloodTests.waitForExistence(timeout: 10), "tip 3 shows, scrolled into view")
        XCTAssertFalse(foundation.exists, "tip 2 does not come back: the tour moved on")
        app.buttons["Add a lab report"].tap()
        XCTAssertTrue(app.staticTexts["Add medical records"].waitForExistence(timeout: 5), "the action opens the lab upload")
        snap(app, "tour lab upload")
        app.buttons["Close"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Add medical records"].waitForNonExistence(timeout: 5))
        app.tabBars.buttons["Chat"].tap()
        app.tabBars.buttons["My health"].tap()
        XCTAssertTrue(scrollTo(app.staticTexts["Blood tests"].firstMatch, in: app))
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
        XCTAssertTrue(app.staticTexts["Weight & diabetes"].exists, "Weight & diabetes, where tip 2 anchors, is on screen")
        XCTAssertFalse(app.staticTexts[Self.tourLines[1]].waitForExistence(timeout: 3), "no tip 2")
        XCTAssertTrue(scrollTo(app.staticTexts["Blood tests"].firstMatch, in: app), "the Blood tests header is on screen")
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
        XCTAssertTrue(app.tabBars.buttons["My health"].waitForExistence(timeout: 10))
        let prompt = app.staticTexts["Back up your record"]
        XCTAssertFalse(prompt.waitForExistence(timeout: 3), "onboarding's answers are not the person's saves")
        openSettings(app)
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
        XCTAssertFalse(prompt.waitForExistence(timeout: 3), "never over the settings sheet")
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(prompt.waitForExistence(timeout: 8), "the third own save offers the cloud copy once Settings closes")
        snap(app, "cloud prompt")
        app.buttons["backup.notNow"].tap()
        XCTAssertTrue(prompt.waitForNonExistence(timeout: 5))
        openSettings(app)
        pick(female, in: sex)
        app.buttons["Done"].firstMatch.tap()
        app.tabBars.buttons["Chat"].tap()
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

    /// Opens the settings sheet behind My health's person button (US-73 AC1).
    @MainActor
    private func openSettings(_ app: XCUIApplication) {
        let settings = app.buttons["Settings"].firstMatch
        for _ in 0..<12 where !settings.isHittable { app.swipeDown() }
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5), "the settings sheet")
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

    /// The plan follows an edit made in Settings (US-25 AC6): My health plans again and never
    /// shows the older plan.
    @MainActor
    func testThePlanFollowsAnEditMadeInSettings_US25_AC6() throws {
        let app = launch()
        try answerUpToWeight(app)
        answerWeight(app)
        let cervical = app.staticTexts["Cervical"]
        XCTAssertTrue(scrollTo(cervical, in: app), "a woman's plan asks about cervical screening")
        openSettings(app)
        let male = app.buttons["Male"].firstMatch
        XCTAssertTrue(male.waitForExistence(timeout: 5))
        male.tap()
        app.buttons["Done"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Cancer screening"].waitForExistence(timeout: 10) || app.staticTexts["Weight & diabetes"].waitForExistence(timeout: 5))
        XCTAssertFalse(cervical.waitForExistence(timeout: 3), "the plan was worked out again for a man")
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
        XCTAssertTrue(app.tabBars.buttons["My health"].waitForExistence(timeout: 10))
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
        XCTAssertTrue(app.tabBars.buttons["My health"].waitForExistence(timeout: 10))

        // The weight row reads as one combined label ("Weight, …, 69.9, kg"), so match the number.
        let saved = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", metricRecord ? "69.9" : "154")).firstMatch
        XCTAssertTrue(saved.waitForExistence(timeout: 10), "the weight is saved as the right weight, in the record's units")
        openSettings(app)
        let us = app.buttons["US"]
        var tries = 0
        while !us.isHittable && tries < 15 { app.swipeUp(); tries += 1 }
        XCTAssertEqual(us.isSelected, !metricRecord, "the record's units are unchanged")
        snap(app, "units unchanged")
    }

    /// The read switches Apple's sheet lists, scrolled through: it draws only the rows on screen.
    @MainActor private func readSwitches(_ sheet: XCUIApplication) -> [String] {
        var seen = Set<String>()
        for _ in 0..<6 {
            let before = seen.count
            seen.formUnion(sheet.switches.allElementsBoundByIndex.map { $0.identifier }.filter { $0.hasPrefix("UIA.Health.Read.") })
            if seen.count == before, before > 0 { break }
            sheet.swipeUp()
        }
        return seen.map { $0.replacingOccurrences(of: "UIA.Health.Read.", with: "").replacingOccurrences(of: ".SwitchCell.Switch", with: "") }.sorted()
    }

    /// Everything the app reads, in one sheet (US-54 AC3, US-56 AC4, Brad 2026-10-26); no heart
    /// rate since its card went (US-73).
    private let everything = ["BloodPressure", "CardioFitness", "DateofBirth", "Height", "RestingHeartRate", "Sex", "Sleep", "Steps", "WaistCircumference", "Weight"]

    /// "Connect Apple Health" shows Apple's Health sheet once, asking for everything the app
    /// reads: onboarding's record types and US-56's five (AC3, US-56 AC4). The sheet runs in
    /// Apple's own process; Allow is checked by hand. On iOS 27 the sheet goes on with its own
    /// Continue and a choice of how much history to share. Don't Allow is tapped at its screen
    /// point in `testAfterDontAllowTheRowSaysOpenSettings_US56_AC5c`.
    @MainActor
    func testAllowShowsOneSheetAskingForEverything_AC3_US56_AC4() throws {
        let app = launch()
        let start = app.buttons["welcome.start"]
        XCTAssertTrue(start.waitForExistence(timeout: 10))
        start.tap()
        let allow = app.buttons["onboarding.allow"]
        XCTAssertTrue(allow.waitForExistence(timeout: 5))
        XCTAssertTrue(app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "Next, Apple asks for access. Turn everything on, then tap Allow.")).firstMatch.exists,
                      "the hint above the button says what Apple's sheet asks (Brad 2026-10-25)")
        XCTAssertTrue(app.staticTexts["It also shows your resting heart rate, sleep, VO2 max and steps here, never in your record."].exists,
                      "the page names US-56's five too (adversary R5)")
        snap(app, "health hint")
        allow.tap()
        let sheet = XCUIApplication(bundleIdentifier: "com.apple.HealthPrivacyService")
        XCTAssertTrue(sheet.cells["UIA.Health.AuthSheet.AllCategoryButton"].waitForExistence(timeout: 20), "Apple's Health sheet appears")
        snap(app, "health sheet")
        XCTAssertEqual(readSwitches(sheet), everything, "one sheet: the record's types and the five live ones")
    }

    /// US-56 AC4, AC5 (2026-10-26): no access card and no second way in. After onboarding's
    /// "Not now", My health shows no Turn On row; Settings' own "Connect Apple Health" row runs
    /// the same one request, for everything.
    @MainActor
    func testAfterNotNowMyDataConnectAsksForEverythingInOneSheet_US56_AC4_AC5() throws {
        let app = launch()
        try answerUpToWeight(app)
        answerWeight(app)
        XCTAssertTrue(app.tabBars.buttons["My health"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Turn On"].exists, "no Turn On row while not connected")
        openSettings(app)
        let connect = app.buttons["Connect Apple Health"]
        XCTAssertTrue(scrollTo(connect, in: app), "Settings' Apple Health row")
        XCTAssertFalse(app.buttons["Show from Apple Health"].exists, "no access card")
        snap(app, "us56 my data connect")
        connect.tap()
        let sheet = XCUIApplication(bundleIdentifier: "com.apple.HealthPrivacyService")
        XCTAssertTrue(sheet.cells["UIA.Health.AuthSheet.AllCategoryButton"].waitForExistence(timeout: 20), "Apple's Health sheet appears")
        snap(app, "us56 health sheet")
        XCTAssertEqual(readSwitches(sheet), everything, "the same single request")
    }

    /// US-56 AC5c (Brad 2026-11-01): after "Don't Allow", Vitals' row says "Open Settings"
    /// and where Apple Health's settings are, and the button opens Settings. Apple's sheet runs
    /// in its own process; its buttons are tapped at the screen points they report. Run it on a
    /// fresh install: once answered, iOS never shows the sheet again.
    @MainActor
    func testAfterDontAllowTheRowSaysOpenSettings_US56_AC5c() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "-welcomed", "YES", "-onboarded", "YES"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["My health"].waitForExistence(timeout: 60))
        openSettings(app)
        let connect = app.buttons["Connect Apple Health"]
        XCTAssertTrue(scrollTo(connect, in: app), "Settings' Apple Health row")
        let sheet = XCUIApplication(bundleIdentifier: "com.apple.HealthPrivacyService")
        let all = sheet.cells["UIA.Health.AuthSheet.AllCategoryButton"]
        // Under load a tap during the scroll's last frames is lost: tap again until the sheet shows.
        for _ in 0..<3 where !all.exists {
            connect.tap()
            _ = all.waitForExistence(timeout: 40)
        }
        XCTAssertTrue(all.exists, "Apple's Health sheet appears")
        let dontAllow = sheet.buttons["Don’t Allow"].firstMatch
        for _ in 0..<8 where !dontAllow.isHittable { sheet.swipeUp() }
        tap(dontAllow, in: sheet)
        // Apple then says access can be turned on later; its OK closes the sheet.
        let ok = sheet.buttons["OK"].firstMatch
        XCTAssertTrue(ok.waitForExistence(timeout: 30), "Apple's note after Don't Allow")
        tap(ok, in: sheet)
        app.activate()
        app.buttons["Done"].firstMatch.tap()

        // The row is under Fitness; the list draws only the rows near the screen.
        let open = app.buttons["Open Settings"]
        for _ in 0..<12 where !open.waitForExistence(timeout: 5) { app.swipeUp() }
        XCTAssertTrue(open.waitForExistence(timeout: 30), "the row says Open Settings")
        XCTAssertFalse(app.buttons["Reconnect"].exists, "never Reconnect")
        // iOS 18 moved Health under Settings › Apps; the app runs from iOS 17.
        let apps = (Int(UIDevice.current.systemVersion.split(separator: ".").first ?? "") ?? 0) >= 18 ? "Apps › " : ""
        let line = "Resting heart rate, sleep, VO2 max and steps can show here from Apple Health. The Apple Health settings for this app are in Settings › \(apps)Health › Data Access & Devices › Health Roadmap."
        XCTAssertTrue(app.staticTexts.matching(NSPredicate(format: "label == %@", line)).firstMatch.exists,
                      "the row's words and where Apple Health's settings are, read as one")
        snap(app, "us56 open settings row")
        // Under load Settings can take over a minute to launch, and a tap can be lost: tap again.
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        for _ in 0..<3 where settings.state != .runningForeground {
            if open.exists, open.isHittable { open.tap() }
            _ = settings.wait(for: .runningForeground, timeout: 90)
        }
        XCTAssertEqual(settings.state, .runningForeground, "Settings opens")
    }

    /// Taps a button of Apple's sheet at the screen point it reports: its own `tap` fails there.
    @MainActor
    private func tap(_ button: XCUIElement, in sheet: XCUIApplication) {
        let frame = button.frame
        sheet.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
    }

    /// "Delete all my data" brings the questions back, not the welcome screen (AC7).
    @MainActor
    func testDeletingAllMyDataStartsTheQuestionsAgain_AC7() throws {
        let app = launch()
        try answerUpToWeight(app)
        answerWeight(app)
        openSettings(app)
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

    /// Quitting at the weight question resumes there, not on My health (AC7).
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
