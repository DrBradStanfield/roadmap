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
        // Walk the flow: tap the first of these words that shows, dumping each screen.
        let words = ["Get Started", "Continue", "Sample", "Health System", "Hospital", "Connect to Account", "Connect", "Allow", "Done", "Next", "OK"]
        for step in 0..<14 {
            var tapped = false
            for word in words {
                let match = health.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS[c] %@", word)).allElementsBoundByIndex.first { $0.isHittable && ($0.elementType == .button || $0.elementType == .cell || $0.elementType == .staticText) }
                if let match { match.tap(); tapped = true; break }
            }
            sleep(3)
            dump(health, "6-step\(step)")
            if !tapped { break }
        }
    }
}
