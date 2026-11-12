import XCTest
@testable import HealthRoadmap

/// Survey S3 PR 2 (US-25 AC16, AC11m): "an erase is running" and the cloud connection,
/// through the app's own DataEraser, never CloudSync.erase alone. Pins first: an erase
/// begun while the cloud opens, is closed or is closing is refused with nothing erased
/// (the design delta's condition ii), and a sign-in that returns during a cloud erase's
/// engine call keeps nothing. Erases and sign-ins are held with gates, never a fixed delay.
@MainActor
final class EraseGateTests: XCTestCase, CloudFixtures {
    /// Holds the erase at its last step, the reminders' refresh, once armed: the cloud's
    /// part of the erase is over, the erase itself is not.
    @MainActor
    final class LastStep {
        var armed = false
        let reached: AsyncStream<Void>
        private let reach: AsyncStream<Void>.Continuation
        private let released: AsyncStream<Void>
        private let releaser: AsyncStream<Void>.Continuation

        init() {
            (reached, reach) = AsyncStream.makeStream(of: Void.self)
            (released, releaser) = AsyncStream.makeStream(of: Void.self)
        }

        func pass() async {
            guard armed else { return }
            armed = false
            reach.yield()
            for await _ in released { break }
        }

        func release() { releaser.yield() }
    }

    private struct App {
        let store: RecordStore
        let sync: CloudSync
        let chat: ChatHistoryStore
        let eraser: DataEraser
    }

    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!
    private var lastStep: LastStep!
    private let refusal = OAuthClient.Failure.refused("Wait for the erase to finish, then connect.")

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Erase Gate \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
        lastStep = LastStep()
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
    }

    /// The app's parts, as AppParts makes them, on the test folder and the stub; no Apple Health.
    private func app(connected: Bool) throws -> App {
        if connected { try write("dropbox", "sync-provider") }
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test")
        let lastStep = lastStep!
        let reminders = ReminderScheduler(center: FakeNotificationCenter(), folder: folder) { firstSeen in
            await lastStep.pass()
            return try await engine.reminders(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId, firstSeen: firstSeen)
        }
        let eraser = DataEraser(store: store, sync: sync, chat: chat, reminders: reminders, health: nil, live: nil)
        return App(store: store, sync: sync, chat: chat, eraser: eraser)
    }

    private func write(_ text: String, _ name: String) throws {
        try Data(text.utf8).write(to: folder.appending(path: name))
    }

    private func text(_ name: String) -> String? {
        try? String(contentsOf: folder.appending(path: name), encoding: .utf8)
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

    /// Waits until `done` holds: a poll on state, bounded at 10 s; the interval is not what a test depends on.
    private func until(_ what: String, file: StaticString = #filePath, line: UInt = #line, _ done: @MainActor () -> Bool) async throws {
        let deadline = Date.now.addingTimeInterval(10)
        while !done() {
            guard Date.now < deadline else { return XCTFail("never: \(what)", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(2))
        }
    }

    /// The error `connect` threw, or nil if it connected. Fails if it has not returned
    /// within 5 s: a connect that waits on something the test still holds.
    private func connectError(_ connect: Task<Void, Error>, file: StaticString = #filePath, line: UInt = #line) async -> Error? {
        let done = XCTestExpectation(description: "the connect returns")
        Task { _ = try? await connect.value; done.fulfill() }
        let waited = await XCTWaiter().fulfillment(of: [done], timeout: 5)
        XCTAssertEqual(waited, .completed, "the connect returned while the erase was held", file: file, line: line)
        do {
            try await connect.value
            return nil
        } catch {
            return error
        }
    }

    /// A step that holds the store's line until `release()`: a phone erase waits there.
    private func holdLine(_ store: RecordStore) -> () -> Void {
        let (released, release) = AsyncStream.makeStream(of: Void.self)
        store.chain { for await _ in released { break } }
        return { release.yield() }
    }

    /// The cloud's record and the one shown still hold their row: nothing was erased.
    private func assertNothingErased(_ app: App, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01"], "the cloud copy is not erased", file: file, line: line)
        XCTAssertEqual(activeDays(app.store.recordJSON), ["2026-10-01"], "the record shown is not erased", file: file, line: line)
    }

    // MARK: Condition ii: an erase with no shown session is refused

    func testAnEraseWhileTheCloudOpensIsRefusedAndErasesNothing() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let cloud = dropbox.file?.text
        let app = try app(connected: true)
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let read = nextDownload()
        let start = Task { await app.sync.start() }
        await arrive(read)
        XCTAssertEqual(app.sync.status, .connecting, "opening")
        let outcome = await app.eraser.eraseAll()
        XCTAssertEqual(outcome, .refused(EraseText.refusal(nil, provider: .dropbox)))
        XCTAssertEqual(dropbox.file?.text, cloud, "the cloud copy is untouched")
        XCTAssertEqual(dropbox.uploads, 0)
        gate.open()
        await start.value
        XCTAssertTrue(app.sync.recordOpen, "the open goes on")
        assertNothingErased(app)
    }

    func testAnEraseWhileTheCloudIsClosedIsRefusedAndErasesNothing() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let cloud = dropbox.file?.text
        let app = try app(connected: true)
        // Closed before any open: launched with a cloud on file.
        let early = await app.eraser.eraseAll()
        XCTAssertEqual(early, .refused(EraseText.refusal(nil, provider: .dropbox)))
        app.eraser.seen()
        // Closed after a failed open.
        dropbox.online = false
        await app.sync.start()
        XCTAssertEqual(app.sync.status, .problem(SyncProblem(kind: .unreachable)))
        let late = await app.eraser.eraseAll()
        XCTAssertEqual(late, .refused(EraseText.refusal(nil, provider: .dropbox)))
        XCTAssertEqual(app.sync.provider, .dropbox, "still connected")
        XCTAssertEqual(dropbox.file?.text, cloud, "the cloud copy is untouched")
        XCTAssertEqual(dropbox.uploads, 0)
        dropbox.online = true
        await app.sync.foreground()
        XCTAssertTrue(app.sync.recordOpen)
        assertNothingErased(app)
    }

    func testAnEraseWhileDisconnectClosesIsRefusedAndErasesNothing() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let app = try app(connected: true)
        await app.sync.start()
        XCTAssertTrue(app.sync.recordOpen)
        let (cloud, uploads) = (dropbox.file?.text, dropbox.uploads)
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let read = nextDownload()
        let disconnect = Task { await app.sync.disconnectOutcome() }
        await arrive(read) // the copy down
        XCTAssertEqual(app.sync.status, .disconnecting, "closing")
        let outcome = await app.eraser.eraseAll()
        XCTAssertEqual(outcome, .refused(EraseText.refusal(nil, provider: .dropbox)))
        gate.open()
        let ended = await disconnect.value
        XCTAssertEqual(ended, .done(copied: true), "the Disconnect goes on")
        XCTAssertNil(app.sync.provider)
        XCTAssertEqual(dropbox.file?.text, cloud, "the cloud copy is untouched")
        XCTAssertEqual(dropbox.uploads, uploads)
        assertNothingErased(app)
    }

    // MARK: A sign-in in flight when a cloud erase starts

    func testASignInThatReturnsDuringACloudErasesEngineCallKeepsNothing() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        let app = try app(connected: true)
        await app.sync.start()
        let held = heldSignIn()
        let connect = Task { try await app.sync.connect(.dropbox, authenticate: held.authenticate) }
        for await _ in held.shown { break }
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let read = nextDownload()
        let erase = Task { await app.eraser.eraseAll() }
        await arrive(read) // the erase's own read of the cloud
        held.release()
        let error = await connectError(connect)
        XCTAssertEqual(error as? OAuthClient.Failure, refusal)
        XCTAssertEqual(tokens.load(.dropbox)?.refreshToken, "r", "the sign-in was not kept")
        XCTAssertEqual(text("sync-account"), "dbid:A")
        gate.open()
        guard case .erased = await erase.value else { return XCTFail("the erase finishes") }
        XCTAssertEqual(app.sync.provider, .dropbox)
        XCTAssertEqual(activeDays(dropbox.record), [], "the erase reached the cloud")
    }
}
