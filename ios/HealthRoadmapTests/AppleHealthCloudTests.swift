import XCTest
@testable import HealthRoadmap

/// US-25 AC15 with cloud sync (AC11): an Apple Health import takes the typed
/// values' path, so in the cloud it goes through the engine's session (the save
/// loop, the merge, the erase guard), and a sheet's pin never refuses it.
/// HealthKit is faked (FakeHealthStore); Dropbox is CloudSyncTests' stub.
@MainActor
final class AppleHealthCloudTests: XCTestCase {
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!
    private var defaults: UserDefaults!
    private var suite: String!
    /// How many times the sync asked for a re-read after a refused import.
    private var rereads = 0

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Apple Health Cloud \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
        suite = "AppleHealthCloudTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
        defaults.removePersistentDomain(forName: suite)
    }

    /// The app's parts as AppParts makes them, connected to the stubbed Dropbox.
    private func app() throws -> (RecordStore, CloudSync, AppleHealthSync, FakeHealthStore) {
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let health = FakeHealthStore()
        let healthSync = AppleHealthSync(store: store, engine: engine, client: health, memory: HealthSyncMemory(defaults: defaults)) { [weak self] in
            self?.rereads += 1
            await sync.syncNow()
        }
        return (store, sync, healthSync, health)
    }

    /// An empty record from the web, as the cloud holds it.
    private func webRecord() throws -> [String: Any] {
        let json = try HealthEngine().newRecord(now: .now, deviceId: "web", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        return try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    }

    private func appleHealthRows(_ record: [String: Any]) -> [[String: Any]] {
        ((record["measurements"] as? [[String: Any]]) ?? []).filter { $0["source"] as? String == "apple_health" && $0["status"] as? String == "active" }
    }

    private func reading() -> HealthSample {
        HealthSample(id: UUID(), metric: "weight", value: 80, at: Date().addingTimeInterval(-60))
    }

    func testAnImportGoesThroughTheCloudSession() async throws {
        dropbox.put(try webRecord())
        let (store, sync, healthSync, health) = try app()
        await sync.start()
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        health.pending[.weight] = [reading()]

        await healthSync.connect()
        await sync.background()

        XCTAssertEqual(appleHealthRows(dropbox.record).count, 1, "the session saved the import to the cloud")
        XCTAssertNotNil(HealthSyncMemory(defaults: defaults).anchor(for: .weight), "and the anchor moved after it was taken")
    }

    /// A sheet opened before a remote erase pins the old erase; a typed value from it
    /// is refused (AC11g), but an import is not a sheet and is checked against now.
    func testAnOpenSheetDoesNotRefuseAnImport() async throws {
        let before = try webRecord()
        dropbox.put(before)
        let (store, sync, healthSync, health) = try app()
        await sync.start()
        store.pinScreen()
        var erased = before
        var meta = before["meta"] as! [String: Any]
        let at = Date().addingTimeInterval(-3600).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        meta["eraseEpoch"] = 1
        meta["erasedAt"] = at
        meta["updatedAt"] = at
        meta["lamport"] = ((meta["lamport"] as? Int) ?? 0) + 10
        erased["meta"] = meta
        erased["erasedRows"] = ["fromEpoch": 1, "ids": [String]()]
        dropbox.put(erased)
        await sync.syncNow()
        XCTAssertNotEqual(store.cloudErase, nil)

        health.pending[.weight] = [reading()]
        await healthSync.connect()
        store.unpinScreen()
        await sync.background()

        XCTAssertEqual(appleHealthRows(dropbox.record).count, 1, "the import landed in the record as it is after the erase")
        XCTAssertEqual(rereads, 0, "the sheet's stale pin never refused it")
    }
}
