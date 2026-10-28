import XCTest

/// The App Store screenshots' raw captures (US-25 AC10, ios/app-store.md step 6): My plan,
/// a lab report being read, an opened card, My data and Sync, from the sample record.
/// Chat's comes from Brad's iPhone (the simulator cannot reach the chat server).
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
        XCTAssertTrue(tabs.buttons["My data"].waitForExistence(timeout: 15), "the seeded record opens on the tabs, not onboarding")

        // My plan, scrolled until Next Steps sits just below the title bar: its first cards show whole.
        tabs.buttons["My plan"].tap()
        let nextSteps = app.staticTexts["Next Steps"]
        XCTAssertTrue(nextSteps.waitForExistence(timeout: 10), "the Next Steps heading")
        scrollUntil(app, nextSteps, isAbove: 0.18)
        shoot(app, "1 my plan")
        // The call-out: Next Steps and its first card, down to the line under the card's second step.
        let steps = app.buttons.matching(identifier: "plan.suggestion")
        crop("1", top: nextSteps.frame.minY - 12, bottom: steps.element(boundBy: 1).frame.maxY + 16)

        // The first suggestion, opened, by its identifier: the summary tiles above are buttons too.
        let card = app.buttons.matching(identifier: "plan.suggestion").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5), "a suggestion card")
        card.tap()
        let why = app.staticTexts["Why this suggestion?"].firstMatch
        XCTAssertTrue(why.waitForExistence(timeout: 5), "the opened card's reason")
        scrollUntil(app, why, isAbove: 0.36) // so the card's title stays in view below the bar
        shoot(app, "3 card opened")
        // The call-out: the reason and its citations, down to the next step's divider.
        crop("3", top: why.frame.minY - 14, bottom: steps.element(boundBy: 1).frame.minY - 18)
        card.tap()

        // My data at the top: the vitals, then the blood tests with their values.
        tabs.buttons["My data"].tap()
        for _ in 0..<3 { app.swipeDown() }
        XCTAssertTrue(app.staticTexts["Weight"].firstMatch.waitForExistence(timeout: 5), "the Weight row")
        shoot(app, "4 my data")
        // The call-out: the first three blood tests (each row reads as one element).
        func row(_ name: String) -> XCUIElement { app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", name)).firstMatch }
        crop("4", top: row("HbA1c").frame.minY - 10, bottom: row("ApoB").frame.maxY + 7)

        // Sync, from the Vitals line.
        app.buttons["Sync"].firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Sync"].waitForExistence(timeout: 5), "the Sync screen")
        shoot(app, "6 sync")
        app.navigationBars["Sync"].buttons["Done"].tap()

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
