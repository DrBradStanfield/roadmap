import XCTest
@testable import HealthRoadmap

/// US-25 AC11p (lead S27): a failed read of the phone's file keeps no record text. showPhone's
/// read fails only when the file is missing and a first record cannot be made (RecordFile
/// `loadPhone`); deleting the store's folder makes that happen. After it, chat, Apple Health,
/// reminders and the lab review read nothing until a read succeeds, never the cloud record
/// the screen showed before.
@MainActor
final class UnreadableRecordTests: XCTestCase {
    private var folder: URL!
    /// The reminders' opt-in lives beside the record in the app; here it is kept apart, so
    /// deleting the record's folder cannot remove it and the test sees the scheduler keep it.
    private var remindersFolder: URL!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Unreadable \(UUID().uuidString)")
        remindersFolder = FileManager.default.temporaryDirectory.appending(path: "Unreadable reminders \(UUID().uuidString)")
        for each in [folder!, remindersFolder!] { try FileManager.default.createDirectory(at: each, withIntermediateDirectories: true) }
        suite = "UnreadableRecordTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        for each in [folder!, remindersFolder!] { try? FileManager.default.removeItem(at: each) }
        defaults.removePersistentDomain(forName: suite)
        UnitChoices().save()
    }

    private var phoneFile: URL { RecordStore.file(in: folder) }

    /// The phone's record with one typed weight more, as a cloud record: the same eraseEpoch.
    private func cloudRecord(from phone: String, engine: HealthEngine) throws -> String {
        try XCTUnwrap(engine.blocking { try $0.apply(.add(metric: "weight", value: 80, day: "2026-10-02"), to: phone, now: .now, deviceId: "web") }.record)
    }

    /// A store showing a cloud record, the phone's file then made unreadable: a first record
    /// can no longer be created where the folder was.
    private func onTheCloudThenUnreadable(_ engine: HealthEngine) async throws -> RecordStore {
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let cloud = try cloudRecord(from: store.recordJSON, engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        XCTAssertEqual(store.recordJSON, cloud, "the cloud record is shown")
        try FileManager.default.removeItem(at: folder)
        return store
    }

    /// AC11p: a failed read after the cloud keeps no cloud text, and an edit is refused with the
    /// problem's own words; nothing reaches the phone's file.
    func testAFailedReadAfterTheCloudKeepsNoCloudText_US25_AC11p() async throws {
        let engine = try HealthEngine()
        let store = try await onTheCloudThenUnreadable(engine)
        await store.showPhone().value
        let problem = try XCTUnwrap(store.problem, "the read failed")
        XCTAssertNil(store.myData)
        XCTAssertNil(store.screen.erase, "the phone's source, not the cloud's")
        XCTAssertEqual(store.recordJSON, "", "no record text: the cloud's is gone")
        let result = await store.apply(.add(metric: "weight", value: 82, day: "2026-10-07"))
        XCTAssertEqual(result, .refused(message: problem.words, existingId: nil))
        XCTAssertFalse(FileManager.default.fileExists(atPath: phoneFile.path(percentEncoded: false)), "the phone's file is not written")
    }

    /// AC11p: a failed re-read of the phone's own file keeps no text either.
    func testAFailedReReadOfThePhoneKeepsNoText_US25_AC11p() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        XCTAssertEqual(store.source, .phone(link: nil))
        XCTAssertNotEqual(store.recordJSON, "")
        try FileManager.default.removeItem(at: folder)
        await store.showPhone().value
        XCTAssertNotNil(store.problem)
        XCTAssertNil(store.myData)
        XCTAssertEqual(store.recordJSON, "")
    }

    /// AC11p: a lab import on an unreadable record is refused with the problem's words, not a
    /// fault from reading an empty record.
    func testALabImportOnAnUnreadableRecordGivesTheProblemsWords_US25_AC11p() async throws {
        let engine = try HealthEngine()
        let store = try await onTheCloudThenUnreadable(engine)
        await store.showPhone().value
        let problem = try XCTUnwrap(store.problem)
        // The fixture of RecordSourcePinsTests.testALabImportAskedWhileLeavingTheCloudIsRefused.
        let extraction = #"{"classification":"lab_report","reportDate":"2026-10-01","values":[{"metric":"ldl","valueSI":3.1,"displayValue":3.1,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}],"additionalValues":[],"refusedValues":[]}"#
        let result = await store.importLabs(extractionJSON: extraction, refs: ["v9"], reportDay: "2026-10-01")
        XCTAssertEqual(result, .failure(LabRefusal(message: problem.words)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: phoneFile.path(percentEncoded: false)))
    }

    /// AC11p: Apple Health writes nothing from the cloud record once the phone's read failed.
    func testAFailedReadAfterTheCloudWritesNothingToAppleHealth_US25_AC11p() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let health = FakeHealthStore()
        let sync = AppleHealthSync(store: store, engine: engine, client: health, memory: HealthSyncMemory(defaults: defaults))
        await sync.connect()
        XCTAssertTrue(health.saved.isEmpty, "the phone's new record has no typed value")
        // A cloud record with a typed weight Health has not been sent.
        let cloud = try cloudRecord(from: store.recordJSON, engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        try FileManager.default.removeItem(at: folder)
        await store.showPhone().value
        XCTAssertNotNil(store.problem)
        await sync.refresh()
        XCTAssertTrue(health.saved.isEmpty, "the cloud record's weight is not written: \(health.saved.map(\.values))")
    }

    /// AC11p (owner): reminders pause and resume. The failed read removes every pending
    /// reminder and keeps the opt-in; the next good read schedules them again.
    func testRemindersPauseOnAFailedReadAndResumeOnAGoodOne_US25_AC11p() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let center = FakeNotificationCenter()
        // As AppParts makes it: the engine reads the store's record text.
        let reminders = ReminderScheduler(center: center, folder: remindersFolder, erasures: { store.erasures }) { firstSeen in
            try await engine.reminders(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId, firstSeen: firstSeen)
        }
        let cloud = try cloudRecord(from: store.recordJSON, engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        let on = await reminders.optIn()
        XCTAssertTrue(on)
        XCTAssertFalse(center.pending.isEmpty, "the cloud record's reminders are scheduled")

        try FileManager.default.removeItem(at: folder)
        await store.showPhone().value
        XCTAssertNotNil(store.problem)
        await reminders.refresh()
        XCTAssertEqual(center.pending.map(\.identifier), [], "paused: nothing pending from the cloud record")
        XCTAssertTrue(reminders.optedIn, "the opt-in is kept")
        XCTAssertTrue(FileManager.default.fileExists(atPath: remindersFolder.appending(path: "reminders-opt-in").path(percentEncoded: false)))

        // A good read: the folder is back, so a first record is made and read.
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        await store.showPhone().value
        XCTAssertNil(store.problem)
        await reminders.refresh()
        XCTAssertFalse(center.pending.isEmpty, "resumed on the good read")
        XCTAssertTrue(reminders.optedIn)
    }

    /// AC11p (owner): after the failed read the chat has no context to send. ChatView's send
    /// (ChatView.swift) builds the context from `store.recordJSON` first and sends only after;
    /// a throw there ends the turn before `ChatClient.body` and `ask`, with the chat's failure
    /// words. This pins the context's throw and the words; the zero-request half needs a seam
    /// in ChatView's send (lead S27 report).
    func testTheChatHasNoContextToSendAfterAFailedRead_US25_AC11p() async throws {
        let engine = try HealthEngine()
        let store = try await onTheCloudThenUnreadable(engine)
        await store.showPhone().value
        XCTAssertNotNil(store.problem)
        do {
            let context = try await engine.chatContext(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId)
            XCTFail("a context was built from the record text left behind (\(context.utf8.count) bytes)")
        } catch {
            XCTAssertEqual(ChatTranscript.words(for: error), "Something went wrong, so this question has no answer. Please try again.")
        }
    }
}
