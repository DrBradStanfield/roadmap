import XCTest
@testable import HealthRoadmap

/// US-25 AC11 against the REAL Dropbox, for the scratch account only
/// (brad@microvitamin.com; never a drstanfield.com account). Skipped unless an
/// access token for that account is passed at launch:
///   TEST_RUNNER_DROPBOX_E2E_TOKEN=<token> xcodebuild test ... -only-testing:HealthRoadmapTests/LiveDropboxTests
/// It writes one blood-test value through the app's own path and reads the file
/// back from Dropbox, then adds a row to the cloud file as another device would
/// and checks the app takes it in on a re-read. It never erases.
@MainActor
final class LiveDropboxTests: XCTestCase {
    private var token: String!
    private var folder: URL!
    private var tokens: TokenStore!

    override func setUp() async throws {
        guard let token = ProcessInfo.processInfo.environment["DROPBOX_E2E_TOKEN"], !token.isEmpty else {
            throw XCTSkip("Set TEST_RUNNER_DROPBOX_E2E_TOKEN to a scratch-account Dropbox token to run this.")
        }
        self.token = token
        folder = FileManager.default.temporaryDirectory.appending(path: "Live Dropbox \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: token, refreshToken: "none", expiresAt: .distantFuture), for: .dropbox)
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
    }

    override func tearDown() async throws {
        tokens?.delete(.dropbox)
        if let folder { try? FileManager.default.removeItem(at: folder) }
    }

    /// The cloud file as Dropbox holds it, with its rev.
    private func download() async throws -> (record: [String: Any], rev: String) {
        var request = URLRequest(url: URL(string: "https://content.dropboxapi.com/2/files/download")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token!)", forHTTPHeaderField: "Authorization")
        request.setValue(#"{"path":"/health-roadmap.json"}"#, forHTTPHeaderField: "Dropbox-API-Arg")
        let (data, response) = try await URLSession.shared.data(for: request)
        let http = try XCTUnwrap(response as? HTTPURLResponse)
        XCTAssertEqual(http.statusCode, 200)
        let meta = try JSONSerialization.jsonObject(with: Data((http.value(forHTTPHeaderField: "Dropbox-API-Result") ?? "{}").utf8)) as! [String: Any]
        return (try JSONSerialization.jsonObject(with: data) as! [String: Any], meta["rev"] as! String)
    }

    private func upload(_ json: String, rev: String) async throws {
        var request = URLRequest(url: URL(string: "https://content.dropboxapi.com/2/files/upload")!)
        request.httpMethod = "POST"
        request.setValue("Bearer \(token!)", forHTTPHeaderField: "Authorization")
        request.setValue("application/octet-stream", forHTTPHeaderField: "Content-Type")
        request.setValue(#"{"path":"/health-roadmap.json","mode":{".tag":"update","update":"\#(rev)"},"autorename":false,"mute":true,"strict_conflict":true}"#, forHTTPHeaderField: "Dropbox-API-Arg")
        request.httpBody = Data(json.utf8)
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private func rows(_ record: [String: Any], metric: String) -> [[String: Any]] {
        ((record["measurements"] as? [[String: Any]]) ?? []).filter { $0["metricType"] as? String == metric && $0["status"] as? String == "active" }
    }

    func testAPhoneValueReachesDropboxAndAWebRowReachesThePhone() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-e2e-\(UUID().uuidString.prefix(8))")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens))
        await sync.start()
        guard case .synced = sync.status else { return XCTFail("could not open the cloud record: \(sync.status)") }

        // 1. The phone writes a blood-test value; it reaches the file in Dropbox.
        // Two days back: never the future in any zone.
        let day = Date.now.addingTimeInterval(-2 * 86_400).formatted(.iso8601.year().month().day())
        let before = rows(try await download().record, metric: "hdl").count
        let saved = await store.apply(.add(metric: "hdl", value: 1.4, day: day))
        if case .refused(_, let existing?) = saved {
            await XCTAssertSaved(await store.apply(.correct(id: existing, value: 1.4)))
        } else {
            XCTAssertEqual(saved, .saved)
        }
        await sync.background()
        let afterPhone = try await download()
        XCTAssertTrue(rows(afterPhone.record, metric: "hdl").contains { ($0["recordedAt"] as? String)?.hasPrefix(day) == true },
                      "the phone's value is in Dropbox (\(before) hdl rows before)")

        // 2. Another device adds a row to the cloud file; a re-read brings it to the phone.
        let cloudJSON = String(decoding: try JSONSerialization.data(withJSONObject: afterPhone.record), as: UTF8.self)
        let other = try engine.blocking { try $0.apply(.add(metric: "ldl", value: 2.6, day: "2026-01-02"), to: cloudJSON, now: .now, deviceId: "web-e2e") }
        if let next = other.record {
            try await upload(next, rev: afterPhone.rev)
        } else {
            XCTAssertEqual(other.reason, "slot-occupied", "the row from an earlier run is already there")
        }
        await sync.syncNow()
        XCTAssertTrue(rows(try JSONSerialization.jsonObject(with: Data(store.recordJSON.utf8)) as! [String: Any], metric: "ldl")
            .contains { ($0["recordedAt"] as? String)?.hasPrefix("2026-01-02") == true }, "the web's row is on the phone")
        await sync.disconnect()
    }
}
