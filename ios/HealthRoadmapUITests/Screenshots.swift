import XCTest

extension XCTestCase {
    /// Keeps a screenshot in the test result, for checking screens by eye (and the
    /// App Store pictures, ios/scripts/app-store-shots.sh).
    func keepScreenshot(_ screenshot: XCUIScreenshot, named name: String) {
        let shot = XCTAttachment(screenshot: screenshot)
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }
}
