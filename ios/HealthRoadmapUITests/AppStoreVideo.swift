import XCTest

/// The App Store preview video's flow (US-25 AC10, ios/scripts/app-store-video.sh): My data, a lab report
/// added from Photos and read, its values checked and saved, My plan, one step opened to its
/// evidence. Paced for a camera, not for speed. Each story beat prints a "VIDEO-MARK" line with
/// the wall-clock time, so the script can cut the screen recording at the right moments.
/// Opt-in: the script seeds the sample record, adds the fictional report to Photos, runs the
/// local lab reader and sets TEST_RUNNER_APP_STORE_VIDEO; any other run skips.
final class AppStoreVideo: XCTestCase {
    @MainActor
    func testRecordTheAppStoreVideoFlow() throws {
        guard ProcessInfo.processInfo.environment["APP_STORE_VIDEO"] == "1" else {
            throw XCTSkip("Run by ios/scripts/app-store-video.sh, which seeds the record and the report.")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        // The local lab reader (app-store-video-lab-server.mts); a DEBUG build only.
        app.launchEnvironment["HEALTH_ROADMAP_SERVER"] = "http://127.0.0.1:3100"
        app.launch()

        let tabs = app.tabBars
        XCTAssertTrue(tabs.buttons["My data"].waitForExistence(timeout: 15), "the seeded record opens on the tabs")
        tabs.buttons["My data"].tap()
        pause(1.5)
        mark("mydata")
        pause(3.0)
        scroll(app, 0.22, velocity: 220)
        pause(1.5)
        scroll(app, -0.22, velocity: 220)
        pause(1.0)

        // The report, from Photos: the newest picture is the fictional report the script added.
        let add = app.buttons["Add medical records"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 5), "Add medical records")
        mark("add")
        add.tap()
        let photos = app.buttons["labSource.photos"]
        XCTAssertTrue(photos.waitForExistence(timeout: 5), "the Photos source")
        pause(1.5)
        photos.tap()
        pickNewestPhoto(app)

        let agree = app.buttons["Agree and continue"]
        if agree.waitForExistence(timeout: 10) {
            mark("consent")
            pause(1.0)
            agree.tap()
        }
        mark("reading")
        // The review: its list is lazy, so Save exists only once scrolled to.
        XCTAssertTrue(app.staticTexts["Values found"].waitForExistence(timeout: 120) || app.staticTexts["VALUES FOUND"].exists,
                      "the review's values: the report was read")
        mark("review")
        pause(2.5)
        let save = app.buttons.matching(NSPredicate(format: "label MATCHES 'Save [0-9]+ values?'")).firstMatch
        for _ in 0..<4 where !(save.exists && save.isHittable) {
            scroll(app, 0.3, velocity: 260)
            pause(1.0)
        }
        XCTAssertTrue(save.isHittable, "the review's Save button")
        pause(1.0)
        mark("save")
        save.tap()
        XCTAssertTrue(app.staticTexts["Saved"].waitForExistence(timeout: 30) || app.staticTexts["SAVED"].exists, "saved")
        pause(0.6)
        mark("saved")
        let done = app.buttons["Done"]
        for _ in 0..<3 where !(done.exists && done.isHittable) {
            scroll(app, 0.3, velocity: 260)
            pause(0.8)
        }
        XCTAssertTrue(done.isHittable, "the review offers Done")
        pause(1.2)
        done.tap()
        // Back on My data: the blood tests the report filled in.
        pause(1.0)
        mark("after")
        pause(1.5)
        scroll(app, 0.3, velocity: 220)
        pause(2.5)

        tabs.buttons["My plan"].tap()
        mark("plan")
        XCTAssertTrue(app.staticTexts["Next Steps"].waitForExistence(timeout: 10) || app.staticTexts["Requires Attention"].waitForExistence(timeout: 5))
        pause(2.5)
        scroll(app, 0.35, velocity: 240)
        pause(2.0)

        let card = app.buttons.matching(identifier: "plan.suggestion").firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 5), "a suggestion card")
        if !card.isHittable { scroll(app, 0.2, velocity: 240) }
        mark("open")
        card.tap()
        pause(2.0)
        scroll(app, 0.35, velocity: 220)
        mark("evidence")
        pause(3.0)
        scroll(app, 0.25, velocity: 220)
        pause(3.0)
        mark("end")
    }

    /// The Photos picker runs outside the app; its newest picture, top left, is the report.
    @MainActor
    private func pickNewestPhoto(_ app: XCUIApplication) {
        let picture = app.scrollViews.images.firstMatch
        XCTAssertTrue(picture.waitForExistence(timeout: 10), "the Photos picker")
        pause(1.5)
        // Thumbnails only: the "Private Access to Photos" note above them has a small icon.
        let pictures = app.scrollViews.images.allElementsBoundByIndex.filter { $0.isHittable && $0.frame.width > 80 }
        let newest = pictures.min { ($0.frame.minY, $0.frame.minX) < ($1.frame.minY, $1.frame.minX) } ?? picture
        newest.tap()
        let addButton = app.buttons["Add"]
        if addButton.waitForExistence(timeout: 2) { addButton.tap() }
    }

    private func mark(_ name: String) {
        print("VIDEO-MARK \(name) \(Date().timeIntervalSince1970)")
    }

    private func pause(_ seconds: Double) {
        Thread.sleep(forTimeInterval: seconds)
    }

    /// Scrolls the content up by `fraction` of the screen (down when negative), at a steady
    /// `velocity` in points per second, so the camera sees a glide, not a fling.
    @MainActor
    private func scroll(_ app: XCUIApplication, _ fraction: Double, velocity: CGFloat) {
        let start = fraction > 0 ? 0.75 : 0.35
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: start))
        let to = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: start - fraction))
        from.press(forDuration: 0.05, thenDragTo: to, withVelocity: XCUIGestureVelocity(velocity), thenHoldForDuration: 0.4)
    }
}
