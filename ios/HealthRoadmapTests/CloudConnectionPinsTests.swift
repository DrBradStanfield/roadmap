import XCTest
@testable import HealthRoadmap

/// Survey S3 pins (US-25 AC11k, 2026-11-12): what callers of CloudSync see today,
/// pinned before its connection mode moves into one `CloudConnection` union with a
/// pure transition. Each test reads only what a caller reads: status, provider,
/// recordOpen, accountEmail, syncedBefore, the store's screen and record,
/// the files on disk and the tokens. Opens, erases and re-reads are held with a
/// StubHTTP.Gate, never a fixed delay. Two polls wait on a state, not a timing:
/// `untilQueued` (the store's line) and `untilRead` (a read with no hook). Behaviour CloudSyncTests already pins is not
/// repeated here. A test marked "S3 design question" pins today's behaviour, which
/// may not be the behaviour wanted: the refactor keeps it unless that is decided.
@MainActor
final class CloudConnectionPinsTests: XCTestCase, CloudFixtures {
    /// Record downloads, counted as each request arrives (on URLSession's thread).
    final class Count: @unchecked Sendable {
        private let lock = NSLock()
        private var count = 0
        var value: Int { lock.withLock { count } }
        func add() { lock.withLock { count += 1 } }
    }

    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!
    private var downloads: Count!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Cloud Pins \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        downloads = Count()
        let (fake, count) = (dropbox!, downloads!)
        StubHTTP.handler = { request in
            if request.url.path.hasSuffix("/files/download"), request.headers["dropbox-api-arg"]?.contains("/health-roadmap.json") == true { count.add() }
            return fake.answer(request)
        }
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
    }

    /// The app's parts, as AppParts makes them, on the test folder and the stub.
    private func app(connected: Bool = true) throws -> (store: RecordStore, sync: CloudSync, engine: HealthEngine) {
        if connected { try write("dropbox", "sync-provider") }
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        return (store, sync, engine)
    }

    private func write(_ text: String, _ name: String) throws {
        try Data(text.utf8).write(to: folder.appending(path: name))
    }

    private func text(_ name: String) -> String? {
        try? String(contentsOf: folder.appending(path: name), encoding: .utf8)
    }

    private var phoneRecord: String { text("health-roadmap.json") ?? "" }

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

    /// True when `work` returns while a gate still holds the download it would need.
    /// The timeout is only the failure path: a call that waits on the gate never returns.
    private func returnsWhileHeld(_ work: @escaping @MainActor () async -> Void) async -> Bool {
        let done = XCTestExpectation(description: "returns while the download is held")
        Task { await work(); done.fulfill() }
        return await XCTWaiter().fulfillment(of: [done], timeout: 5) == .completed
    }

    /// Steps asked of the store's line so far (RecordStore's private `chained`, read by
    /// reflection: the line has no other sign that a step joined it).
    private func steps(_ store: RecordStore) -> Int {
        Mirror(reflecting: store).children.first { $0.label == "chained" }?.value as? Int ?? -1
    }

    /// Waits until the store's line holds more than `count` steps. A poll on that state,
    /// bounded at 10 s; the interval is not what the test depends on.
    private func untilQueued(_ store: RecordStore, beyond count: Int, file: StaticString = #filePath, line: UInt = #line) async throws {
        let deadline = Date.now.addingTimeInterval(10)
        while steps(store) <= count {
            guard Date.now < deadline else { return XCTFail("the store's line never grew past \(count)", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(2))
        }
    }

    /// A step that holds the store's line until `release()`.
    private func holdLine(_ store: RecordStore) -> () -> Void {
        let (released, release) = AsyncStream.makeStream(of: Void.self)
        store.chain { for await _ in released { break } }
        return { release.yield() }
    }

    private func news(_ event: String, _ payload: String = "", order: Int = 1_000_000) -> HealthEngine.CloudNews {
        .init(event, payload, order: order)
    }

    private func changed(days: [String], session: Int) throws -> HealthEngine.CloudNews {
        let record = String(decoding: try JSONSerialization.data(withJSONObject: try record(days: days, device: "web")), as: UTF8.self)
        let view = String(decoding: try JSONSerialization.data(withJSONObject: ["record": record, "erase": "e-news", "session": session]), as: UTF8.self)
        return news("changed", view)
    }

    private let full = #"{"kind":"storage-full","detail":"Dropbox is full."}"#

    // MARK: 1 · Init

    func testWithNoCloudOnFileItIsOnThePhoneAndStartOpensNothing() async throws {
        try write("person@example.com", "sync-account-email") // left by an older build: not read without a provider
        try write("dropbox", "sync-history")
        let (store, sync, engine) = try app(connected: false)
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(sync.provider)
        XCTAssertFalse(sync.recordOpen)
        XCTAssertNil(sync.accountEmail, "an email on file without a provider is not shown")
        XCTAssertEqual(sync.syncedBefore, .dropbox, "the cloud synced before is read whatever is connected")
        await sync.start()
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(store.cloudErase)
        XCTAssertEqual(downloads.value, 0, "start with no cloud on file opens nothing")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")))
        engine.blocking { _ in } // a marker would be set on the engine's queue
        XCTAssertNil(text("sync-pending"), "no cloud on file: an edit is not marked for one")
        XCTAssertEqual(store.recordSource, "phone")
    }

    func testWithACloudOnFileItIsConnectingBeforeStartAndNothingIsOpen() throws {
        try write("person@example.com", "sync-account-email")
        let (store, sync, _) = try app()
        XCTAssertEqual(sync.status, .connecting)
        XCTAssertEqual(sync.provider, .dropbox)
        XCTAssertFalse(sync.recordOpen, "connecting is not open (US-54 AC2)")
        XCTAssertEqual(sync.accountEmail, "person@example.com")
        XCTAssertNil(sync.syncedBefore, "never synced")
        XCTAssertNil(store.cloudErase)
        XCTAssertEqual(downloads.value, 0, "init opens nothing")
    }

    // MARK: 2 · start()

    func testAStartThatLandsIsSyncedOpenAndRemembered() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        guard case .synced = sync.status else { return XCTFail("status is \(sync.status)") }
        XCTAssertTrue(sync.recordOpen)
        XCTAssertEqual(sync.provider, .dropbox)
        XCTAssertNotNil(store.cloudErase)
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01"])
        XCTAssertEqual(sync.syncedBefore, .dropbox)
        XCTAssertEqual(text("sync-history"), "dropbox")
        XCTAssertEqual(downloads.value, 1, "one open, one read")
    }

    func testAStartThatFailsKeepsTheCloudOnFileAndIsNotOpen() async throws {
        dropbox.online = false
        let (store, sync, _) = try app()
        await sync.start()
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)))
        XCTAssertEqual(sync.provider, .dropbox, "the cloud stays connected")
        XCTAssertEqual(text("sync-provider"), "dropbox")
        XCTAssertNotNil(tokens.load(.dropbox))
        XCTAssertFalse(sync.recordOpen)
        XCTAssertNil(store.cloudErase)
        XCTAssertNil(sync.syncedBefore, "a failed open is not a sync")
        XCTAssertNil(text("sync-history"))
    }

    // MARK: 3 · Single flight

    func testAnOpenAskedForDuringAnotherJoinsItAndTheFirstLandsOnce() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let (store, sync, _) = try app()
        let read = nextDownload()
        let opening = Task { await sync.start() }
        await arrive(read)
        let foreground = await returnsWhileHeld { await sync.foreground() }
        let start = await returnsWhileHeld { await sync.start() }
        let syncNow = await returnsWhileHeld { await sync.syncNow() }
        XCTAssertTrue(foreground, "foreground joined the open in flight")
        XCTAssertTrue(start, "start joined the open in flight")
        XCTAssertTrue(syncNow, "Sync now joined the open in flight")
        XCTAssertEqual(sync.status, .connecting)
        XCTAssertFalse(sync.recordOpen)
        XCTAssertEqual(downloads.value, 1, "no second open began")
        gate.open()
        await opening.value
        guard case .synced = sync.status else { return XCTFail("status is \(sync.status)") }
        XCTAssertTrue(sync.recordOpen)
        XCTAssertNotNil(store.cloudErase)
        XCTAssertEqual(downloads.value, 1, "the open ran once")
    }

    // MARK: 4 · Edits during an open (A5 and F3 in CloudSyncTests pin the outcome)

    func testAnEditWhileOpeningMakesTheOpenGoRoundOnceMore() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let (store, sync, _) = try app()
        let read = nextDownload()
        let opening = Task { await sync.start() }
        await arrive(read)
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 79, day: "2026-10-02")), "the phone takes it meanwhile")
        XCTAssertEqual(sync.status, .connecting, "an edit while opening does not move the status")
        // The second try's read is held at a second gate: counted there, before any
        // save the landed open schedules can read again (PERSIST_DEBOUNCE_MS).
        let again = StubHTTP.Gate()
        dropbox.downloadGate = again
        let reread = nextDownload()
        gate.open()
        await arrive(reread)
        XCTAssertEqual(downloads.value, 2, "the open went round once more")
        XCTAssertEqual(sync.status, .connecting)
        XCTAssertFalse(sync.recordOpen)
        dropbox.downloadGate = nil
        again.open()
        await opening.value
        XCTAssertTrue(sync.recordOpen)
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01", "2026-10-02"])
    }

    /// Every record read is held at its own gate, and an edit lands on the phone
    /// before the read is let go, so each try sees an edit before its handover decides:
    /// the order is the test's, not the main queue's. The number of tries (3) is not
    /// pinned as a read count: a try also reads in the previous session's closing
    /// save, and each held read here sends one more edit.
    func testEditsThatKeepArrivingEndBusyStayConnectedAndTheNextForegroundOpens() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, _) = try app()
        enum Event { case read, done }
        let (events, event) = AsyncStream.makeStream(of: Event.self)
        var gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        dropbox.onDownload = { event.yield(.read) }
        let opening = Task { await sync.start(); event.yield(.done) }
        var day = 0
        for await next in events {
            guard next == .read else { break }
            day += 1
            await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: String(format: "2026-10-%02d", day))))
            let held = gate
            gate = StubHTTP.Gate()
            dropbox.downloadGate = gate
            held.open()
        }
        await opening.value
        dropbox.onDownload = nil
        dropbox.downloadGate = nil
        gate.open()
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .busy)))
        XCTAssertEqual(sync.provider, .dropbox, "still connected")
        XCTAssertFalse(sync.recordOpen)
        XCTAssertNil(store.cloudErase)
        let tries = downloads.value
        await sync.foreground()
        XCTAssertTrue(sync.recordOpen, "the next foreground opens again")
        XCTAssertGreaterThan(downloads.value, tries)
        await sync.background()
        let days = activeDays(dropbox.record)
        XCTAssertGreaterThanOrEqual(days.count, 3, "an edit for each try at least")
        XCTAssertEqual(days, activeDays(store.recordJSON), "every edit made meanwhile reaches the cloud")
    }

    // MARK: 5 · News (held news before the handover: CloudSyncTests testNewsFromASession...)

    func testNewsFromTheShownSessionSetsTheStatusAndNewsFromAnotherIsDropped() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        guard case .synced = sync.status else { return XCTFail("status is \(sync.status)") }

        sync.notify(news("failed", full), session: 2)
        guard case .synced = sync.status else { return XCTFail("another session's failure was shown: \(sync.status)") }
        sync.notify(try changed(days: ["2026-10-01", "2026-10-09"], session: 2), session: 2)
        await store.chain {}.value // a draw, had one been asked for, lands before this
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01"], "another session's record is not drawn")

        sync.notify(news("saving"), session: 1)
        XCTAssertEqual(sync.status, .saving)
        sync.notify(news("synced"), session: 1)
        guard case .synced = sync.status else { return XCTFail("status is \(sync.status)") }
        sync.notify(news("failed", full), session: 1)
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .storageFull)))
        sync.notify(news("saved"), session: 1)
        guard case .synced = sync.status else { return XCTFail("a save with nothing pending is Synced: \(sync.status)") }
        sync.notify(try changed(days: ["2026-10-01", "2026-10-09"], session: 1), session: 1)
        await drawn(store) { self.activeDays(store.recordJSON) == ["2026-10-01", "2026-10-09"] }
    }

    // MARK: 6 · Disconnect (during an open: R5; refused while erasing: below, item 8)

    func testADisconnectDuringAnOpenWinsAndTheLateOpenIsNotShown() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let (store, sync, _) = try app()
        let read = nextDownload()
        let opening = Task { await sync.start() }
        await arrive(read)
        let copied = await sync.disconnect()
        XCTAssertFalse(copied, "nothing was open to copy down")
        XCTAssertEqual(sync.status, .onPhone)
        gate.open()
        await opening.value
        XCTAssertEqual(sync.status, .onPhone, "the late open did not take the status back")
        XCTAssertNil(sync.provider)
        XCTAssertFalse(sync.recordOpen)
        XCTAssertNil(store.cloudErase)
        XCTAssertNil(sync.syncedBefore, "the late open is not a sync")
        XCTAssertNil(text("sync-provider"))
    }

    /// The open's read has resolved and its handover waits in the store's line (held
    /// by a step the test lets go) when Disconnect runs: the handover must not show it
    /// (CloudSync.open's generation checks in and after the handover), nor open again.
    func testADisconnectWhileTheResolvedOpenWaitsForTheStoresLineWins() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, engine) = try app()
        let release = holdLine(store)
        let held = steps(store)
        let opening = Task { await sync.start() }
        try await untilQueued(store, beyond: held) // the open resolved; its handover is in line
        XCTAssertEqual(sync.status, .connecting)
        let disconnecting = Task { await sync.disconnect() }
        try await untilQueued(store, beyond: held + 1) // the Disconnect closed the session; its showPhone is in line
        release()
        let copied = await disconnecting.value
        await opening.value
        XCTAssertTrue(copied, "the resolved session was copied down")
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertFalse(sync.recordOpen)
        XCTAssertNil(store.cloudErase)
        XCTAssertNil(sync.syncedBefore)
        XCTAssertNil(text("sync-history"), "a handover that lost to Disconnect is not a sync")
        XCTAssertEqual(downloads.value, 2, "the open's read and the copy down; no second open")
        let probe = try engine.blocking { try $0.cloudEdit(.add(metric: "weight", value: 80, day: "2026-10-09"), erase: "x", units: "si", now: .now, lpaUnit: "nmol/L") }
        XCTAssertEqual(probe.outcome.reason, "not-open", "the engine holds no session behind the phone's record")
    }

    func testADisconnectAfterTheOpenRemovesTheCloudsFilesAndKeepsSyncedBefore() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        try write("person@example.com", "sync-account-email")
        let (store, sync, engine) = try app()
        await sync.start()
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")))
        let copied = await sync.disconnect()
        XCTAssertTrue(copied)
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(sync.provider)
        XCTAssertFalse(sync.recordOpen)
        XCTAssertNil(sync.accountEmail)
        XCTAssertEqual(sync.syncedBefore, .dropbox)
        XCTAssertNil(store.cloudErase)
        XCTAssertNil(tokens.load(.dropbox))
        for name in ["sync-provider", "sync-account", "sync-account-email", "sync-pending"] {
            XCTAssertNil(text(name), "\(name) is removed")
        }
        XCTAssertEqual(text("sync-history"), "dropbox", "the history stays")
        XCTAssertEqual(activeDays(phoneRecord), ["2026-10-01", "2026-10-02"])
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-03")))
        engine.blocking { _ in } // a marker would be set on the engine's queue
        XCTAssertNil(text("sync-pending"), "after Disconnect an edit is not marked for the cloud")
        XCTAssertEqual(store.recordSource, "phone", "nor named for it")
        let again = await sync.disconnect()
        XCTAssertTrue(again, "a second Disconnect has nothing to do")
        XCTAssertEqual(sync.syncedBefore, .dropbox)
    }

    // MARK: 7 · Connect while erasing (first connect, A6 and AC11j: CloudSyncTests)

    func testAConnectIsRefusedWhileAnEraseRunsBeforeAndAfterItsSignIn() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, engine) = try app()
        await sync.start()
        let refusal = OAuthClient.Failure.refused("Wait for the erase to finish, then connect.")
        // A sign-in begun before the erase (Codex re-check R2).
        let late = heldSignIn()
        let lateConnect = Task { try await sync.connect(.dropbox, authenticate: late.authenticate) }
        for await _ in late.shown { break }
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let read = nextDownload()
        // A DataEraser on this sync is what Connect waits for (its init wires eraseRunning, AC16e).
        let eraser = DataEraser(store: store, sync: sync, chat: ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test"), reminders: nil, health: nil, live: nil)
        let erase = Task { await eraser.eraseAll() }
        await arrive(read)
        do {
            try await sync.connect(.dropbox, authenticate: signIn())
            XCTFail("a connect must wait for the erase")
        } catch {
            XCTAssertEqual(error as? OAuthClient.Failure, refusal, "refused before the sign-in")
        }
        late.release()
        do {
            try await lateConnect.value
            XCTFail("a sign-in that returns during the erase must not connect")
        } catch {
            XCTAssertEqual(error as? OAuthClient.Failure, refusal, "refused after the sign-in")
        }
        XCTAssertEqual(tokens.load(.dropbox)?.refreshToken, "r", "neither sign-in was kept")
        XCTAssertNil(text("sync-account"))
        gate.open()
        guard case .erased = await erase.value else { return XCTFail("the erase finishes") }
    }

    // MARK: 8 · Erase

    func testAnEraseWithNoOpenSessionAnswersNilAndChangesNothing() async throws {
        let (_, phoneOnly, _) = try app(connected: false)
        let none = try await phoneOnly.erase(chatHistory: nil) { _ in true }
        XCTAssertNil(none)
        XCTAssertEqual(phoneOnly.status, .onPhone)

        dropbox.online = false
        let (_, failed, _) = try app()
        await failed.start()
        let closed = try await failed.erase(chatHistory: nil) { _ in true }
        XCTAssertNil(closed, "connected, but nothing open: the phone cannot list what it erases")
        XCTAssertEqual(failed.status, .problem(SyncProblem(kind: .unreachable)))
    }

    func testAnEraseIsErasingWhileItRunsRefusesDisconnectAndEndsSynced() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        let (store, sync, engine) = try app()
        await sync.start()
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let read = nextDownload()
        // A DataEraser on this sync is what Disconnect waits for (its init wires eraseRunning, AC16e).
        let eraser = DataEraser(store: store, sync: sync, chat: ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test"), reminders: nil, health: nil, live: nil)
        let erase = Task { await eraser.eraseAll() }
        await arrive(read)
        XCTAssertEqual(sync.status, .saving)
        let copied = await sync.disconnect()
        XCTAssertFalse(copied, "Disconnect is refused while the erase runs")
        XCTAssertEqual(sync.provider, .dropbox)
        XCTAssertTrue(sync.recordOpen)
        XCTAssertEqual(sync.status, .saving, "the refused Disconnect changed nothing")
        XCTAssertEqual(text("sync-provider"), "dropbox")
        XCTAssertEqual(text("sync-account"), "dbid:A")
        XCTAssertNotNil(tokens.load(.dropbox))
        gate.open()
        guard case .erased = await erase.value else { return XCTFail("the erase lands in the cloud") }
        guard case .synced = sync.status else { return XCTFail("status is \(sync.status)") }
        XCTAssertEqual(activeDays(store.recordJSON), [])
    }

    func testAnEraseTheCloudCannotReadEndsUnreachableAndStillOpen() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        dropbox.online = false
        let result = try await sync.erase(chatHistory: nil) { _ in true }
        XCTAssertEqual(result?.success, false)
        XCTAssertEqual(result?.erased, false)
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)))
        XCTAssertTrue(sync.recordOpen, "the session stays open")
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01"])
    }

    /// An erase made here whose upload fails ends unreachable. That status comes from the
    /// save loop's own failure news (`op: 'persist'`), which reaches the status before the
    /// erase returns; the erase's `status == .saving` fallback (CloudSync.erase) is pinned
    /// only by the unreadable case above.
    func testAnEraseWhoseUploadFailsEndsUnreachable() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (_, sync, _) = try app()
        await sync.start()
        dropbox.uploadsWork = false
        let result = try await sync.erase(chatHistory: nil) { _ in true }
        XCTAssertEqual(result?.success, false)
        XCTAssertEqual(result?.erased, true)
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)))
        XCTAssertNotNil(text("sync-pending"), "the erase waits on the phone")
    }

    /// Q2, decided by S3 (US-25 AC11m): engine news that lands mid-erase ("synced" from a
    /// save or re-read) still shows Synced while the erase runs, but it never decides how
    /// the erase ends: CloudConnection's `eraseEnded` takes the erase's own result, so an
    /// erase that was not sent ends unreachable whatever news came first.
    func testEngineNewsMidEraseDecidesTheStatusAnEraseThatFailedEndsOn() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (_, sync, _) = try app()
        await sync.start()
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let read = nextDownload()
        let erase = Task { try await sync.erase(chatHistory: nil) { _ in true } }
        await arrive(read)
        XCTAssertEqual(sync.status, .saving)
        sync.notify(news("synced"), session: 1)
        guard case .synced = sync.status else { return XCTFail("news mid-erase sets the status: \(sync.status)") }
        dropbox.uploadsWork = false
        gate.open()
        let result = try await erase.value
        XCTAssertEqual(result?.success, false)
        XCTAssertEqual(result?.erased, true)
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)), "an erase that was not sent never ends Synced")
        XCTAssertNotNil(text("sync-pending"), "though the erase waits on the phone")
    }

    // MARK: 9 · syncNow

    func testSyncNowWithNoCloudDoesNothingAndWithNoSessionOpens() async throws {
        let (_, phoneOnly, _) = try app(connected: false)
        await phoneOnly.syncNow()
        XCTAssertEqual(phoneOnly.status, .onPhone)
        XCTAssertEqual(downloads.value, 0)

        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        dropbox.online = false
        let (_, sync, _) = try app()
        await sync.start()
        XCTAssertFalse(sync.recordOpen)
        dropbox.online = true
        await sync.syncNow()
        XCTAssertTrue(sync.recordOpen, "Sync now with no session opens one")
        guard case .synced = sync.status else { return XCTFail("status is \(sync.status)") }
    }

    func testSyncNowIsSavingWhileItReadsThenSynced() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (_, sync, _) = try app()
        await sync.start()
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let read = nextDownload()
        let syncing = Task { await sync.syncNow() }
        await arrive(read)
        XCTAssertEqual(sync.status, .saving)
        gate.open()
        await syncing.value
        guard case .synced = sync.status else { return XCTFail("status is \(sync.status)") }
        XCTAssertEqual(downloads.value, 2, "Sync now read the cloud again")
    }

    func testSyncNowThatCannotReadShowsTheProblemAndKeepsTheSession() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        dropbox.online = false
        await sync.syncNow()
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)))
        XCTAssertTrue(sync.recordOpen)
        XCTAssertNotNil(store.cloudErase)
    }

    /// Disconnect lands first, then Sync now's re-read: Sync now must not set a status
    /// over the Disconnect's (CloudSync.syncNow's `shownSession == session` guards).
    func testADisconnectDuringSyncNowIsNotOverwritten() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        let rereadGate = StubHTTP.Gate()
        dropbox.downloadGate = rereadGate
        let reread = nextDownload()
        let syncing = Task { await sync.syncNow() }
        await arrive(reread)
        try await disconnectThenLetGo(rereadGate, syncing, sync, store)
    }

    /// The same, with Sync now's re-read failing after the Disconnect (the catch's guard).
    func testADisconnectDuringAFailingSyncNowIsNotOverwritten() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        let rereadGate = StubHTTP.Gate()
        let failOnce = Count()
        let (fake, count) = (dropbox!, downloads!)
        StubHTTP.handler = { request in
            guard request.url.path.hasSuffix("/files/download"), request.headers["dropbox-api-arg"]?.contains("/health-roadmap.json") == true else { return fake.answer(request) }
            count.add()
            guard failOnce.value == 0 else { return fake.answer(request) }
            failOnce.add()
            return .init(status: 500, body: Data("internal_error".utf8), gate: rereadGate)
        }
        let syncing = Task { await sync.syncNow() }
        await untilRead(1, after: 1)
        try await disconnectThenLetGo(rereadGate, syncing, sync, store)
    }

    /// Waits until `count` more record reads than `before` have arrived (the stub's
    /// failing read has no onDownload hook). Polls the counter, bounded at 10 s.
    private func untilRead(_ count: Int, after before: Int) async {
        let deadline = Date.now.addingTimeInterval(10)
        while downloads.value < before + count {
            guard Date.now < deadline else { return XCTFail("the read never arrived") }
            try? await Task.sleep(for: .milliseconds(2))
        }
    }

    /// Holds the Disconnect's copy-down at a second gate, lets it land, then lets
    /// Sync now's held re-read go: the Disconnect's status must stand.
    private func disconnectThenLetGo(_ rereadGate: StubHTTP.Gate, _ syncing: Task<Void, Never>, _ sync: CloudSync, _ store: RecordStore,
                                     file: StaticString = #filePath, line: UInt = #line) async throws {
        let copyGate = StubHTTP.Gate()
        dropbox.downloadGate = copyGate
        let copyDown = nextDownload()
        let disconnecting = Task { await sync.disconnect() }
        await arrive(copyDown)
        copyGate.open()
        let copied = await disconnecting.value
        XCTAssertTrue(copied, file: file, line: line)
        XCTAssertEqual(sync.status, .onPhone, file: file, line: line)
        dropbox.downloadGate = nil
        rereadGate.open()
        await syncing.value
        XCTAssertEqual(sync.status, .onPhone, "Sync now's late answer did not overwrite the Disconnect", file: file, line: line)
        XCTAssertNil(sync.provider, file: file, line: line)
        XCTAssertFalse(sync.recordOpen, file: file, line: line)
        XCTAssertNil(store.cloudErase, file: file, line: line)
    }

    // MARK: 10 · background and foreground (background's flush: CloudSyncTests testAnEditWhoseFirstWrite...)

    func testBackgroundWithNoSessionSendsNothingAndForegroundWithNoCloudDoesNothing() async throws {
        let (_, phoneOnly, _) = try app(connected: false)
        await phoneOnly.foreground()
        XCTAssertEqual(phoneOnly.status, .onPhone)
        XCTAssertEqual(downloads.value, 0, "foreground with no cloud opens nothing")

        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        dropbox.online = false
        let (store, sync, engine) = try app()
        await sync.start()
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")))
        engine.blocking { _ in } // the marker is set on the engine's queue
        dropbox.online = true
        let before = downloads.value
        await sync.background()
        XCTAssertEqual(dropbox.uploads, 0, "nothing is open, so nothing is flushed")
        XCTAssertEqual(downloads.value, before, "and background opens nothing")
        XCTAssertNotNil(text("sync-pending"))
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)))
    }

    func testForegroundWithASessionReReadsWithoutReopening() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let reread = nextDownload()
        let returned = await returnsWhileHeld { await sync.foreground() }
        XCTAssertTrue(returned, "foreground does not wait for an open")
        XCTAssertTrue(sync.recordOpen, "the session stays shown")
        XCTAssertNotNil(store.cloudErase)
        guard case .synced = sync.status else { return XCTFail("no reopen, so not connecting: \(sync.status)") }
        await arrive(reread) // the re-read the foreground asked for
        gate.open()
        XCTAssertEqual(downloads.value, 2)
    }

    // MARK: 11 · The Disconnect gap

    /// Q1, decided by S3 (US-25 AC11m, owner's ruling): this pin froze the gap that state
    /// lead S22 is. Disconnect used to clear the provider before it awaited the engine's
    /// close, so the gap read Synced with no cloud named and Sync drew Connect rows. Now
    /// the closing state keeps the cloud being closed named, and the status reads
    /// Disconnecting. The store's cloudErase stays set until showPhone, so an edit in the
    /// gap is still sent to the engine's session, which is already closed: it is refused
    /// ("The cloud record is not open."), and reaches neither the phone's file nor the cloud.
    func testAnEditDuringDisconnectsCloseIsRefusedAndLandsNowhere() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let copyDown = nextDownload()
        let disconnecting = Task { await sync.disconnect() }
        await arrive(copyDown)
        XCTAssertEqual(sync.provider, .dropbox, "the cloud being closed stays named")
        XCTAssertFalse(sync.recordOpen)
        XCTAssertEqual(sync.status, .disconnecting)
        XCTAssertNotNil(store.cloudErase, "the screen still holds the cloud record")
        let edit = await store.apply(.add(metric: "weight", value: 80, day: "2026-10-07"))
        guard case .refused(let message, _) = edit else { return XCTFail("today an edit in the gap is refused: \(edit)") }
        XCTAssertEqual(message, "The cloud record is not open.")
        gate.open()
        let copied = await disconnecting.value
        XCTAssertTrue(copied)
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(store.cloudErase)
        XCTAssertEqual(activeDays(phoneRecord), ["2026-10-01"], "the refused edit is not on the phone")
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01"], "nor in the cloud")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-08")), "after Disconnect edits go to the phone")
        XCTAssertEqual(activeDays(phoneRecord), ["2026-10-01", "2026-10-08"])
    }
}
