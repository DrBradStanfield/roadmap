import XCTest

/// US-52 AC6c on screen: the keyboard goes down after Send and when the conversation is
/// dragged down, so the tab bar is back (Brad 2026-10-28, "the keyboard never goes away").
/// Needs the simulator's software keyboard: with "Connect Hardware Keyboard" on, none
/// shows and the test fails at its first check rather than passing on nothing.
/// Sending reaches the real chat server; the checks hold whatever it answers.
final class ChatKeyboardUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    private func openChat() -> (XCUIApplication, XCUIElement) {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "-welcomed", "YES", "-onboarded", "YES"]
        app.launch()
        let chat = app.tabBars.buttons["Chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 15), "the tabs, not onboarding")
        chat.tap()
        let agree = app.buttons["Agree and continue"]
        if agree.waitForExistence(timeout: 3) { agree.tap() }
        let field = app.textViews["Ask a question"].exists ? app.textViews["Ask a question"] : app.textFields["Ask a question"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), "the question box")
        return (app, field)
    }

    @MainActor
    private func type(_ text: String, into field: XCUIElement, of app: XCUIApplication) {
        let myData = app.tabBars.buttons["My data"].frame
        field.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5),
                      "the software keyboard shows (turn off Connect Hardware Keyboard)")
        field.typeText(text)
        // The keyboard can report a frame below the screen for a moment after typing:
        // wait until it sits on screen, so the checks below test a keyboard that is there.
        let onScreen = NSPredicate { _, _ in
            let keyboard = app.keyboards.firstMatch.frame
            return keyboard.minY < app.frame.maxY - 100 && keyboard.maxY <= app.frame.maxY + 1
        }
        XCTAssertEqual(XCTWaiter.wait(for: [XCTNSPredicateExpectation(predicate: onScreen, object: nil)], timeout: 10), .completed,
                       "the keyboard is on screen: \(app.keyboards.firstMatch.frame)")
        // isHittable ignores the keyboard's window, so the check is a tap: where My data
        // was, the keyboard takes it.
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: myData.midX, dy: myData.midY)).tap()
        XCTAssertFalse(app.buttons["Add medical records"].firstMatch.waitForExistence(timeout: 2), "the keyboard covers the tab bar: My data did not open")
        XCTAssertTrue(app.keyboards.firstMatch.exists, "the keyboard is still up")
        keepScreenshot(app.screenshot(), named: "keyboard up")
    }

    @MainActor
    private func assertKeyboardDownAndTabsBack(_ app: XCUIApplication) {
        let gone = NSPredicate(format: "count == 0")
        let wait = XCTNSPredicateExpectation(predicate: gone, object: app.keyboards)
        XCTAssertEqual(XCTWaiter.wait(for: [wait], timeout: 5), .completed, "the keyboard went down")
        XCTAssertTrue(app.tabBars.buttons["My data"].isHittable, "My data is one tap away")
        XCTAssertTrue(app.tabBars.buttons["My plan"].isHittable, "My plan is one tap away")
        app.tabBars.buttons["My data"].tap()
        XCTAssertTrue(app.buttons["Add medical records"].firstMatch.waitForExistence(timeout: 5), "one tap opens My data")
    }

    @MainActor
    func testSendingLowersTheKeyboard_US52_AC6c() throws {
        let (app, field) = openChat()
        type("What is a normal resting heart rate?", into: field, of: app)
        app.buttons["Send"].tap()
        assertKeyboardDownAndTabsBack(app)
        keepScreenshot(app.screenshot(), named: "after send")
    }

    @MainActor
    func testDraggingTheConversationLowersTheKeyboard_US52_AC6c() throws {
        let (app, field) = openChat()
        type("Still typing", into: field, of: app)
        let top = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.25))
        // Interactive dismissal: the finger drags down into the keyboard, as on a phone.
        let lower = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.9))
        top.press(forDuration: 0.05, thenDragTo: lower)
        assertKeyboardDownAndTabsBack(app)
        keepScreenshot(app.screenshot(), named: "after drag")
    }
}
