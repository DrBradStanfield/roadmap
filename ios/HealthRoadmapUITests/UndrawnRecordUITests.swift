import XCTest

/// US-11 (lead H114): when My health cannot draw the record, Settings (Export, Delete all my data)
/// and Sync (Disconnect) can still be reached from the "could not be opened" page. Runs on the demo
/// record (`--demo-record`, DEBUG only); `--unreadable-record` (DEBUG only, DemoRecord.swift) writes a
/// newer app's file in its own folder, so the record cannot be opened and nothing real is touched.
final class UndrawnRecordUITests: XCTestCase {
    @MainActor
    func testDeleteAndSyncReachWhenTheRecordCannotBeOpened_US11_H114() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = ["--demo-record", "--ui-testing", "--unreadable-record"]
        app.launch()

        XCTAssertTrue(app.staticTexts["Your record could not be opened"].waitForExistence(timeout: 15), "the page for a record that cannot be opened")

        let settings = app.buttons["Settings"].firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5), "Settings on the page")
        settings.tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5), "the settings sheet")
        XCTAssertTrue(app.staticTexts["Your record could not be opened"].firstMatch.waitForExistence(timeout: 5), "the sheet says why")
        let delete = app.buttons["Delete all my data"].firstMatch
        XCTAssertTrue(delete.waitForExistence(timeout: 5), "Delete all my data in Settings")
        XCTAssertTrue(app.buttons["Export my record"].firstMatch.exists, "Export my record: the file is still held")
        delete.tap()
        let erasePage = app.navigationBars["Delete all my data"]
        XCTAssertTrue(erasePage.waitForExistence(timeout: 5), "Delete opens the same erase page")
        XCTAssertTrue(app.buttons["Delete everything"].firstMatch.exists, "its button")
        erasePage.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Settings"].waitForExistence(timeout: 5), "back to Settings")
        app.navigationBars["Settings"].buttons["Done"].tap()

        let sync = app.buttons["Sync"].firstMatch
        XCTAssertTrue(sync.waitForExistence(timeout: 5), "Sync on the page")
        sync.tap()
        XCTAssertTrue(app.navigationBars["Sync"].waitForExistence(timeout: 5), "the Sync sheet, where Disconnect sits")
    }
}
