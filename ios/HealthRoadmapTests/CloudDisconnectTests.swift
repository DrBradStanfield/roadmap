import XCTest
@testable import HealthRoadmap

/// US-25 AC11m: the connection equals what a relaunch reads from disk, on every way a
/// Disconnect or a connect can fail. A file that cannot be removed is made immutable
/// (the user-immutable flag), so only that file stays; a fresh engine, store and
/// CloudSync on the same folder and Keychain play the relaunch.
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

    /// The app's parts on the test folder; `tokens` is the Keychain the OAuth client keeps to.
    private func app(connected: Bool = true, tokens kept: TokenStore? = nil) throws -> (store: RecordStore, sync: CloudSync) {
        if connected { try write("dropbox", "sync-provider") }
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        return (store, CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: kept ?? tokens, session: StubHTTP.session())))
    }

    /// The next launch: a fresh engine, store and CloudSync on the same folder and Keychain.
    private func relaunch() throws -> CloudSync {
        try app(connected: false).sync
    }

    private func write(_ text: String, _ name: String) throws {
        try Data(text.utf8).write(to: folder.appending(path: name))
    }

    private func text(_ name: String) -> String? {
        try? String(contentsOf: folder.appending(path: name), encoding: .utf8)
    }

    private func exists(_ name: String) -> Bool {
        FileManager.default.fileExists(atPath: folder.appending(path: name).path(percentEncoded: false))
    }

    /// Makes a file immutable (true) or not, so its removal fails.
    private func stick(_ name: String, _ on: Bool) {
        let path = folder.appending(path: name).path(percentEncoded: false)
        guard FileManager.default.fileExists(atPath: path) else { return }
        try? FileManager.default.setAttributes([.immutable: on], ofItemAtPath: path)
    }

    /// A relaunch reads the provider `sync` names, finds the tokens beside its provider file,
    /// and opens exactly when it can.
    private func assertARelaunchReadsTheSame(_ sync: CloudSync, opens: Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        if let onFile = text("sync-provider").flatMap(CloudProvider.init(rawValue:)) {
            XCTAssertNotNil(tokens.load(onFile), "never a provider file without tokens", file: file, line: line)
        }
        let next = try relaunch()
        XCTAssertEqual(next.provider, sync.provider, "a relaunch reads the same cloud", file: file, line: line)
        await next.start()
        XCTAssertEqual(next.recordOpen, opens, file: file, line: line)
    }

    // MARK: Disconnect

    /// The provider file cannot be removed: the Disconnect did not happen. Nothing else is
    /// touched, the cloud stays connected with its tokens and opens again, and a relaunch
    /// reads the same cloud.
    func testADisconnectWhoseProviderFileStaysKeepsTheCloud_US25_AC11m() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        try write("person@example.com", "sync-account-email")
        let (_, sync) = try app()
        await sync.start()
        XCTAssertTrue(sync.recordOpen)
        stick("sync-provider", true)
        let outcome = await sync.disconnectOutcome()
        XCTAssertEqual(outcome, .failed)
        XCTAssertEqual(sync.provider, .dropbox, "still connected")
        XCTAssertTrue(sync.recordOpen, "the record opened again")
        XCTAssertNotNil(tokens.load(.dropbox), "the tokens stay")
        XCTAssertEqual(text("sync-account"), "dbid:A", "nothing else was removed")
        XCTAssertEqual(sync.accountEmail, "person@example.com")
        XCTAssertEqual(SyncStatusText.disconnectFailed(.dropbox), "Couldn't disconnect from Dropbox. Try again.")
        stick("sync-provider", false)
        try await assertARelaunchReadsTheSame(sync, opens: true)
    }

    /// The provider file goes but the account file stays: the Disconnect happened, and the
    /// next launch removes what is left, a token whose removal failed included.
    func testADisconnectWhoseCleanupFailsEndsOnThePhoneAndTheNextLaunchFinishesIt_US25_AC11m() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        let (_, sync) = try app()
        await sync.start()
        stick("sync-account", true)
        let outcome = await sync.disconnectOutcome()
        XCTAssertEqual(outcome, .done(copied: true))
        XCTAssertNil(sync.provider)
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertFalse(exists("sync-provider"))
        XCTAssertTrue(exists("sync-account"), "the removal failed")
        try await assertARelaunchReadsTheSame(sync, opens: false)
        stick("sync-account", false)
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox) // as if signOut failed
        try write("1", "sync-pending")
        _ = try relaunch()
        XCTAssertFalse(exists("sync-account"), "the next launch removed it")
        XCTAssertFalse(exists("sync-pending"))
        XCTAssertNil(tokens.load(.dropbox), "and the token left behind")
    }

    /// Codex C1 on PR 1350: a second Disconnect while the first copies down changes nothing
    /// and closes nothing; a connect meanwhile is dropped; the files end agreeing with the state.
    func testASecondDisconnectWhileTheFirstClosesChangesNothing_US25_AC11m() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        let (_, sync) = try app()
        await sync.start()
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let copyDown = nextDownload()
        let first = Task { await sync.disconnectOutcome() }
        await arrive(copyDown)
        let second = await sync.disconnectOutcome()
        XCTAssertEqual(second, .refused, "a Disconnect is already closing")
        XCTAssertEqual(sync.status, .disconnecting)
        let dropped = XCTestExpectation(description: "a connect while closing returns at once")
        let reconnect = Task {
            defer { dropped.fulfill() }
            try await sync.connect(.dropbox, authenticate: signIn())
        }
        let returned = await XCTWaiter().fulfillment(of: [dropped], timeout: 5)
        XCTAssertEqual(returned, .completed, "a connect while closing is dropped at once")
        dropbox.downloadGate = nil
        gate.open()
        let outcome = await first.value
        _ = try? await reconnect.value
        XCTAssertEqual(outcome, .done(copied: true))
        XCTAssertNil(sync.provider)
        XCTAssertEqual(text("sync-provider"), sync.provider?.rawValue, "the files agree with the state")
        XCTAssertEqual(tokens.load(.dropbox) != nil, sync.provider == .dropbox, "the Keychain agrees with the state")
    }

    /// Codex C2 on PR 1350: the Keychain refuses to delete on Disconnect. The account file stays
    /// as the mark that a token is left, and the next launch removes the token.
    func testATokenTheKeychainKeptIsRemovedAtTheNextLaunch_US25_AC11m() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        var keeping = tokens!
        keeping.failsDeletes = true
        let (_, sync) = try app(tokens: keeping)
        await sync.start()
        _ = await sync.disconnectOutcome()
        XCTAssertNil(sync.provider)
        XCTAssertNotNil(tokens.load(.dropbox), "the Keychain kept it")
        _ = try relaunch()
        XCTAssertNil(tokens.load(.dropbox), "the next launch removed it")
        XCTAssertFalse(exists("sync-account"))
    }

    /// Fulfilled when the next record download reaches the fake Dropbox.
    private func nextDownload() -> XCTestExpectation {
        let arrived = XCTestExpectation(description: "a record download arrives")
        dropbox.onDownload = { [weak dropbox] in
            dropbox?.onDownload = nil
            arrived.fulfill()
        }
        return arrived
    }

    private func arrive(_ expectation: XCTestExpectation, file: StaticString = #filePath, line: UInt = #line) async {
        let result = await XCTWaiter().fulfillment(of: [expectation], timeout: 10)
        XCTAssertEqual(result, .completed, expectation.description, file: file, line: line)
    }

    /// The owner's ruling (2026-11-12): a copy-down that fails never stops Disconnect. With a
    /// session open and the cloud unreachable, the engine's copy answers 'unreachable';
    /// Disconnect goes on, ends on the phone and answers `copied: false`, for which Sync shows
    /// its existing words ("<cloud> could not be reached, so changes made on other devices…").
    func testACopyDownThatFailsStillEndsOnThePhone_US25_AC11m() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync) = try app()
        await sync.start()
        XCTAssertTrue(sync.recordOpen)
        dropbox.online = false
        let outcome = await sync.disconnectOutcome()
        XCTAssertEqual(outcome, .done(copied: false))
        XCTAssertNil(sync.provider)
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(store.cloudErase)
        XCTAssertFalse(exists("sync-provider"))
        XCTAssertNil(tokens.load(.dropbox))
    }

    // MARK: Connect

    /// The Keychain refuses the tokens on a first connect: nothing is kept, no sync file is
    /// written, and the phone stays on its own record.
    func testAFirstConnectWhoseTokensCannotBeKeptLeavesNothing_US25_AC11m() async throws {
        tokens.delete(.dropbox)
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        var refusing = tokens!
        refusing.failsSaves = true
        let (_, sync) = try app(connected: false, tokens: refusing)
        do {
            try await sync.connect(.dropbox, authenticate: signIn())
            XCTFail("a sign-in the Keychain refused cannot connect")
        } catch {
            XCTAssertTrue(error is KeychainError, "\(error)")
        }
        XCTAssertNil(sync.provider)
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(tokens.load(.dropbox))
        for name in ["sync-provider", "sync-account", "sync-account-email"] { XCTAssertFalse(exists(name), name) }
        try await assertARelaunchReadsTheSame(sync, opens: false)
    }

    /// A sync file cannot be written after the tokens were kept on a first connect: the
    /// tokens go again, and no provider file is left without them.
    func testAFirstConnectWhoseFileWriteFailsRemovesItsTokens_US25_AC11m() async throws {
        tokens.delete(.dropbox)
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (_, sync) = try app(connected: false)
        try FileManager.default.createDirectory(at: folder.appending(path: "sync-account-email"), withIntermediateDirectories: false) // a write there fails
        do {
            try await sync.connect(.dropbox, authenticate: signIn())
            XCTFail("a connect whose files cannot be written cannot connect")
        } catch {}
        XCTAssertNil(sync.provider)
        XCTAssertNil(tokens.load(.dropbox), "the kept tokens went again")
        XCTAssertFalse(exists("sync-provider"))
        try await assertARelaunchReadsTheSame(sync, opens: false)
        XCTAssertFalse(exists("sync-account"))
        XCTAssertFalse(exists("sync-account-email"), "the next launch removed the leftover")
    }

    /// Signing in again to the connected cloud, the Keychain refuses the new tokens: the
    /// cloud stays connected on its old tokens, closed, and a relaunch reads the same.
    func testASecondSignInWhoseTokensCannotBeKeptStaysConnected_US25_AC11m() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        var refusing = tokens!
        refusing.failsSaves = true
        let (store, sync) = try app(tokens: refusing)
        await sync.start()
        XCTAssertTrue(sync.recordOpen)
        do {
            try await sync.connect(.dropbox, authenticate: signIn())
            XCTFail("a sign-in the Keychain refused cannot connect")
        } catch {
            XCTAssertTrue(error is KeychainError, "\(error)")
        }
        XCTAssertEqual(sync.provider, .dropbox, "still connected")
        XCTAssertFalse(sync.recordOpen, "closed, nothing behind the phone's record")
        XCTAssertNil(store.cloudErase)
        XCTAssertEqual(tokens.load(.dropbox)?.refreshToken, "r", "the old tokens stay")
        XCTAssertEqual(text("sync-provider"), "dropbox")
        try await assertARelaunchReadsTheSame(sync, opens: true)
    }

    // MARK: Wiring

    /// CloudSync's status is the status function of its connection and the pending marker,
    /// at every point a caller reads it; a launch with a cloud on file opens it on start, so
    /// connecting is never a resting state.
    func testTheStatusIsReadFromTheConnectionOnly_US25_AC11m() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync) = try app()
        let derived = { CloudConnection.status(sync.connection, pending: self.exists("sync-pending")) }
        XCTAssertEqual(sync.connection, .closed(.init(provider: .dropbox, attempt: 0, connectedAt: 0)))
        XCTAssertEqual(sync.status, derived())
        await sync.start()
        guard case .open = sync.connection else { return XCTFail("start opened nothing: \(sync.connection)") }
        XCTAssertEqual(sync.status, derived())
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")))
        XCTAssertEqual(sync.status, derived())
        await sync.background()
        XCTAssertEqual(sync.status, derived())
        await sync.disconnect()
        XCTAssertEqual(sync.connection, .phone(attempt: 2))
        XCTAssertEqual(sync.status, derived())
    }
}
