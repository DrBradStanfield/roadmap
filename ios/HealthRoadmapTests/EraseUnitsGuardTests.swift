import XCTest
@testable import HealthRoadmap

/// S52 follow-up F6 (US-25 AC16, AC16f): after "Delete all my data" the eraser puts the user's units
/// back only onto a record it can read (DataEraser.keepUnits' guard). A cloud erase whose draw
/// fails leaves the store holding the erased record with no drawing, so `myData` is nil: the
/// units are not put back and no edit reaches the cloud session. The store's own guard on an
/// undrawn record would refuse such an edit too; this pins what the user and the cloud see.
@MainActor
final class EraseUnitsGuardTests: XCTestCase {
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Erase Units \(UUID().uuidString)")
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

    /// The bundled engine on the stub, as EraseHeldUndrawnTests makes it: its screen draw fails
    /// while `__screenFails` is set, and it counts the cloud session's edits in `__cloudEdits`.
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

    private func cloudEdits(_ engine: HealthEngine) throws -> Int32 {
        try engine.blocking { try $0.evaluate("__cloudEdits").toInt32() }
    }

    /// A web record with one weight, as DataEraserTests' `record(days:)` makes it.
    private func webRecord() throws -> [String: Any] {
        let engine = try HealthEngine()
        var json = try engine.blocking { try $0.newRecord(now: .now, deviceId: "web", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        json = try XCTUnwrap(engine.blocking { try $0.apply(.add(metric: "weight", value: 80, day: "2026-10-01"), to: json, now: .now, deviceId: "web") }.record)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    }

    private func unitSystem(_ json: String) throws -> String? {
        let record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        return (record["profile"] as? [String: Any])?["unitSystem"] as? String
    }

    func testAnEraseLeavingNoReadableRecordPutsNoUnitsBackAndSendsNoEdit_F6() async throws {
        dropbox.put(try webRecord())
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test")
        let eraser = DataEraser(store: store, sync: sync, chat: chat, reminders: nil, health: nil, live: nil)
        await sync.start()
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        await XCTAssertSaved(await store.apply(.units("conventional")))
        XCTAssertEqual(store.myData?.unitSystem, "conventional", "units the eraser would put back on a readable record")

        let edits = try cloudEdits(engine)
        _ = try engine.blocking { try $0.evaluate("__screenFails = true") }
        let outcome = await eraser.eraseAll()
        if case .refused(let words) = outcome { return XCTFail("the erase was refused: \(words)") }

        XCTAssertEqual(store.erasures, 1, "the store took the erase in")
        XCTAssertNil(store.myData, "the erased record is held with no drawing")
        XCTAssertNotEqual(try unitSystem(store.recordJSON), "conventional", "the units were not put back")
        XCTAssertEqual(try cloudEdits(engine), edits, "no edit reached the cloud session")
    }
}
