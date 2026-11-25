import UIKit
import XCTest

/// Screenshots for reading the wording on the real screens: Settings, the lab upload's first
/// screen, Chat's consent before agreeing, the BMI, HbA1c and eGFR pages down to their range
/// line, My health screen by screen, and every plan step that names a medicine, opened to its
/// sources. It checks no wording (the unit tests do) and taps nothing that sends: never Agree,
/// never a source in the upload sheet. What it could not reach goes in its "notes" attachment.
/// Opt-in: ios/scripts/review-shots.sh seeds the fictional record and sets
/// TEST_RUNNER_REVIEW_SHOTS; any other run skips.
final class ReviewScreenshots: XCTestCase {
    private var app: XCUIApplication!
    private var shots = 0
    private var notes: [String] = []

    @MainActor
    func testTakeTheReviewScreenshots() throws {
        guard ProcessInfo.processInfo.environment["REVIEW_SHOTS"] == "1" else {
            throw XCTSkip("Run by ios/scripts/review-shots.sh, which seeds the record.")
        }
        continueAfterFailure = true
        app = XCUIApplication()
        app.launchArguments = ["--ui-testing"]
        // A closed local port: nothing this test does reaches a server.
        app.launchEnvironment["HEALTH_ROADMAP_SERVER"] = "http://127.0.0.1:3109"
        app.launch()
        guard app.tabBars.buttons["My health"].waitForExistence(timeout: 20) else {
            note("the tabs never showed")
            shoot("launch")
            return finish()
        }
        sleep(3) // the page is built once its series are read

        settings()
        labUploadSheet()
        chatConsent()
        // BMI has no row of its own: it sits on Weight's page. eGFR sits on Creatinine's.
        for (name, prefixes) in [("Weight-BMI", ["Weight,"]), ("HbA1c", ["HbA1c,", "HbA1c"]), ("Creatinine-eGFR", ["Creatinine,", "eGFR,"])] {
            valuePage(name, prefixes: prefixes)
        }
        pageSweep()
        medicineCards()
        finish()
    }

    // MARK: Screens

    @MainActor
    private func settings() {
        scrollToTop()
        let button = app.buttons["Settings"].firstMatch
        guard button.waitForExistence(timeout: 5) else { return note("Settings button not found") }
        button.tap()
        guard app.navigationBars["Settings"].waitForExistence(timeout: 5) else { return note("the Settings sheet did not open") }
        sweep("settings", limit: 8)
        app.navigationBars["Settings"].buttons["Done"].tap()
        sleep(1)
    }

    @MainActor
    private func labUploadSheet() {
        scrollToTop()
        let button = app.buttons["Upload labs"].firstMatch
        guard button.waitForExistence(timeout: 5) else { return note("Upload labs not found") }
        button.tap()
        guard app.buttons["labSource.files"].waitForExistence(timeout: 5) else {
            shoot("lab upload sheet (no sources)")
            return note("the lab upload sources did not show")
        }
        shoot("lab upload sheet")
        let close = app.buttons["Close"].firstMatch
        if close.exists { close.tap() } else { app.swipeDown() }
        sleep(1)
    }

    @MainActor
    private func chatConsent() {
        app.tabBars.buttons["Chat"].tap()
        sleep(3)
        if !app.buttons["Agree and continue"].exists { note("Chat showed no Agree and continue button") }
        sweep("chat consent", limit: 3)
        app.tabBars.buttons["My health"].tap()
        sleep(2)
    }

    /// Opens the value's page and shoots it screen by screen; notes when no range line is on it.
    @MainActor
    private func valuePage(_ name: String, prefixes: [String]) {
        scrollToTop()
        var row: XCUIElement?
        for prefix in prefixes {
            row = scrollFind(NSPredicate(format: "label BEGINSWITH %@", prefix), in: app.buttons)
            if row != nil { break }
        }
        guard let row else { return note("\(name): no row found on My health") }
        row.tap()
        sleep(2)
        if app.navigationBars.count == 0 { note("\(name): its page did not open") }
        sweep("\(name) page", limit: 6)
        let back = app.navigationBars.buttons.firstMatch
        if back.exists { back.tap() }
        sleep(1)
    }

    /// My health from top to bottom, every card closed, the medication questions on the way.
    @MainActor
    private func pageSweep() {
        scrollToTop()
        sweep("my health", limit: 45)
    }

    /// Every plan step whose words name a medicine, opened, title to sources; and every medication
    /// question's info sheet, where the plan's medicine steps are placed (US-73 AC6).
    @MainActor
    private func medicineCards() {
        let words = ["statin", "medication", "medicine", "glp-1", "tirzepatide", "semaglutide", "ezetimibe",
                     "metformin", "sglt2", "pcsk9", "bempedoic", "insulin"]
        func names(_ label: String) -> Bool { words.contains { label.lowercased().contains($0) } }
        scrollToTop()
        var done = Set<String>()
        var seen = Set<String>()
        var n = 0
        for _ in 0..<90 {
            let bottom = app.tabBars.firstMatch.frame.minY
            func onScreen(_ e: XCUIElement) -> Bool { e.frame.minY > 100 && e.frame.minY < bottom - 160 && e.isHittable }
            let cards = app.buttons.matching(identifier: "plan.suggestion").allElementsBoundByIndex
            for card in cards where card.frame.minY > 0 && card.frame.minY < bottom { seen.insert(String(card.label.prefix(70))) }
            if let found = cards.first(where: { !done.contains($0.label) && names($0.label) && onScreen($0) }) {
                let label = found.label
                done.insert(label)
                // By its label, not its index: the index goes stale once the list moves.
                let card = app.buttons.matching(identifier: "plan.suggestion").matching(NSPredicate(format: "label == %@", label)).firstMatch
                n += 1
                let title = String(label.prefix(44)).filter { $0.isLetter || $0.isNumber || $0 == " " || $0 == "-" }
                scrollUntil(card, isAbove: 0.1)
                guard card.exists, card.isHittable else { note("could not open: \(label.prefix(60))"); continue }
                card.tap()
                sleep(2)
                shoot(String(format: "card %02d %@", n, title))
                var drags = 0
                for part in ["b", "c"] {
                    let before = screenKey()
                    drag(0.55)
                    drags += 1
                    if screenKey() == before { break }
                    shoot(String(format: "card %02d %@ %@", n, title, part))
                }
                for _ in 0..<drags { drag(-0.55) }
                continue
            }
            let abouts = app.buttons.matching(NSPredicate(format: "label BEGINSWITH 'About '")).allElementsBoundByIndex
            if let found = abouts.first(where: { !done.contains($0.label) && names($0.label) && onScreen($0) }) {
                let label = found.label
                done.insert(label)
                n += 1
                let about = app.buttons.matching(NSPredicate(format: "label == %@", label)).firstMatch
                guard about.exists, about.isHittable else { note("could not open: \(label)"); continue }
                about.tap()
                sleep(2)
                let title = label.filter { $0.isLetter || $0.isNumber || $0 == " " || $0 == "-" }
                sweep(String(format: "info %02d %@", n, title), limit: 5)
                let close = app.buttons["Done"].firstMatch
                if close.exists { close.tap() } else { app.swipeDown() }
                sleep(1)
                continue
            }
            if app.buttons["Add another supplement"].firstMatch.exists && app.buttons["Add another supplement"].firstMatch.isHittable { break }
            drag(0.45)
        }
        if done.isEmpty { note("no plan card or medication question naming a medicine was found") }
        notes.append("opened (\(done.count)):")
        for label in done.sorted() { notes.append("  \(label)") }
        notes.append("plan cards seen (first 70 characters):")
        for label in seen.sorted() { notes.append("  \(label)") }
    }

    // MARK: Helpers

    @MainActor
    private func finish() {
        let text = notes.isEmpty ? "everything reached" : notes.joined(separator: "\n")
        let attachment = XCTAttachment(string: text)
        attachment.name = "notes"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func note(_ text: String) { notes.append(text) }

    @MainActor
    private func shoot(_ name: String) {
        sleep(1) // let animations settle
        shots += 1
        keepScreenshot(XCUIScreen.main.screenshot(), named: String(format: "%02d %@", shots, name))
    }

    /// The screen without its status bar and right edge (the scroll indicator), to tell when a drag
    /// no longer moves it.
    @MainActor
    private func screenKey() -> Data {
        let image = XCUIScreen.main.screenshot().image
        guard let cg = image.cgImage else { return Data() }
        let scale = image.scale
        let rect = CGRect(x: 0, y: 70 * scale, width: CGFloat(cg.width) - 30 * scale, height: CGFloat(cg.height) - 70 * scale)
        return cg.cropping(to: rect).map { UIImage(cgImage: $0).pngData() ?? Data() } ?? Data()
    }

    /// Shoots the screen, then drags on, until the screen stops changing or `limit` shots.
    @MainActor
    private func sweep(_ name: String, limit: Int) {
        var index = 1
        shoot("\(name) \(index)")
        while index < limit {
            let before = screenKey()
            drag(0.6)
            if screenKey() == before { break }
            index += 1
            shoot("\(name) \(index)")
        }
    }

    /// A slow drag of `fraction` of the screen height: positive moves the content up (scrolls down).
    @MainActor
    private func drag(_ fraction: CGFloat) {
        let middle = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        let distance = app.frame.height * fraction
        middle.withOffset(CGVector(dx: 0, dy: distance / 2))
            .press(forDuration: 0.1, thenDragTo: middle.withOffset(CGVector(dx: 0, dy: -distance / 2)),
                   withVelocity: XCUIGestureVelocity(400), thenHoldForDuration: 0.4)
        sleep(1)
    }

    @MainActor
    private func scrollToTop() {
        for _ in 0..<12 { app.swipeDown(velocity: .fast) }
        sleep(1)
    }

    /// Drags down the page until an element matching `predicate` sits whole on screen.
    @MainActor
    private func scrollFind(_ predicate: NSPredicate, in query: XCUIElementQuery) -> XCUIElement? {
        for _ in 0..<40 {
            let element = query.matching(predicate).firstMatch
            if element.exists, element.isHittable, element.frame.minY > 50, element.frame.maxY < app.tabBars.firstMatch.frame.minY {
                return element
            }
            let before = screenKey()
            drag(0.4)
            if screenKey() == before { return nil }
        }
        return nil
    }

    /// Drags until `element`'s top is near `fraction` of the screen height (AppStoreScreenshots' method).
    @MainActor
    private func scrollUntil(_ element: XCUIElement, isAbove fraction: Double) {
        let target = app.frame.height * fraction
        for _ in 0..<6 {
            guard element.exists else { return }
            let gap = element.frame.minY - target
            if abs(gap) < 24 { return }
            let want = max(min(gap, app.frame.height * 0.35), -app.frame.height * 0.35)
            drag(want / app.frame.height)
        }
    }
}
