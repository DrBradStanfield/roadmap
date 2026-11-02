import XCTest

/// TEMPORARY simulator probe for US-66 (delete before commit).
final class ZZRecordsProbe: XCTestCase {
    let out = "/private/tmp/claude-501/-Users-bradstanfield-Documents-roadmap-nosync--claude-worktrees-stoic-dhawan-2db52d/0cd0213d-2ab4-49c0-880f-4c1cb3f0340e/scratchpad/probe"

    func dump(_ app: XCUIApplication, _ name: String) {
        try? FileManager.default.createDirectory(atPath: out, withIntermediateDirectories: true)
        try? app.debugDescription.write(toFile: "\(out)/\(name).txt", atomically: true, encoding: .utf8)
        try? XCUIScreen.main.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: "\(out)/\(name).png"))
    }

    @MainActor
    func testStep1() throws {
        let health = XCUIApplication(bundleIdentifier: "com.apple.Health")
        health.launch()
        sleep(3)
        dump(health, "1-launch")
        health.buttons["Browse"].firstMatch.tap()
        sleep(2)
        dump(health, "2-browse")
        let records = health.staticTexts["Health Records"].firstMatch
        for _ in 0..<6 where !records.isHittable { health.swipeUp() }
        dump(health, "3-scrolled")
        if records.exists { records.tap(); sleep(2); dump(health, "4-records") }
    }

    @MainActor
    func testStep2() throws {
        let health = XCUIApplication(bundleIdentifier: "com.apple.Health")
        health.launch()
        sleep(2)
        health.buttons["Browse"].firstMatch.tap()
        sleep(2)
        let add = health.staticTexts["Add Account"].firstMatch
        for _ in 0..<6 where !add.isHittable { health.swipeUp() }
        add.tap()
        sleep(3)
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        if springboard.buttons["Don’t Allow"].waitForExistence(timeout: 5) { springboard.buttons["Don’t Allow"].tap() }
        sleep(2)
        dump(health, "5-add")
        let sample = health.cells["UIA.Health.ClinicalOnboarding.Suggestions.SampleInstitutionA.tableCell"]
        if sample.waitForExistence(timeout: 10) { sample.tap() }
        sleep(4)
        dump(health, "5b-sample")
        health.buttons["Connect Account"].firstMatch.tap()
        sleep(6)
        dump(health, "5c-connect")
        // Walk the flow: tap the first of these words that shows, dumping each screen.
        let words = ["Get Started", "Continue", "Connect to Account", "Connect", "Allow", "Done", "Next", "OK"]
        for step in 0..<14 {
            var tapped = false
            for word in words {
                let match = health.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", word)).allElementsBoundByIndex.first { $0.isHittable && ($0.elementType == .button) }
                if let match { match.tap(); tapped = true; break }
            }
            sleep(3)
            dump(health, "6-step\(step)")
            if !tapped { break }
        }
    }

    @MainActor
    func testStep3() throws {
        let app = XCUIApplication()
        app.launchArguments = ["--ui-testing", "-welcomed", "YES", "-onboarded", "YES"]
        app.launch()
        XCTAssertTrue(app.tabBars.buttons["My data"].waitForExistence(timeout: 60))
        let connect = app.buttons["Connect Apple Health"].firstMatch
        for _ in 0..<12 where !connect.isHittable { app.swipeUp() }
        let sheet = XCUIApplication(bundleIdentifier: "com.apple.HealthPrivacyService")
        let all = sheet.cells["UIA.Health.AuthSheet.AllCategoryButton"]
        for _ in 0..<3 where !all.exists {
            connect.tap()
            _ = all.waitForExistence(timeout: 40)
        }
        dump(sheet, "8-sheet0")
        let words = ["Next", "Share", "Allow", "Continue", "Done", "OK"]
        var lastTapped = ""
        for step in 0..<16 {
            var tapped = false
            // Turn on whatever is off (Lab Results, or the vitals list).
            if all.exists, all.isHittable, lastTapped != "all" {
                tapAt(all, in: sheet); tapped = true; lastTapped = "all"
            } else if let off = sheet.switches.allElementsBoundByIndex.first(where: { $0.isHittable && ($0.value as? String) == "0" }), lastTapped != "switch" {
                tapAt(off, in: sheet); tapped = true; lastTapped = "switch"
            } else {
                for word in words {
                    let match = sheet.descendants(matching: .any).matching(NSPredicate(format: "label ==[c] %@", word)).allElementsBoundByIndex.first { $0.isHittable && $0.isEnabled && ($0.elementType == .button || $0.elementType == .cell) }
                    if let match { tapAt(match, in: sheet); tapped = true; lastTapped = word; break }
                }
            }
            if !tapped { sheet.swipeUp(); lastTapped = "swipe" }
            sleep(4)
            dump(sheet, "8-sheet\(step + 1)-\(lastTapped)")
            if !sheet.exists || sheet.state == .notRunning { break }
        }
        app.activate()
        sleep(20)
        dump(app, "9-after")
        let blood = app.staticTexts["Blood tests"].firstMatch
        for _ in 0..<12 where !blood.isHittable { app.swipeDown() }
        sleep(2)
        dump(app, "9-blood")
    }

    func tapAt(_ button: XCUIElement, in sheet: XCUIApplication) {
        let frame = button.frame
        sheet.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: frame.midX, dy: frame.midY)).tap()
    }
}
