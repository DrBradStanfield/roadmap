import XCTest
@testable import HealthRoadmap

/// `--demo-record` (DEBUG only, US-25 AC23): the app's parts run on Application Support/Demo, and cloud
/// sync, Apple Health, US-56's kept readings and reminders never start, so a real iPhone can
/// film Chat without its owner's record (DemoRecord.swift).
@MainActor
final class DemoRecordTests: XCTestCase {
    override func tearDown() async throws {
        DemoRecord.isOn = false
        // Leave the simulator as found: no Demo folder, no demo defaults suite.
        try? FileManager.default.removeItem(at: URL.applicationSupportDirectory.appending(path: "Demo", directoryHint: .isDirectory))
        UserDefaults.standard.removePersistentDomain(forName: DemoRecord.suite)
    }

    func testTheDemoRecordHasItsOwnFolder() throws {
        let base = FileManager.default.temporaryDirectory.appending(path: "Demo Record \(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: base) }
        DemoRecord.isOn = true
        XCTAssertEqual(try DemoRecord.recordFolder(in: base).lastPathComponent, "Demo")
        DemoRecord.isOn = false
        XCTAssertEqual(try DemoRecord.recordFolder(in: base).lastPathComponent, "Record")
    }

    func testDemoPartsStartNoSyncHealthOrReminders() async throws {
        DemoRecord.isOn = true
        let parts = try await AppParts.build(reminderTaps: ReminderTaps(), health: NoHealth())
        XCTAssertEqual(parts.store.file.deletingLastPathComponent().lastPathComponent, "Demo")
        // No cloud: the Demo folder holds no sync-provider, and a connect is refused before any sign-in.
        XCTAssertNil(parts.sync.provider)
        await parts.sync.start()
        XCTAssertFalse(parts.sync.recordOpen)
        XCTAssertEqual(parts.sync.status, .onPhone)
        do {
            try await parts.sync.connect(.dropbox) { _, _ in
                XCTFail("a demo record never signs in")
                throw OAuthClient.Failure.cancelled
            }
            XCTFail("a demo record never connects")
        } catch OAuthClient.Failure.refused {}
        XCTAssertNil(parts.sync.provider)
        XCTAssertNotEqual(DemoRecord.tokens.service, TokenStore().service)
        // Apple Health and US-56's cards: unavailable, so nothing is observed, read, kept or written.
        XCTAssertEqual(parts.health.status, .unavailable)
        XCTAssertFalse(parts.live.available)
        XCTAssertTrue(parts.live.cards.isEmpty)
        // Reminders: the stand-in centre, never the phone's.
        await parts.reminders.refresh()
        XCTAssertEqual(parts.reminders.permission, .denied)
        // First-run flags: done, and in their own defaults.
        XCTAssertTrue(DemoRecord.defaults.bool(forKey: "welcomed"))
        XCTAssertTrue(DemoRecord.defaults.bool(forKey: "onboarded"))
    }

    /// Consent, units and the two prompts write to the demo suite only: the phone's settings,
    /// AI consent included, stay as they were (review: Codex high, adversary R1).
    func testDemoSettingsNeverReachThePhonesDefaults() {
        XCTAssertTrue(UserDefaults.app === UserDefaults.standard)
        let keys = ["consent.chat.v1", "consent.labUpload.v1", "unitChoices.v1", "backup.saves",
                    "backup.promptShown", "review.daysWithSaves", "review.askedVersion", "appleHealth.connected"]
        let phone = { keys.map { UserDefaults.standard.object(forKey: $0) as? NSObject } }
        let before = phone()
        DemoRecord.isOn = true
        XCTAssertFalse(UserDefaults.app === UserDefaults.standard)
        AIConsent.chat.give()
        AIConsent.labUpload.give()
        UnitChoices().setting("hba1c", to: "us").save()
        let cloud = CloudPrompt()
        cloud.saved()
        cloud.shown()
        ReviewPrompt(version: "demo").recordChanged()
        HealthSyncMemory().connected = true
        let demo = DemoRecord.defaults
        XCTAssertTrue(AIConsent.chat.given)
        XCTAssertTrue(demo.bool(forKey: "consent.chat.v1"))
        XCTAssertTrue(demo.bool(forKey: "consent.labUpload.v1"))
        XCTAssertEqual(UnitChoices.saved().system(for: "hba1c", record: "si"), "us")
        XCTAssertNotNil(demo.dictionary(forKey: "unitChoices.v1"))
        XCTAssertEqual(demo.integer(forKey: "backup.saves"), 1)
        XCTAssertTrue(demo.bool(forKey: "backup.promptShown"))
        XCTAssertEqual(demo.stringArray(forKey: "review.daysWithSaves")?.count, 1)
        XCTAssertTrue(demo.bool(forKey: "appleHealth.connected"))
        // "Stop sharing" in demo mode withdraws the demo's consent, not the phone's.
        AIConsent.chat.withdraw()
        XCTAssertFalse(demo.bool(forKey: "consent.chat.v1"))
        XCTAssertEqual(phone(), before)
    }
}
