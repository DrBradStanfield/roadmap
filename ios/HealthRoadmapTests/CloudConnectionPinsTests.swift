import XCTest
@testable import HealthRoadmap

/// Survey S3 pins (US-25 AC11, 2026-11-12): what callers of CloudSync see today,
/// pinned before its connection mode moves into one `CloudConnection` union with a
/// pure transition. Each test reads only what a caller reads: status, provider,
/// recordOpen, accountEmail, syncedBefore, erasing, the store's screen and record,
/// the files on disk and the tokens. Opens, erases and re-reads are held with a
/// StubHTTP.Gate, never a fixed delay. Behaviour CloudSyncTests already pins is not
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
        try write("brad@example.com", "sync-account-email") // left by an older build: not read without a provider
        try write("dropbox", "sync-history")
        let (store, sync, _) = try app(connected: false)
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(sync.provider)
        XCTAssertFalse(sync.recordOpen)
        XCTAssertNil(sync.accountEmail, "an email on file without a provider is not shown")
        XCTAssertEqual(sync.syncedBefore, .dropbox, "the cloud synced before is read whatever is connected")
        XCTAssertFalse(sync.erasing)
        await sync.start()
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(store.cloudErase)
        XCTAssertEqual(downloads.value, 0, "start with no cloud on file opens nothing")
    }

    func testWithACloudOnFileItIsConnectingBeforeStartAndNothingIsOpen() throws {
        try write("brad@example.com", "sync-account-email")
        let (store, sync, _) = try app()
        XCTAssertEqual(sync.status, .connecting)
        XCTAssertEqual(sync.provider, .dropbox)
        XCTAssertFalse(sync.recordOpen, "connecting is not open (US-54 AC2)")
        XCTAssertEqual(sync.accountEmail, "brad@example.com")
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
        gate.open()
        await opening.value
        XCTAssertEqual(downloads.value, 2, "the open went round once more")
        XCTAssertTrue(sync.recordOpen)
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01", "2026-10-02"])
    }

    /// The number of tries (3) is not pinned: each try reads the record a varying number
    /// of times (the open, then the live re-read), and each read here sends one more edit.
    func testEditsThatKeepArrivingEndBusyStayConnectedAndTheNextForegroundOpens() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, _) = try app()
        var day = 0
        dropbox.onDownload = {
            day += 1
            let day = day
            Task { _ = await store.apply(.add(metric: "weight", value: 80, day: "2026-10-0\(day)")) }
        }
        await sync.start()
        dropbox.onDownload = nil
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

    func testADisconnectAfterTheOpenRemovesTheCloudsFilesAndKeepsSyncedBefore() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        try write("brad@example.com", "sync-account-email")
        let (store, sync, _) = try app()
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
        let again = await sync.disconnect()
        XCTAssertTrue(again, "a second Disconnect has nothing to do")
        XCTAssertEqual(sync.syncedBefore, .dropbox)
    }

    // MARK: 7 · Connect while erasing (first connect, A6 and AC11j: CloudSyncTests)

    func testAConnectIsRefusedWhileAnEraseRunsBeforeAndAfterItsSignIn() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (_, sync, _) = try app()
        await sync.start()
        let refusal = OAuthClient.Failure.refused("Wait for the erase to finish, then connect.")
        // A sign-in begun before the erase (Codex re-check R2).
        let late = heldSignIn()
        let lateConnect = Task { try await sync.connect(.dropbox, authenticate: late.authenticate) }
        for await _ in late.shown { break }
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let read = nextDownload()
        let erase = Task { try await sync.erase(chatHistory: nil) { _ in true } }
        await arrive(read)
        XCTAssertTrue(sync.erasing)
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
        XCTAssertTrue(sync.erasing)
        gate.open()
        _ = try await erase.value
        XCTAssertFalse(sync.erasing)
    }

    // MARK: 8 · Erase

    func testAnEraseWithNoOpenSessionAnswersNilAndChangesNothing() async throws {
        let (_, phoneOnly, _) = try app(connected: false)
        let none = try await phoneOnly.erase(chatHistory: nil) { _ in true }
        XCTAssertNil(none)
        XCTAssertEqual(phoneOnly.status, .onPhone)
        XCTAssertFalse(phoneOnly.erasing)

        dropbox.online = false
        let (_, failed, _) = try app()
        await failed.start()
        let closed = try await failed.erase(chatHistory: nil) { _ in true }
        XCTAssertNil(closed, "connected, but nothing open: the phone cannot list what it erases")
        XCTAssertEqual(failed.status, .problem(SyncProblem(kind: .unreachable)))
        XCTAssertFalse(failed.erasing)
    }

    func testAnEraseIsErasingWhileItRunsRefusesDisconnectAndEndsSynced() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        try write("dbid:A", "sync-account")
        let (store, sync, _) = try app()
        await sync.start()
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let read = nextDownload()
        let erase = Task { try await sync.erase(chatHistory: nil) { _ in true } }
        await arrive(read)
        XCTAssertTrue(sync.erasing)
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
        let result = try await erase.value
        XCTAssertEqual(result?.success, true)
        XCTAssertFalse(sync.erasing)
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
        XCTAssertFalse(sync.erasing)
        XCTAssertTrue(sync.recordOpen, "the session stays open")
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01"])
    }

    /// An erase made here whose upload fails: with no news meanwhile it ends
    /// unreachable; the next test sends news mid-erase.
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

    /// Pins today's behaviour; S3 design question: the erase sets .saving, then reads
    /// `status == .saving` to decide whether to say "unreachable". Engine news that lands
    /// mid-erase ("synced" from a save or re-read) shows Synced while the erase still runs.
    /// Today a failed upload ends unreachable anyway, because the upload's own failure
    /// news reaches the status first; a refactor that keys the end on the erase's own
    /// result keeps this outcome, one that drops the failure news must not end Synced.
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

    func testADisconnectDuringSyncNowIsNotOverwritten() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let reread = nextDownload()
        let syncing = Task { await sync.syncNow() }
        await arrive(reread)
        let copyDown = nextDownload()
        let disconnecting = Task { await sync.disconnect() }
        await arrive(copyDown) // the Disconnect is past its first steps, awaiting the copy down
        gate.open()
        await syncing.value
        _ = await disconnecting.value
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(sync.provider)
        XCTAssertFalse(sync.recordOpen)
        XCTAssertNil(store.cloudErase)
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

    /// Pins today's behaviour; S3 design question: Disconnect clears the shown session
    /// and the provider before it awaits the engine's close, but the store's cloudErase
    /// stays set until showPhone. An edit in that gap is sent to the engine's session,
    /// which is already closed: it is refused ("The cloud record is not open."), and
    /// reaches neither the phone's file nor the cloud. Meanwhile the status still reads
    /// Synced with no provider.
    func testAnEditDuringDisconnectsCloseIsRefusedAndLandsNowhere() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        let gate = StubHTTP.Gate()
        dropbox.downloadGate = gate
        let copyDown = nextDownload()
        let disconnecting = Task { await sync.disconnect() }
        await arrive(copyDown)
        XCTAssertNil(sync.provider)
        XCTAssertFalse(sync.recordOpen)
        guard case .synced = sync.status else { return XCTFail("status in the gap is \(sync.status)") }
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
