import XCTest

/// US-25 AC16d (iOS survey S1): the Settings sheet cannot be swiped shut while an erase runs.
/// Runs on the demo record (`--demo-record`, DEBUG only), never a real one; `--slow-erase`
/// (DEBUG only, DemoRecord.swift) holds the erase 4 s so the swipe lands mid-erase.
final class EraseSheetUITests: XCTestCase {
    @MainActor
    func testTheSettingsSheetHoldsWhileAnEraseRuns_US25_AC16d() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--demo-record", "--ui-testing", "--slow-erase"]
        app.launch()

        let settings = app.buttons["Settings"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 15), "My health, not onboarding")
        for _ in 0..<12 where !settings.isHittable { app.swipeDown() }
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5), "the settings sheet")

        let delete = app.buttons["Delete all my data"].firstMatch
        _ = delete.waitForExistence(timeout: 5)
        for _ in 0..<12 where !(delete.exists && delete.isHittable) { app.swipeUp() }
        delete.tap()
        let page = app.navigationBars["Delete all my data"]
        XCTAssertTrue(page.waitForExistence(timeout: 5), "the erase page")
        app.buttons["Delete everything"].firstMatch.tap()
        let confirm = app.alerts["Delete everything?"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 5), "iOS's alert")
        confirm.buttons["Delete everything"].tap()

        // Mid-erase: a hard swipe down from the sheet's top edge.
        let top = page.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        top.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.98)))
        sleep(1)
        XCTAssertTrue(page.exists, "the sheet is still up mid-erase")
        XCTAssertTrue(app.alerts["Delete all my data"].waitForExistence(timeout: 15), "the erase's words show on its page")
    }
}
