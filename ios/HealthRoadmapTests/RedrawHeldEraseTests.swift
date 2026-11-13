import XCTest
@testable import HealthRoadmap

/// Lead S45 (US-25 AC16f): an erase the store holds with no drawing (its draw failed) is drawn
/// again when the app comes forward or at midnight, both `RecordStore.redraw` (RootView). Once
/// drawn, My data shows the erased record and it takes edits again. A redraw that fails again
/// leaves it held. Built as EraseUnitsGuardTests is: a real cloud session on a fake Dropbox,
/// erased through DataEraser while the engine's screen draw fails.
@MainActor
final class RedrawHeldEraseTests: XCTestCase {
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Redraw Held \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
        UnitChoices().save()
    }

    /// The bundled engine on the stub: its screen draw fails while `__screenFails` is set, and it
    /// counts the cloud session's edits in `__cloudEdits`.
    private func engine() throws -> HealthEngine {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let source = try String(contentsOf: url, encoding: .utf8) + """

        globalThis.__screenFails = false;
        globalThis.__cloudEdits = 0;
        HealthEngine = Object.assign({}, HealthEngine, { screenJson: (door => function () {
          if (__screenFails) throw new Error('test: the screen draw fails');
          return door.apply(this, arguments);
        })(HealthEngine.screenJson), cloudEdit: (door => function () {
          __cloudEdits += 1;
          return door.apply(this, arguments);
        })(HealthEngine.cloudEdit) });

        """
        return try HealthEngine(source: source, sourceURL: url, session: StubHTTP.session())
    }

    private func screenFails(_ fails: Bool, _ engine: HealthEngine) throws {
        _ = try engine.blocking { try $0.evaluate("__screenFails = \(fails)") }
    }

    private func cloudEdits(_ engine: HealthEngine) throws -> Int32 {
        try engine.blocking { try $0.evaluate("__cloudEdits").toInt32() }
    }

    /// A web record with one weight, as EraseUnitsGuardTests makes it.
    private func webRecord() throws -> [String: Any] {
        let engine = try HealthEngine()
        var json = try engine.blocking { try $0.newRecord(now: .now, deviceId: "web", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        json = try XCTUnwrap(engine.blocking { try $0.apply(.add(metric: "weight", value: 80, day: "2026-10-01"), to: json, now: .now, deviceId: "web") }.record)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    private func eraseEpoch(_ json: String) throws -> Int? {
        let record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        return record["eraseEpoch"] as? Int
    }

    private struct Held {
        let store: RecordStore
        let engine: HealthEngine
        /// The erased record the store holds.
        let record: String
    }

    /// The cloud record open with a weight, then "Delete all my data" while the engine cannot draw:
    /// the store holds the erased record with no drawing. The engine still cannot draw on return.
    private func heldErase() async throws -> Held {
        dropbox.put(try webRecord())
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test")
        let eraser = DataEraser(store: store, sync: sync, chat: chat, reminders: nil, health: nil, live: nil)
        await sync.start()
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        XCTAssertNotNil(store.myData?.vitals.first { $0.metric == "weight" }?.latest, "the weight before the erase")
        try screenFails(true, engine)
        if case .refused(let words) = await eraser.eraseAll() { XCTFail("the erase was refused: \(words)") }
        XCTAssertEqual(store.erasures, 1, "the store took the erase in")
        XCTAssertNil(store.myData, "held with no drawing: My data says the record did not load")
        XCTAssertFalse(store.predatesErase, "the held record is the erased one")
        return Held(store: store, engine: engine, record: store.recordJSON)
    }

    func testAHeldEraseIsDrawnOnReturnAndTakesEditsAgain_S45() async throws {
        let held = try await heldErase()
        let store = held.store
        try screenFails(false, held.engine)
        await store.redraw().value

        XCTAssertEqual(store.recordJSON, held.record, "the same erased record, now drawn")
        let data = try XCTUnwrap(store.myData, "My data shows the erased record")
        XCTAssertEqual(data.eraseEpoch, try eraseEpoch(held.record), "its rows are the erased record's")
        XCTAssertNil(data.vitals.first { $0.metric == "weight" }?.latest, "no row from before the erase")
        XCTAssertNotNil(store.plan)
        XCTAssertEqual(store.readable?.json, held.record)

        let edits = try cloudEdits(held.engine)
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 70, day: "2026-11-13")), "the record takes an edit again")
        XCTAssertEqual(try cloudEdits(held.engine), edits + 1, "the edit went through the cloud session")
        XCTAssertNotNil(store.myData?.vitals.first { $0.metric == "weight" }?.latest, "the new weight is shown")
    }

    /// Midnight calls the same redraw, at its own time.
    func testAHeldEraseIsDrawnAtMidnight_S45() async throws {
        let held = try await heldErase()
        try screenFails(false, held.engine)
        let midnight = Calendar.current.startOfDay(for: .now.addingTimeInterval(86_400))
        await held.store.redraw(now: midnight).value
        XCTAssertNotNil(held.store.myData, "drawn at midnight")
        XCTAssertEqual(held.store.recordJSON, held.record)
    }

    func testARedrawThatFailsAgainLeavesTheEraseHeld_S45() async throws {
        let held = try await heldErase()
        let store = held.store
        let draws = store.draws
        await store.redraw().value

        XCTAssertNil(store.myData, "still held with no drawing")
        XCTAssertEqual(store.draws, draws, "nothing drawn")
        XCTAssertEqual(store.recordJSON, held.record)
        XCTAssertFalse(store.predatesErase)
        let edits = try cloudEdits(held.engine)
        guard case .refused = await store.applyNow(.add(metric: "weight", value: 70, day: "2026-11-13")) else {
            return XCTFail("an edit landed in the held erase")
        }
        XCTAssertEqual(try cloudEdits(held.engine), edits, "nothing reached the session")
    }

    /// A record drawn as usual is drawn again as before: same record, one more draw.
    func testADrawnRecordIsRedrawnAsBefore_S45() async throws {
        let store = try RecordStore(folder: folder, engine: try engine(), deviceId: "test")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 87.3, day: "2026-10-20")))
        let (record, draws, revision) = (store.recordJSON, store.draws, store.revision)
        await store.redraw(now: .now.addingTimeInterval(86_400)).value
        XCTAssertEqual(store.draws, draws + 1)
        XCTAssertEqual(store.revision, revision, "the record did not change")
        XCTAssertEqual(store.recordJSON, record)
        XCTAssertNotNil(store.myData?.vitals.first { $0.metric == "weight" }?.latest)
    }
}
