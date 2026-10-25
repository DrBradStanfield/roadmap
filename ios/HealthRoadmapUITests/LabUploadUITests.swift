import XCTest

/// US-52 AC10 on screen: "+" offers Files first, then Photos and Scan, and no Dropbox or
/// Google Drive list (Brad 2026-10-25). Starts past onboarding with an empty record:
/// the flags go in the launch arguments' defaults, never into the app's settings.
final class LabUploadUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testThePlusSheetOffersFilesThenPhotosThenScan_US52_AC10() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "-welcomed", "YES", "-onboarded", "YES"]
        app.launch()

        let myData = app.tabBars.buttons["My data"]
        XCTAssertTrue(myData.waitForExistence(timeout: 15), "the tabs, not onboarding")
        myData.tap()
        app.buttons["Add medical records"].firstMatch.tap()
        XCTAssertTrue(app.staticTexts["Where are your medical records?"].waitForExistence(timeout: 5)
                      || app.staticTexts["WHERE ARE YOUR MEDICAL RECORDS?"].exists, "the sheet's sources")

        let files = app.buttons["labSource.files"]
        let photos = app.buttons["labSource.photos"]
        XCTAssertTrue(files.waitForExistence(timeout: 5), "Files is offered")
        XCTAssertTrue(photos.exists, "Photos is offered")
        XCTAssertLessThan(files.frame.minY, photos.frame.minY, "Files comes first")
        // The document camera exists only on a real phone; where it shows, it comes last.
        let scan = app.buttons["labSource.scan"]
        if scan.exists { XCTAssertLessThan(photos.frame.minY, scan.frame.minY, "Scan comes after Photos") }
        XCTAssertTrue(app.staticTexts["Files reaches Dropbox, Google Drive and iCloud Drive when their apps are on this iPhone. The app gets only the file you pick."].exists,
                      "the sheet says what Files reaches")
        for gone in ["From Dropbox", "From Google Drive"] {
            XCTAssertFalse(app.staticTexts[gone].exists, "\(gone) is gone")
            XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", gone)).firstMatch.exists, "\(gone) is gone")
        }
        keepScreenshot(app.screenshot(), named: "lab upload sheet")
    }
}
