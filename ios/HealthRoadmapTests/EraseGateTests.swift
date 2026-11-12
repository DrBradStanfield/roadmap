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

    struct StillRunning: Error {}

    /// The error `connect` threw, or nil if it connected. `StillRunning` if it has not
    /// returned within 5 s: a connect that waits on something the test still holds.
    private func connectError(_ connect: Task<Void, Error>, file: StaticString = #filePath, line: UInt = #line) async -> Error? {
        let done = XCTestExpectation(description: "the connect returns")
        Task { _ = try? await connect.value; done.fulfill() }
        guard await XCTWaiter().fulfillment(of: [done], timeout: 5) == .completed else {
            XCTFail("the connect did not return while the erase was held", file: file, line: line)
            return StillRunning()
        }
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

    /// A first connect's open, which lifts the phone's record into the cloud's, is in flight.
    func testAnEraseWhileAFirstConnectOpensIsRefusedAndErasesNothing() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let cloud = dropbox.file?.text
        let app = try app(connected: false)
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let read = nextDownload()
        let authenticate = signIn()
        let connect = Task { try await app.sync.connect(.dropbox, authenticate: authenticate) }
        await arrive(read) // the first connect's open
        XCTAssertEqual(app.sync.status, .connecting, "opening, first connect")
        let outcome = await app.eraser.eraseAll()
        XCTAssertEqual(outcome, .refused(EraseText.refusal(nil, provider: .dropbox)))
        XCTAssertEqual(dropbox.file?.text, cloud, "the cloud copy is untouched")
        XCTAssertEqual(dropbox.uploads, 0)
        gate.open()
        try await connect.value
        XCTAssertTrue(app.sync.recordOpen, "the connect goes on")
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

    // MARK: AC16e: Connect and Disconnect wait for the whole erase

    /// No sign-in kept and nothing lifted: no provider or account file, the tokens as
    /// they were, and no record in the cloud.
    private func assertNothingKept(_ app: App, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertNil(app.sync.provider, "still on the phone", file: file, line: line)
        XCTAssertNil(text("sync-provider"), "no provider file", file: file, line: line)
        XCTAssertNil(text("sync-account"), file: file, line: line)
        XCTAssertEqual(tokens.load(.dropbox)?.refreshToken, "r", "the sign-in was not kept", file: file, line: line)
        XCTAssertNil(dropbox.file, "nothing was lifted into the cloud", file: file, line: line)
        XCTAssertEqual(dropbox.uploads, 0, file: file, line: line)
    }

    func testAConnectDuringAPhoneOnlyEraseIsRefused_US25_AC16e() async throws {
        let app = try app(connected: false)
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        let release = holdLine(app.store)
        let erase = Task { await app.eraser.eraseAll() }
        try await until("the erase runs") { app.eraser.erasing }
        let authenticate = signIn()
        let connect = Task { try await app.sync.connect(.dropbox, authenticate: authenticate) }
        let error = await connectError(connect)
        XCTAssertEqual(error as? OAuthClient.Failure, refusal, "refused before the sign-in shows")
        release()
        guard case .erased = await erase.value else { return XCTFail("the erase finishes") }
        _ = try? await connect.value
        assertNothingKept(app)
    }

    /// Condition 3: a sign-in begun before a phone-only erase, returning during it, never
    /// lifts the half-erased record into the cloud.
    func testASignInThatReturnsDuringAPhoneOnlyEraseLiftsNothing_US25_AC16e() async throws {
        let app = try app(connected: false)
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        let held = heldSignIn()
        let connect = Task { try await app.sync.connect(.dropbox, authenticate: held.authenticate) }
        for await _ in held.shown { break }
        let release = holdLine(app.store)
        let erase = Task { await app.eraser.eraseAll() }
        try await until("the erase runs") { app.eraser.erasing }
        held.release()
        let error = await connectError(connect)
        XCTAssertEqual(error as? OAuthClient.Failure, refusal, "refused as the sign-in returns")
        release()
        guard case .erased = await erase.value else { return XCTFail("the erase finishes") }
        _ = try? await connect.value
        assertNothingKept(app)
        XCTAssertEqual(activeDays(app.store.recordJSON), [], "the erase landed on the phone")
    }

    /// A cloud erase held at its last step: its engine call is over, its words do not show yet.
    func testConnectAndDisconnectWaitForACloudErasesLastSteps_US25_AC16e() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        let app = try app(connected: true)
        await app.sync.start()
        let held = heldSignIn()
        let late = Task { try await app.sync.connect(.dropbox, authenticate: held.authenticate) }
        for await _ in held.shown { break }
        lastStep.armed = true
        let erase = Task { await app.eraser.eraseAll() }
        for await _ in lastStep.reached { break }
        XCTAssertTrue(app.eraser.erasing, "the cloud's part is over, the erase is not")
        held.release()
        let lateError = await connectError(late)
        XCTAssertEqual(lateError as? OAuthClient.Failure, refusal, "a sign-in begun before the erase keeps nothing")
        let authenticate = signIn()
        let now = Task { try await app.sync.connect(.dropbox, authenticate: authenticate) }
        let nowError = await connectError(now)
        XCTAssertEqual(nowError as? OAuthClient.Failure, refusal, "a connect is refused before its sign-in")
        let disconnect = await app.sync.disconnectOutcome()
        XCTAssertEqual(disconnect, .refused, "Disconnect waits for the erase's words")
        XCTAssertEqual(app.sync.provider, .dropbox)
        XCTAssertEqual(text("sync-provider"), "dropbox")
        XCTAssertEqual(text("sync-account"), "dbid:A")
        XCTAssertEqual(tokens.load(.dropbox)?.refreshToken, "r", "no sign-in was kept")
        lastStep.release()
        guard case .erased = await erase.value else { return XCTFail("the erase finishes") }
        XCTAssertEqual(activeDays(dropbox.record), [], "the erase reached the cloud")
    }

    /// US-25 AC11n, condition 2: a switch is refused for the whole of an erase, here at its last
    /// step, with the existing words, before its Disconnect: nothing closes, no sign-in shows.
    func testASwitchWaitsForTheWholeErase_US25_AC11n() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        let app = try app(connected: true)
        await app.sync.start()
        lastStep.armed = true
        let erase = Task { await app.eraser.eraseAll() }
        for await _ in lastStep.reached { break }
        XCTAssertTrue(app.eraser.erasing)
        let noSignIn: OAuthClient.Authenticate = { _, _ in
            XCTFail("no sign-in sheet shows")
            throw OAuthClient.Failure.cancelled
        }
        do {
            _ = try await app.sync.switchTo(.googleDrive, authenticate: noSignIn)
            XCTFail("a switch waits for the erase")
        } catch {
            XCTAssertEqual(error as? OAuthClient.Failure, refusal)
        }
        XCTAssertEqual(app.sync.provider, .dropbox)
        XCTAssertNotEqual(app.sync.status, .disconnecting, "the Disconnect never began")
        XCTAssertEqual(text("sync-provider"), "dropbox")
        XCTAssertEqual(text("sync-account"), "dbid:A")
        XCTAssertEqual(tokens.load(.dropbox)?.refreshToken, "r")
        lastStep.release()
        guard case .erased = await erase.value else { return XCTFail("the erase finishes") }
        XCTAssertEqual(app.sync.provider, .dropbox)
    }

    // MARK: The one source: DataEraser.phase, read through eraseRunning

    func testEraseRunningIsTrueOnlyWhileTheEraserErases_US25_AC16e() async throws {
        let app = try app(connected: false)
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        XCTAssertFalse(app.sync.eraseRunning())
        let release = holdLine(app.store)
        let erase = Task { await app.eraser.eraseAll() }
        try await until("the erase runs") { app.eraser.erasing }
        XCTAssertTrue(app.sync.eraseRunning(), "true while the eraser erases")
        app.eraser.settingsClosed()
        XCTAssertTrue(app.sync.eraseRunning(), "and while it erases with the sheet closed")
        release()
        guard case .erased = await erase.value else { return XCTFail("the erase finishes") }
        XCTAssertFalse(app.eraser.erasing)
        XCTAssertFalse(app.sync.eraseRunning(), "false once the words show")
    }

    /// The owner's ruling (d): DataEraser's init is the wiring. One built on its own, with no
    /// other call, is what Connect and Disconnect wait for.
    func testADataEraserBuiltOnItsOwnIsWhatConnectWaitsFor_US25_AC16e() async throws {
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let eraser = DataEraser(store: store, sync: sync, chat: ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test"), reminders: nil, health: nil, live: nil)
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        XCTAssertFalse(sync.eraseRunning())
        let release = holdLine(store)
        let erase = Task { await eraser.eraseAll() }
        try await until("the erase runs") { eraser.erasing }
        XCTAssertTrue(sync.eraseRunning(), "true while it erases")
        release()
        guard case .erased = await erase.value else { return XCTFail("the erase finishes") }
        XCTAssertFalse(sync.eraseRunning(), "false after")
    }

    /// Condition (i): a view reading `sync.eraseRunning()` redraws as the eraser's phase moves:
    /// the read registers through the closure, on start and on finish.
    func testAReadOfEraseRunningIsTrackedAndFiresOnStartAndFinish_US25_AC16e() async throws {
        let app = try app(connected: false)
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        let release = holdLine(app.store)
        let started = XCTestExpectation(description: "a change as the erase starts")
        withObservationTracking { _ = app.sync.eraseRunning() } onChange: { started.fulfill() }
        let erase = Task { await app.eraser.eraseAll() }
        await arrive(started)
        XCTAssertTrue(app.sync.eraseRunning())
        let finished = XCTestExpectation(description: "a change as the erase finishes")
        withObservationTracking { _ = app.sync.eraseRunning() } onChange: { finished.fulfill() }
        release()
        await arrive(finished)
        guard case .erased = await erase.value else { return XCTFail("the erase finishes") }
        XCTAssertFalse(app.sync.eraseRunning())
    }
}
