import XCTest

/// The App Store screenshots' raw captures (US-25 AC10, ios/app-store.md step 6): My health by
/// topic, a lab report being read, a step opened to its evidence, Weight's page and Sync, from
/// the sample record. Chat's comes from Brad's iPhone (the simulator cannot reach the chat
/// server); the simulator's Chat tab gives it the current tab bar.
/// Opt-in: ios/scripts/app-store-shots.sh seeds the record, puts a photo in the library,
/// holds the lab read open and sets TEST_RUNNER_APP_STORE_SHOTS; any other run skips.
/// ios/scripts/app-store-compose.swift then frames each one.
final class AppStoreScreenshots: XCTestCase {
    @MainActor
    func testTakeTheAppStoreScreenshots() throws {
        guard ProcessInfo.processInfo.environment["APP_STORE_SHOTS"] == "1" else {
            throw XCTSkip("Run by ios/scripts/app-store-shots.sh, which seeds the sample record.")
        }
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        // The script's hold listener, never a dev server on 3000 (adversary R5).
        app.launchEnvironment["HEALTH_ROADMAP_SERVER"] = "http://127.0.0.1:3101"
        app.launch()

        let tabs = app.tabBars
        XCTAssertTrue(tabs.buttons["My health"].waitForExistence(timeout: 15), "the seeded record opens on the tabs, not onboarding")

        // My health at the top (US-73): the topics, Weight & diabetes first, its values then its steps.
        let weightTopic = app.staticTexts["Weight & diabetes"]
        XCTAssertTrue(weightTopic.waitForExistence(timeout: 10), "the Weight & diabetes heading")
        sleep(2) // the page is built once its series are read
        shoot(app, "1 my health")
        // The call-out: Weight & diabetes, its values and its first step.
        let steps = app.buttons.matching(identifier: "plan.suggestion")
        crop("1", top: weightTopic.frame.minY - 12, bottom: steps.firstMatch.frame.maxY + 8)

        // A row's page: Weight, its chart of the six weights.
        func row(_ name: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch }
        row("Weight, ").tap()
        XCTAssertTrue(app.navigationBars["Weight"].waitForExistence(timeout: 5), "the Weight page")
        let showAll = app.buttons["Show All Data"]
        XCTAssertTrue(showAll.waitForExistence(timeout: 5), "the Weight page's chart")
        sleep(1)
        shoot(app, "4 weight history")
        // The call-out: the chart's card, its section gap above Show All Data left out.
        crop("4", top: app.navigationBars["Weight"].frame.maxY + 4, bottom: showAll.frame.minY - 30)
        app.navigationBars["Weight"].buttons.firstMatch.tap()
        XCTAssertTrue(weightTopic.waitForExistence(timeout: 5), "back on My health")

        // A step opened to its evidence: the protein target, under Weight & diabetes.
        let card = app.buttons.matching(NSPredicate(format: "identifier == 'plan.suggestion' AND label BEGINSWITH 'Daily protein'")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5), "the protein step")
        scrollUntil(app, card, isAbove: 0.25)
        card.tap()
        let why = app.staticTexts["Why this suggestion?"].firstMatch
        XCTAssertTrue(why.waitForExistence(timeout: 5), "the opened step's reason")
        scrollUntil(app, why, isAbove: 0.36) // so the step's title stays in view above it
        shoot(app, "3 card opened")
        // The call-out: the reason and its citations, down to the next step, above the tab bar.
        let next = steps.allElementsBoundByIndex.map(\.frame.minY).filter { $0 > why.frame.maxY }.min() ?? .infinity
        crop("3", top: why.frame.minY - 14, bottom: min(next - 18, app.tabBars.firstMatch.frame.minY - 8))
        card.tap()

        // Sync, from the title line at the top.
        for _ in 0..<6 { app.swipeDown() }
        app.buttons["Sync"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Sync"].waitForExistence(timeout: 5), "the Sync screen")
        shoot(app, "6 sync")
        app.navigationBars["Sync"].buttons["Done"].tap()

        // Chat, for its tab bar only: the Chat slot's drop-in and the video's Chat clip were filmed on
        // an iPhone before My health, and take this tab bar in place of theirs (app-store-drop-in.swift).
        tabs.buttons["Chat"].tap()
        let agreeChat = app.buttons["Agree and continue"]
        if agreeChat.waitForExistence(timeout: 5) { agreeChat.tap() }
        sleep(2)
        shoot(app, "5 chat tab bar")
        tabs.buttons["My health"].tap()
        XCTAssertTrue(weightTopic.waitForExistence(timeout: 5), "back on My health")

        // Add medical records: the photo the script added, consent, then the reading screen.
        // The script's listener on the Mac holds the send open, so the read stays on screen;
        // nothing answers it and the review is not reached.
        app.buttons["Add medical records"].firstMatch.tap()
        let photos = app.buttons["labSource.photos"]
        XCTAssertTrue(photos.waitForExistence(timeout: 5), "Photos is offered")
        photos.tap()
        // Apple's picker runs in its own process: tap the grid's first photo, the one added last.
        XCTAssertTrue(app.buttons["Collections"].waitForExistence(timeout: 15) || app.staticTexts["Collections"].exists, "the photo picker")
        sleep(2)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.16, dy: 0.43)).tap()
        let agree = app.buttons["Agree and continue"]
        if agree.waitForExistence(timeout: 10) { agree.tap() }
        XCTAssertTrue(app.staticTexts["Reading the values in Photo"].waitForExistence(timeout: 15), "the reading screen")
        sleep(5) // the progress bar fills a little
        shoot(app, "2 lab reading")

        // Where each call-out sits on its screen, for app-store-compose.swift.
        let json = try JSONSerialization.data(withJSONObject: crops, options: [.sortedKeys])
        let attachment = XCTAttachment(data: json, uniformTypeIdentifier: "public.json")
        attachment.name = "crops"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    /// Call-out crops by slot, in the capture's pixels: x, y, width, height.
    private var crops: [String: [Double]] = [:]

    /// Keeps a full-width card band from `top` to `bottom` (points) as a slot's call-out.
    /// The cards sit 16 points in from each edge.
    @MainActor
    private func crop(_ slot: String, top: CGFloat, bottom: CGFloat) {
        let scale = Double(XCUIScreen.main.screenshot().image.scale), width = Double(XCUIApplication().frame.width)
        crops[slot] = [16 * scale, Double(top) * scale, (width - 32) * scale, Double(bottom - top) * scale]
    }

    /// Scrolls slowly, either way, until `element`'s top is near `fraction` of the screen height.
    /// A drag moves the content less than the finger by the touch slop: each drag measures it
    /// and the next one adds it back, so short corrections land too.
    @MainActor
    private func scrollUntil(_ app: XCUIApplication, _ element: XCUIElement, isAbove fraction: Double) {
        let target = app.frame.height * fraction
        var slop: CGFloat = 0
        for _ in 0..<8 {
            sleep(1) // the plan lays out its cards as they come: measure once it has settled
            let before = element.frame.minY
            let gap = before - target
            if abs(gap) < 8 { return }
            let want = max(min(gap, app.frame.height * 0.35), -app.frame.height * 0.35)
            let request = 0.85 * want + (want > 0 ? slop : -slop)
            let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            middle.withOffset(CGVector(dx: 0, dy: request / 2))
                .press(forDuration: 0.1, thenDragTo: middle.withOffset(CGVector(dx: 0, dy: -request / 2)),
                       withVelocity: XCUIGestureVelocity(300), thenHoldForDuration: 0.5)
            sleep(1)
            let moved = before - element.frame.minY
            slop = min(max(abs(request) - abs(moved), 0), 40)
        }
    }

    @MainActor
    private func shoot(_ app: XCUIApplication, _ name: String) {
        sleep(1) // let animations settle
        keepScreenshot(XCUIScreen.main.screenshot(), named: name)
    }
}
