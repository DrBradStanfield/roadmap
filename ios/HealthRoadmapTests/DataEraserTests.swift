import UniformTypeIdentifiers
import XCTest
@testable import HealthRoadmap

/// US-25 AC16 (US-11 on the iPhone): "Delete all my data" and "Export my record".
/// The erase is the engine's: health-core's buildErasedFile on the phone's file,
/// RecordSession.deleteAllData with a cloud open (ios/engine/erase.ts, cloud.ts).
/// These tests pin what the app does around it: the web's order and guard, the
/// chat history, the reminders, and what the screen shows after.
@MainActor
final class DataEraserTests: XCTestCase {
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!
    private var center: FakeNotificationCenter!
    private var health: FakeHealthStore!
    private var healthDefaults: UserDefaults!
    private let question = "Is my LDL of 4.2 high?"

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Data Eraser \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
        center = FakeNotificationCenter()
        health = FakeHealthStore()
        healthDefaults = UserDefaults(suiteName: "test.\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
    }

    private struct App {
        let store: RecordStore
        let sync: CloudSync
        let chat: ChatHistoryStore
        let reminders: ReminderScheduler
        let eraser: DataEraser
        let health: AppleHealthSync
    }

    /// The app's parts, as AppParts makes them, on the test folder and the stub.
    private func app(connected: Bool) throws -> App {
        if connected { try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider")) }
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test")
        let reminders = ReminderScheduler(center: center, folder: folder) {
            try engine.reminders(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId)
        }
        let appleHealth = AppleHealthSync(store: store, engine: engine, client: health, memory: HealthSyncMemory(defaults: healthDefaults))
        let eraser = DataEraser(engine: engine, store: store, sync: sync, chat: chat, reminders: reminders, health: appleHealth)
        return App(store: store, sync: sync, chat: chat, reminders: reminders, eraser: eraser, health: appleHealth)
    }

    private func record(days: [String]) throws -> [String: Any] {
        let engine = try HealthEngine()
        var json = try engine.newRecord(now: .now, deviceId: "web", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        for day in days {
            json = try XCTUnwrap(engine.apply(.add(metric: "weight", value: 80, day: day), to: json, now: .now, deviceId: "web").record)
        }
        return try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    }

    private func object(_ json: String) -> [String: Any] {
        try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    }

    private func epoch(_ record: [String: Any]) -> Int? {
        (record["meta"] as? [String: Any])?["eraseEpoch"] as? Int
    }

    private func rows(_ record: [String: Any]) -> Int {
        ((record["measurements"] as? [[String: Any]]) ?? []).count
    }

    private var phoneFile: URL { folder.appending(path: "health-roadmap.json") }
    private var chatFile: URL { folder.appending(path: "chat-history.json") }
    private var pendingMarker: URL { folder.appending(path: "sync-pending") }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path(percentEncoded: false))
    }

    private func seedChat(_ chat: ChatHistoryStore) {
        chat.record(ChatExchange(conversationId: "c1", isNew: true, userText: question, assistantText: "It is above target.", isFallback: false), askedAt: ChatHistoryStore.erasures)
        XCTAssertEqual(chat.conversations.count, 1)
    }

    // MARK: On the phone

    func testThePhoneEraseEmptiesTheRecordTheChatAndTheReminders() async throws {
        let app = try app(connected: false)
        XCTAssertEqual(app.store.apply(.units("conventional")), .saved)
        XCTAssertEqual(app.store.apply(.add(metric: "weight", value: 176, day: "2026-10-01")), .saved)
        seedChat(app.chat)
        let optedIn = await app.reminders.optIn()
        XCTAssertTrue(optedIn)
        UserDefaults.standard.set(true, forKey: "welcomed")

        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }

        let onDisk = object(try String(contentsOf: phoneFile, encoding: .utf8))
        XCTAssertEqual(epoch(onDisk), 1, "the engine's erase: a higher eraseEpoch")
        XCTAssertEqual(rows(onDisk), 0)
        XCTAssertEqual(app.store.recordJSON, try String(contentsOf: phoneFile, encoding: .utf8), "the screen shows what is on disk")
        XCTAssertNil(app.store.myData?.vitals.first { $0.metric == "weight" }?.latest)
        XCTAssertEqual(app.store.erasures, 1, "views holding health data are told")
        XCTAssertEqual(app.store.myData?.unitSystem, "conventional", "the units are a setting, kept as the web keeps its unit preference")
        XCTAssertTrue(app.chat.conversations.isEmpty)
        XCTAssertFalse(try String(contentsOf: chatFile, encoding: .utf8).contains(question), "the question is gone from the file")
        XCTAssertFalse(app.reminders.optedIn, "the epoch moved, so reminders are off")
        XCTAssertEqual(center.pending, [])
        XCTAssertTrue(UserDefaults.standard.bool(forKey: "welcomed"), "the welcome screen does not come back")
    }

    func testThePhoneEraseRefusesARecordItCannotReadAndChangesNothing() async throws {
        let first = try app(connected: false)
        seedChat(first.chat)
        try Data("{ not a record".utf8).write(to: phoneFile)
        let app = try app(connected: false)
        XCTAssertNotNil(app.store.problem)
        let chatBefore = try String(contentsOf: chatFile, encoding: .utf8)

        guard case .refused = await app.eraser.eraseAll() else { return XCTFail("an unreadable record must refuse the erase") }
        XCTAssertEqual(try String(contentsOf: phoneFile, encoding: .utf8), "{ not a record")
        XCTAssertEqual(try String(contentsOf: chatFile, encoding: .utf8), chatBefore)
    }

    // MARK: In the cloud

    func testTheCloudEraseWritesTheEraseIntoTheCloudFileAndLeavesThePhoneOnlyTheErasedCopy() async throws {
        dropbox.put(try record(days: ["2026-10-01"]))
        let emailFile = folder.appending(path: "sync-account-email")
        try Data("brad@example.com".utf8).write(to: emailFile)
        let app = try app(connected: true)
        await app.sync.start()
        XCTAssertNotNil(app.store.cloudErase)
        XCTAssertEqual(app.sync.accountEmail, "brad@example.com")
        seedChat(app.chat)

        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }

        // US-25 AC11e (2026-10-22): the connected account's email goes with the erase.
        XCTAssertNil(app.sync.accountEmail)
        XCTAssertFalse(exists(emailFile))

        XCTAssertEqual(epoch(dropbox.record), 1, "the file stays in Dropbox, with the erase in it")
        XCTAssertEqual(rows(dropbox.record), 0)
        XCTAssertEqual(epoch(object(app.store.recordJSON)), 1)
        XCTAssertEqual(epoch(object(try String(contentsOf: phoneFile, encoding: .utf8))), 1, "the phone's copy is the erased record")
        XCTAssertFalse(exists(pendingMarker), "nothing waits for the cloud")
        XCTAssertFalse(try String(contentsOf: chatFile, encoding: .utf8).contains(question))
        XCTAssertEqual(app.store.erasures, 1)
        guard case .synced = app.sync.status else { return XCTFail("status is \(app.sync.status)") }
        XCTAssertEqual(app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-05")), .saved, "a new value after the erase saves")
    }

    func testAnUnreachableCloudErasesNothingAndSaysSo() async throws {
        dropbox.put(try record(days: ["2026-10-01"]))
        let app = try app(connected: true)
        await app.sync.start()
        seedChat(app.chat)
        let chatBefore = try String(contentsOf: chatFile, encoding: .utf8)
        let cloudBefore = dropbox.file!.text
        dropbox.online = false

        guard case .refused(let message) = await app.eraser.eraseAll() else { return XCTFail("nothing may be deleted") }
        XCTAssertTrue(message.contains("could not be reached"), message)
        XCTAssertEqual(dropbox.file!.text, cloudBefore)
        XCTAssertEqual(try String(contentsOf: chatFile, encoding: .utf8), chatBefore)
        XCTAssertEqual(rows(object(app.store.recordJSON)), 1)
        XCTAssertEqual(app.store.erasures, 0)
    }

    func testConnectedWithNoOpenSessionRefusesAsTheWebDoes() async throws {
        StubHTTP.handler = { _ in .init(offline: true) }
        let app = try app(connected: true)
        await app.sync.start()
        XCTAssertNil(app.store.cloudErase, "the screen fell back to the phone's file")
        XCTAssertEqual(app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-06")), .saved)
        let before = try String(contentsOf: phoneFile, encoding: .utf8)

        guard case .refused = await app.eraser.eraseAll() else { return XCTFail("a phone that cannot read the cloud cannot list what it erases") }
        XCTAssertEqual(try String(contentsOf: phoneFile, encoding: .utf8), before)
    }

    func testAnEraseTheCloudCouldNotTakeIsShownKeptPendingAndSentLater() async throws {
        dropbox.put(try record(days: ["2026-10-01"]))
        let app = try app(connected: true)
        await app.sync.start()
        let fake = dropbox!
        StubHTTP.handler = { $0.url.path.hasSuffix("/files/upload") ? .init(offline: true) : fake.answer($0) }

        guard case .notSent = await app.eraser.eraseAll() else { return XCTFail("the erase is made here but not sent") }
        XCTAssertEqual(epoch(object(app.store.recordJSON)), 1, "the screen shows the erased record")
        XCTAssertTrue(exists(pendingMarker), "the erase waits on the phone")
        XCTAssertEqual(rows(dropbox.record), 1)

        StubHTTP.handler = { fake.answer($0) }
        await app.sync.background()
        XCTAssertEqual(epoch(dropbox.record), 1, "the next save sends it")
        XCTAssertEqual(rows(dropbox.record), 0)
    }

    func testR2ADisconnectDuringACloudEraseWaitsItsTurnAndTheEraseLands() async throws {
        dropbox.put(try record(days: ["2026-10-01"]))
        let app = try app(connected: true)
        await app.sync.start()
        dropbox.downloadDelay = 0.3
        let erase = Task { await app.eraser.eraseAll() }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertTrue(app.sync.erasing)
        let copied = await app.sync.disconnect()
        XCTAssertFalse(copied, "Disconnect is refused while the erase runs")
        XCTAssertNotNil(app.sync.provider, "still connected")
        guard case .erased = await erase.value else { return XCTFail("the erase finishes") }
        XCTAssertEqual(epoch(dropbox.record), 1)
        XCTAssertEqual(epoch(object(app.store.recordJSON)), 1, "the screen shows the erase")
        XCTAssertFalse(app.sync.erasing)
    }

    func testN1AnAnswerThatStartedBeforeTheEraseIsNeverSavedAfterIt() async throws {
        dropbox.put(try record(days: ["2026-10-01"]))
        let app = try app(connected: true)
        await app.sync.start()
        seedChat(app.chat)
        // ChatView's own store, apart from the eraser's, as in the app.
        let screen = ChatHistoryStore(engine: try HealthEngine(), folder: folder, deviceId: "ios-test")
        let askedAt = ChatHistoryStore.erasures
        // The answer lands between the chat write and the end of the erase: a new
        // conversation, so no tombstone of its own guards it.
        let fake = dropbox!
        var landed = false
        StubHTTP.handler = { request in
            if request.url.path.hasSuffix("/files/upload"), !landed {
                landed = true
                DispatchQueue.main.sync {
                    MainActor.assumeIsolated {
                        screen.record(ChatExchange(conversationId: "c-new", isNew: true, userText: self.question, assistantText: "Answer.", isFallback: false), askedAt: askedAt)
                    }
                }
            }
            return fake.answer(request)
        }
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        XCTAssertTrue(landed)
        XCTAssertFalse(try String(contentsOf: chatFile, encoding: .utf8).contains(question), "the late answer was not saved")
        // A question asked after the erase saves as usual.
        screen.record(ChatExchange(conversationId: "c-after", isNew: true, userText: "Later", assistantText: "Answer.", isFallback: false), askedAt: ChatHistoryStore.erasures)
        XCTAssertEqual(screen.conversations.count, 1)
    }

    // MARK: Apple Health (D6)

    func testTheEraseDeletesTheSamplesThisAppWroteToAppleHealthAndForgetsThem() async throws {
        let app = try app(connected: false)
        await app.health.connect()
        XCTAssertEqual(app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")), .saved)
        await app.health.refresh()
        XCTAssertFalse(health.saved.isEmpty, "the typed weight went out to Health")
        XCTAssertNotNil(healthDefaults.dictionary(forKey: "appleHealth.written"))

        guard case .erased(let words) = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        XCTAssertEqual(health.ownDeletes, 1, "the app's own samples are deleted from Health")
        XCTAssertNil(healthDefaults.dictionary(forKey: "appleHealth.written"), "and their written versions forgotten")
        XCTAssertFalse(words.contains("Apple Health could not"), words)
    }

    func testAnAppleHealthDeleteThatFailsIsSaidAndTheRecordIsStillErased() async throws {
        let app = try app(connected: false)
        await app.health.connect()
        health.deleteFails = true
        guard case .erased(let words) = await app.eraser.eraseAll() else { return XCTFail("the record erase still stands") }
        XCTAssertTrue(words.contains("Apple Health could not"), words)
        XCTAssertEqual(epoch(object(app.store.recordJSON)), 1)
    }

    func testWithAppleHealthNeverConnectedNothingIsAskedOfIt() async throws {
        let app = try app(connected: false)
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        XCTAssertEqual(health.ownDeletes, 0)
    }

    // MARK: Words and export

    func testTheConfirmationSaysWhatGoesAndWhere() {
        XCTAssertTrue(EraseText.confirm(provider: nil, earlier: nil, appleHealth: true).contains("Apple Health"))
        let phone = EraseText.confirm(provider: nil, earlier: nil)
        XCTAssertTrue(phone.contains("chat history"))
        XCTAssertTrue(phone.contains("reminders"))
        XCTAssertFalse(phone.contains("Dropbox"))
        let cloud = EraseText.confirm(provider: .dropbox, earlier: .dropbox)
        XCTAssertTrue(cloud.contains("in Dropbox"))
        XCTAssertTrue(cloud.contains("other devices"))
        let before = EraseText.confirm(provider: nil, earlier: .dropbox)
        XCTAssertTrue(before.contains("copy in Dropbox"))
        XCTAssertTrue(before.contains("connect Dropbox again"), "connecting again carries the erase there (R3), and the user is told")
    }

    func testTheExportIsTheRecordFileUnderTheWebsName() async throws {
        let app = try app(connected: false)
        XCTAssertEqual(app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")), .saved)
        let export = RecordExport(json: app.store.recordJSON)
        XCTAssertEqual(RecordExport.fileName, "health-roadmap.json")
        guard #available(iOS 18.2, *) else { throw XCTSkip("exported(as:) needs iOS 18.2") }
        let data = try await export.exported(as: .json)
        XCTAssertEqual(String(decoding: data, as: UTF8.self), app.store.recordJSON)
    }
}
