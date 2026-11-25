import XCTest
@testable import HealthRoadmap

/// Lead S66 (US-72 AC10, US-25 AC16f): "Delete all my data" while the engine cannot draw leaves
/// the erased record held with no drawing. Apple Health must see that erase at its own epoch, so
/// a Connect made while it is held survives the draw that follows. Built as RedrawHeldEraseTests
/// is (a real cloud session on a fake Dropbox, the engine's screen draw failing on demand), with
/// AppleHealthSync wired in as AppleHealthEraseTests does.
@MainActor
final class AppleHealthHeldEraseTests: XCTestCase {
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!
    private var health: FakeHealthStore!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Apple Health Held \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
        health = FakeHealthStore()
        suite = "AppleHealthHeldEraseTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
        defaults.removePersistentDomain(forName: suite)
        UnitChoices().save()
    }

    private var memory: HealthSyncMemory { HealthSyncMemory(defaults: defaults) }

    /// The bundled engine on the stub: its screen draw fails while `__screenFails` is set.
    private func engine() throws -> HealthEngine {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let source = try String(contentsOf: url, encoding: .utf8) + """

        globalThis.__screenFails = false;
        HealthEngine = Object.assign({}, HealthEngine, { screenJson: (door => function () {
          if (__screenFails) throw new Error('test: the screen draw fails');
          return door.apply(this, arguments);
        })(HealthEngine.screenJson) });

        """
        return try HealthEngine(source: source, sourceURL: url, session: StubHTTP.session())
    }

    private func screenFails(_ fails: Bool, _ engine: HealthEngine) throws {
        _ = try engine.blocking { try $0.evaluate("__screenFails = \(fails)") }
    }

    private func object(_ json: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
    }

    /// The record's active Apple Health weight rows.
    private func healthWeights(_ json: String) -> [[String: Any]] {
        (object(json)["measurements"] as? [[String: Any]] ?? []).filter {
            $0["source"] as? String == "apple_health" && $0["metricType"] as? String == "weight" && $0["status"] as? String == "active"
        }
    }

    /// An empty record from the web, as the cloud holds it.
    private func webRecord() throws -> [String: Any] {
        let json = try HealthEngine().blocking { try $0.newRecord(now: .now, deviceId: "web", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        return object(json)
    }

    /// Another device's erase of `record` to `epoch`, as AppleHealthEraseTests makes one.
    private func erased(_ record: [String: Any], to epoch: Int) -> [String: Any] {
        var copy = record
        var meta = record["meta"] as? [String: Any] ?? [:]
        let stamp = Date().addingTimeInterval(-1).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        meta["eraseEpoch"] = epoch
        meta["erasedAt"] = stamp
        meta["updatedAt"] = stamp
        meta["lamport"] = ((meta["lamport"] as? Int) ?? 0) + 10
        copy["meta"] = meta
        copy["measurements"] = [[String: Any]]()
        copy["labValues"] = [[String: Any]]()
        let rows = (record["measurements"] as? [[String: Any]] ?? []) + (record["labValues"] as? [[String: Any]] ?? [])
        copy["erasedRows"] = ["fromEpoch": epoch, "ids": rows.compactMap { $0["id"] as? String }]
        return copy
    }

    /// Waits up to about 3 s for what the app does after a record is drawn.
    private func until(_ what: String, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<300 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), what, file: file, line: line)
    }

    private static func weight(_ value: Double) -> HealthSample {
        HealthSample(id: UUID(), metric: "weight", value: value, at: Date().addingTimeInterval(-60))
    }

    private struct Held {
        let store: RecordStore
        let engine: HealthEngine
        let sync: CloudSync
        let health: AppleHealthSync
    }

    /// The cloud record open with Apple Health connected, then "Delete all my data" while the
    /// engine cannot draw: the store holds the erased record with no drawing.
    private func heldErase() async throws -> Held {
        dropbox.put(try webRecord())
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test")
        let appleHealth = AppleHealthSync(store: store, engine: engine, client: health, memory: memory) { await sync.syncNow() }
        let eraser = DataEraser(store: store, sync: sync, chat: chat, reminders: nil, health: appleHealth, live: nil)
        await sync.start()
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        health.pending[.weight] = [Self.weight(80)]
        await appleHealth.connect()
        await sync.background()
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 0, source: "dropbox"), "connected before any erase")

        try screenFails(true, engine)
        if case .refused(let words) = await eraser.eraseAll() { XCTFail("the erase was refused: \(words)") }
        XCTAssertEqual(store.erasures, 1, "the store took the erase in")
        XCTAssertNil(store.myData, "held with no drawing")
        return Held(store: store, engine: engine, sync: sync, health: appleHealth)
    }

    func testAnEraseHeldUndrawnIsSeenAtItsOwnEpoch_S66() async throws {
        let held = try await heldErase()
        XCTAssertEqual(held.store.hold, .heldUndrawn)
        let source = try XCTUnwrap(held.store.recordSource)
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 1, source: source), "the erase is seen at the epoch its drawing will show")
        XCTAssertFalse(memory.connected, "the erase disconnected Apple Health")
    }

    /// Connect while held, then the draw: the gate meets the erase it already saw and keeps.
    private func reconnectedAndDrawn() async throws -> Held {
        let held = try await heldErase()
        health.pending[.weight] = [Self.weight(79)]
        await held.health.connect()
        XCTAssertTrue(memory.connected, "Connect while held")

        try screenFails(false, held.engine)
        await held.store.redraw().value
        XCTAssertEqual(held.store.hold, .readable, "the erased record is drawn")
        XCTAssertEqual(held.store.myData?.eraseEpoch, 1)
        XCTAssertTrue(healthWeights(try XCTUnwrap(held.store.readable?.json)).isEmpty, "the held record refused the import")
        // HealthKit serves the weight again from the unmoved anchor.
        health.pending[.weight] = [Self.weight(79)]
        await held.health.refresh()
        return held
    }

    func testAReconnectWhileTheEraseIsHeldSurvivesItsDraw_S66() async throws {
        let held = try await reconnectedAndDrawn()
        XCTAssertTrue(memory.connected, "the draw did not disconnect the new Connect")
        XCTAssertNotEqual(held.health.status, .notConnected)
        XCTAssertEqual(healthWeights(try XCTUnwrap(held.store.readable?.json)).count, 1, "the weight read after the Connect landed")
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 1, source: "dropbox"))
    }

    /// Keep-pin (passes before and after S66): the held erase drawn, then Connect, then a newer erase
    /// from another device still disconnects. Guards against adopting every erase seen at 0.
    func testANewerEraseAfterAHeldOneStillDisconnects_S66() async throws {
        let held = try await heldErase()
        try screenFails(false, held.engine)
        await held.store.redraw().value
        health.pending[.weight] = [Self.weight(79)]
        await held.health.connect()
        XCTAssertTrue(held.health.connected, "connected again after the draw")
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 1, source: "dropbox"))

        await held.sync.background()
        dropbox.put(erased(dropbox.record, to: 2))
        await held.sync.syncNow()
        await until("the newer remote erase disconnects Apple Health") { !held.health.connected }
        XCTAssertFalse(memory.connected)
        XCTAssertEqual(held.health.status, .notConnected)
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 2, source: "dropbox"))
    }
}
