import XCTest
@testable import HealthRoadmap

/// US-11 (lead H114): My health's words when the record cannot be drawn, read from the store's
/// Hold (UndrawnRecord.text), and a pin that a cloud record held with no drawing still erases
/// through the open session from that page's Settings. Built as RedrawHeldEraseTests is: a real
/// cloud session on a fake Dropbox while the engine's screen draw fails.
@MainActor
final class UndrawnRecordTests: XCTestCase {
    /// Each hold gives today's heading and words; only a drawn record gives none (no page).
    func testEachHoldsWords_US11_H114() {
        let refused = RecordProblem(HealthEngine.EngineError.refused("A newer version of Health Roadmap wrote this record. Update the app to open it."))
        let failed = RecordProblem(HealthEngine.EngineError.loadFailed("test"))
        let didNotLoad = (heading: "Your record did not load", words: "")
        let rows: [(RecordStore.Hold, RecordProblem?, (heading: String, words: String)?)] = [
            (.readable, nil, nil),
            (.heldUndrawn, nil, didNotLoad),
            (.empty, nil, didNotLoad),
            (.predatesErase, nil, didNotLoad),
            (.unreadable(kept: true), refused, ("Your record could not be opened", refused.words)),
            (.unreadable(kept: false), failed, ("Your record did not load", failed.words)),
        ]
        for (hold, problem, expected) in rows {
            let text = UndrawnRecord.text(hold: hold, problem: problem)
            XCTAssertEqual(text?.heading, expected?.heading, "\(hold)")
            XCTAssertEqual(text?.words, expected?.words, "\(hold)")
        }
        XCTAssertTrue(refused.words.hasPrefix("Your saved record could not be opened, so nothing will be saved over it."), refused.words)
    }

    // MARK: A held cloud record erases

    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Undrawn Record \(UUID().uuidString)")
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

    /// A web record with one weight.
    private func webRecord() throws -> [String: Any] {
        let engine = try HealthEngine()
        var json = try engine.blocking { try $0.newRecord(now: .now, deviceId: "web", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        json = try XCTUnwrap(engine.blocking { try $0.apply(.add(metric: "weight", value: 80, day: "2026-10-01"), to: json, now: .now, deviceId: "web") }.record)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    private func record(_ json: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    private func eraseEpoch(_ json: String) throws -> Int {
        (try record(json)["meta"] as? [String: Any])?["eraseEpoch"] as? Int ?? 0
    }

    private func weights(_ json: String) throws -> Int {
        (try record(json)["measurements"] as? [[String: Any]] ?? [])
            .filter { $0["metricType"] as? String == "weight" && $0["status"] as? String == "active" }.count
    }

    /// A cloud edit whose draw fails leaves the record held with no drawing (lead H17): My health
    /// shows the "did not load" page. Delete all my data from its Settings erases through the open
    /// session: the cloud file holds the higher eraseEpoch and no weight, so no copy stays there.
    func testACloudRecordHeldUndrawnIsErasedThroughTheSession_US11_H114() async throws {
        dropbox.put(try webRecord())
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test")
        let eraser = DataEraser(store: store, sync: sync, chat: chat, reminders: nil, health: nil, live: nil)
        await sync.start()
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        _ = try engine.blocking { try $0.evaluate("__screenFails = true") }
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 70, day: "2026-11-13")), "the session took the edit")
        XCTAssertEqual(store.hold, .heldUndrawn)
        XCTAssertNil(store.myData)
        XCTAssertEqual(UndrawnRecord.text(hold: store.hold, problem: store.problem)?.heading, "Your record did not load", "the undrawn page shows")
        let before = try eraseEpoch(XCTUnwrap(dropbox.file?.text))

        if case .refused(let words) = await eraser.eraseAll() { return XCTFail("the erase was refused: \(words)") }

        let cloud = try XCTUnwrap(dropbox.file?.text, "the erase reached the session's file")
        XCTAssertGreaterThan(try eraseEpoch(cloud), before, "the cloud file holds the higher eraseEpoch")
        XCTAssertEqual(try weights(cloud), 0, "no weight stays in the cloud file")
        XCTAssertEqual(store.erasures, 1, "the store took the erase in")
        withExtendedLifetime(sync) {}
    }
}
