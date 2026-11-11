import XCTest
@testable import HealthRoadmap

/// US-25 AC11m: the connection equals what a relaunch reads from disk, on every way a
/// Disconnect or a connect can fail. A file that cannot be removed is made immutable
/// (the user-immutable flag), so only that file stays; a fresh CloudSync built on the
/// same folder plays the relaunch.
@MainActor
final class CloudDisconnectTests: XCTestCase, CloudFixtures {
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Cloud Disconnect \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        tokens.delete(.googleDrive)
        for name in ["sync-provider", "sync-account", "sync-account-email", "sync-pending"] { stick(name, false) }
        try? FileManager.default.removeItem(at: folder)
    }

    private func app(connected: Bool = true) throws -> (store: RecordStore, sync: CloudSync, engine: HealthEngine) {
        if connected { try write("dropbox", "sync-provider") }
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        return (store, relaunch(engine, store), engine)
    }

    /// A fresh CloudSync on the same folder and Keychain: what the next launch reads.
    private func relaunch(_ engine: HealthEngine, _ store: RecordStore) -> CloudSync {
        CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
    }

    private func write(_ text: String, _ name: String) throws {
        try Data(text.utf8).write(to: folder.appending(path: name))
    }

    private func text(_ name: String) -> String? {
        try? String(contentsOf: folder.appending(path: name), encoding: .utf8)
    }

    /// Makes a file immutable (true) or not, so its removal fails.
    private func stick(_ name: String, _ on: Bool) {
        let path = folder.appending(path: name).path(percentEncoded: false)
        guard FileManager.default.fileExists(atPath: path) else { return }
        try? FileManager.default.setAttributes([.immutable: on], ofItemAtPath: path)
    }

    // MARK: Disconnect

    /// The provider file cannot be removed: the Disconnect did not happen. The cloud stays
    /// connected with its tokens, and a relaunch reads the same cloud.
    func testADisconnectWhoseProviderFileStaysKeepsTheCloud_US25_AC11m() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        let (store, sync, engine) = try app()
        await sync.start()
        XCTAssertTrue(sync.recordOpen)
        stick("sync-provider", true)
        _ = await sync.disconnect()
        XCTAssertEqual(sync.provider, .dropbox, "still connected")
        XCTAssertNotNil(tokens.load(.dropbox), "the tokens stay")
        XCTAssertEqual(text("sync-account"), "dbid:A", "nothing else was removed")
        XCTAssertEqual(relaunch(engine, store).provider, sync.provider, "a relaunch reads the same cloud")
    }
}
