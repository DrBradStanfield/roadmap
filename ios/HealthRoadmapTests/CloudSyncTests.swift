import XCTest
@testable import HealthRoadmap

/// US-25 AC8, end to end inside the app: My data's store, the CloudSync, the
/// engine's RecordSession in JavaScriptCore, the fetch bridge, and a stubbed
/// Dropbox with Dropbox's rev rules (StubHTTP). Node runs the engine half alone
/// in ios/engine/cloud.test.ts.
@MainActor
final class CloudSyncTests: XCTestCase {
    /// Dropbox's download and upload, in memory, with rev-conditional writes.
    final class FakeDropbox {
        var file: (text: String, rev: Int)?
        var uploads = 0
        /// Runs once, just before the next upload lands: another device writing first.
        var beforeNextUpload: (() -> Void)?

        func put(_ record: [String: Any]) {
            let data = try! JSONSerialization.data(withJSONObject: record)
            file = (String(decoding: data, as: UTF8.self), (file?.rev ?? 0) + 1)
        }

        var record: [String: Any] {
            try! JSONSerialization.jsonObject(with: Data(file!.text.utf8)) as! [String: Any]
        }

        func answer(_ request: StubHTTP.Request) -> StubHTTP.Answer {
            if request.url.path == "/oauth2/token" {
                return .init(body: Data(#"{"access_token":"token-1","refresh_token":"r","expires_in":14400}"#.utf8))
            }
            guard request.headers["authorization"] == "Bearer token-1" else { return .init(status: 401) }
            let arg = try! JSONSerialization.jsonObject(with: Data(request.headers["dropbox-api-arg"]!.utf8)) as! [String: Any]
            if request.url.path.hasSuffix("/files/download") {
                guard let file else { return .init(status: 409, body: Data(#"{"error_summary":"path/not_found/"}"#.utf8)) }
                return .init(headers: ["Dropbox-API-Result": #"{"rev":"r\#(file.rev)"}"#], body: Data(file.text.utf8))
            }
            beforeNextUpload?()
            beforeNextUpload = nil
            let mode = arg["mode"] as? [String: Any]
            let expected = mode?[".tag"] as? String == "update" ? mode?["update"] as? String : nil
            let current = file.map { "r\($0.rev)" }
            guard expected == current else { return .init(status: 409, body: Data(#"{"error_summary":"path/conflict/"}"#.utf8)) }
            uploads += 1
            file = (String(decoding: request.body, as: UTF8.self), (file?.rev ?? 0) + 1)
            return .init(body: Data(#"{"rev":"r\#(file!.rev)"}"#.utf8))
        }
    }

    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: FakeDropbox!
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Cloud Sync \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
    }

    /// The app's parts, as AppParts makes them, on the test folder and the stub.
    private func app(connected: Bool = true) throws -> (store: RecordStore, sync: CloudSync, engine: HealthEngine) {
        if connected { try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider")) }
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        return (store, sync, engine)
    }

    /// A record from the engine with one weight row per day, written by `device`.
    private func record(days: [String], device: String) throws -> [String: Any] {
        let engine = try HealthEngine()
        var json = try engine.newRecord(now: now, deviceId: device, locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        for day in days {
            json = try XCTUnwrap(engine.apply(.add(metric: "weight", value: 80, day: day), to: json, now: now, deviceId: device).record)
        }
        return try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
    }

    private func activeDays(_ record: [String: Any]) -> [String] {
        ((record["measurements"] as? [[String: Any]]) ?? [])
            .filter { $0["status"] as? String == "active" }
            .compactMap { ($0["recordedAt"] as? String).map { String($0.prefix(10)) } }
            .sorted()
    }

    private func activeDays(_ json: String) -> [String] {
        activeDays(try! JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any])
    }

    func testAnEditWhoseFirstWriteConflictsEndsWithBothRows() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        let web = try record(days: ["2026-10-03"], device: "web")
        dropbox.beforeNextUpload = { [dropbox] in dropbox!.put(web) }

        XCTAssertEqual(store.apply(.add(metric: "weight", value: 81, day: "2026-10-04")), .saved)
        XCTAssertEqual(sync.status, .saving)
        await sync.background()

        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-03", "2026-10-04"], "the merge kept both devices' rows")
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-03", "2026-10-04"], "and the screen shows both")
        guard case .synced = sync.status else { return XCTFail("status is \(sync.status)") }
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appending(path: "sync-pending").path(percentEncoded: false)))
    }

    func testAnEraseFromAnotherDeviceIsTakenIn() async throws {
        let before = try record(days: ["2026-10-01"], device: "web")
        dropbox.put(before)
        let (store, sync, _) = try app()
        await sync.start()
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01"])

        // The web's erase: a higher eraseEpoch, and the rows it removed listed.
        var erased = before
        let ids = ((before["measurements"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }
        erased["measurements"] = []
        erased["erasedRows"] = ["fromEpoch": 1, "ids": ids]
        var meta = before["meta"] as! [String: Any]
        meta["eraseEpoch"] = 1
        meta["erasedAt"] = "2026-10-21T09:00:00.000Z"
        meta["updatedAt"] = "2026-10-21T09:00:00.000Z"
        meta["lamport"] = ((meta["lamport"] as? Int) ?? 0) + 10
        erased["meta"] = meta
        dropbox.put(erased)

        await sync.syncNow()
        XCTAssertEqual(activeDays(store.recordJSON), [], "the erase reached the phone")
        let shown = try JSONSerialization.jsonObject(with: Data(store.recordJSON.utf8)) as! [String: Any]
        XCTAssertEqual((shown["meta"] as? [String: Any])?["eraseEpoch"] as? Int, 1)
    }

    func testDisconnectReturnsToThePhoneRecordHoldingTheCloudRows() async throws {
        dropbox.put(try record(days: ["2026-10-01", "2026-10-02"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        let uploads = dropbox.uploads

        let copied = await sync.disconnect()
        XCTAssertTrue(copied)
        XCTAssertNil(store.cloudErase, "edits go to the phone's file again")
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(sync.provider)
        XCTAssertNil(tokens.load(.dropbox), "the tokens are gone")
        XCTAssertEqual(dropbox.uploads, uploads, "the cloud file was not written")
        let onPhone = try String(contentsOf: folder.appending(path: "health-roadmap.json"), encoding: .utf8)
        XCTAssertEqual(activeDays(onPhone), ["2026-10-01", "2026-10-02"])
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 82, day: "2026-10-05")), .saved)
        XCTAssertEqual(dropbox.uploads, uploads)
    }

    func testFirstConnectMergesThePhoneRecordUp() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app(connected: false)
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 79, day: "2026-10-02")), .saved)
        try await sync.connect(.dropbox) { url, _ in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "db-xf96vqvjotm5xhx://2/token?code=c&state=\(state)")!
        }
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01", "2026-10-02"])
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01", "2026-10-02"])
    }

    func testACloudThatCannotBeReachedLeavesThePhoneRecordAndMarksEditsForLater() async throws {
        StubHTTP.handler = { _ in .init(offline: true) }
        let (store, sync, _) = try app()
        await sync.start()
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)))
        XCTAssertNil(store.cloudErase)
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 80, day: "2026-10-06")), .saved)
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appending(path: "sync-pending").path(percentEncoded: false)))

        // Back online: the next open merges the phone's edit up.
        dropbox.put(try record(days: [], device: "web"))
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
        await sync.foreground()
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-06"])
    }
}
