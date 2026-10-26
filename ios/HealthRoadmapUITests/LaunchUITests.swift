import XCTest

/// The opening on screen (US-25 AC21b, Brad 2026-10-26): a new user goes from the plain
/// launch background straight to the welcome screen, on the same background, never past
/// an empty My data. XCUITest cannot see single frames, so this checks what it can see
/// reliably: the welcome screen is up with My data's tabs covered, and its background is
/// the launch colour. The frame-by-frame check is a screen recording (ios/architecture.md).
final class LaunchUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testANewUserOpensOnTheWelcomeScreenOnTheLaunchBackground_US25_AC21b() throws {
        let app = XCUIApplication()
        // `-welcomed NO` reads as a first launch whatever this simulator ran before, and
        // writes nothing, so the record and the settings stay as they were.
        app.launchArguments = ["--ui-testing", "-welcomed", "NO"]
        app.launch()

        XCTAssertTrue(app.buttons["welcome.start"].waitForExistence(timeout: 10), "the welcome screen is the first screen")
        XCTAssertFalse(app.tabBars.firstMatch.isHittable, "My data's tabs are covered, not shown under the welcome screen")

        // The left margin, halfway down: welcome text keeps 28 points in from the edge.
        let image = try XCTUnwrap(XCUIScreen.main.screenshot().image.cgImage)
        let pixel = try rgb(image, x: image.width / 60, y: image.height / 2)
        // My data's systemGroupedBackground: (242, 242, 247) light, (0, 0, 0) dark.
        let matches = [(242, 242, 247), (0, 0, 0)].contains { abs($0.0 - pixel.0) <= 2 && abs($0.1 - pixel.1) <= 2 && abs($0.2 - pixel.2) <= 2 }
        XCTAssertTrue(matches, "the welcome screen's background is the launch colour, found \(pixel)")
    }

    private func rgb(_ image: CGImage, x: Int, y: Int) throws -> (Int, Int, Int) {
        var pixel = [UInt8](repeating: 0, count: 4)
        let context = try XCTUnwrap(CGContext(data: &pixel, width: 1, height: 1, bitsPerComponent: 8, bytesPerRow: 4,
                                              space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.draw(image, in: CGRect(x: -x, y: y - image.height + 1, width: image.width, height: image.height))
        return (Int(pixel[0]), Int(pixel[1]), Int(pixel[2]))
    }
}
