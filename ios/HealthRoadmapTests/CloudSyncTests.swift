import XCTest
@testable import HealthRoadmap

/// US-25 AC11, end to end inside the app: My data's store, the CloudSync, the
/// engine's RecordSession in JavaScriptCore, the fetch bridge, and a stubbed
/// Dropbox with Dropbox's rev rules (StubHTTP). Node runs the engine half alone
/// in ios/engine/cloud.test.ts.
@MainActor
final class CloudSyncTests: XCTestCase {
    /// Dropbox's download and upload, in memory, with rev-conditional writes.
    final class FakeDropbox {
        var file: (text: String, rev: Int)?
        var uploads = 0
        /// The Dropbox account a sign-in comes back as.
        var tokenAccount = "dbid:A"
        /// False: the content endpoints fail as a dead network does; sign-in still works.
        var online = true
        /// False: every upload fails with a 500; reads still work.
        var uploadsWork = true
        /// Seconds every download waits before it answers.
        var downloadDelay: TimeInterval = 0
        /// Runs on the main queue as each download starts, before its answer.
        var onDownload: (@MainActor () -> Void)?
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
                return .init(body: Data(#"{"access_token":"token-1","refresh_token":"r-\#(tokenAccount)","expires_in":14400,"account_id":"\#(tokenAccount)"}"#.utf8))
            }
            if !online { return .init(offline: true) }
            guard request.headers["authorization"] == "Bearer token-1" else { return .init(status: 401) }
            if request.url.path == "/2/users/get_current_account" {
                return .init(body: Data(#"{"account_id":"\#(tokenAccount)","email":"Brad@Example.com","email_verified":true}"#.utf8))
            }
            let arg = try! JSONSerialization.jsonObject(with: Data(request.headers["dropbox-api-arg"]!.utf8)) as! [String: Any]
            if arg["path"] as? String == "/chat-history.json" { return answerChat(request, arg) }
            if request.url.path.hasSuffix("/files/download") {
                if let hook = onDownload { DispatchQueue.main.async { MainActor.assumeIsolated { hook() } } }
                guard let file else { return .init(status: 409, body: Data(#"{"error_summary":"path/not_found/"}"#.utf8), delay: downloadDelay) }
                return .init(headers: ["Dropbox-API-Result": #"{"rev":"r\#(file.rev)"}"#], body: Data(file.text.utf8), delay: downloadDelay)
            }
            guard uploadsWork else { return .init(status: 500, body: Data("internal_error".utf8)) }
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

        /// `/chat-history.json`, which only the website writes (US-25 AC16).
        var chat: (text: String, rev: Int)?

        private func answerChat(_ request: StubHTTP.Request, _ arg: [String: Any]) -> StubHTTP.Answer {
            if request.url.path.hasSuffix("/files/download") {
                guard let chat else { return .init(status: 409, body: Data(#"{"error_summary":"path/not_found/"}"#.utf8)) }
                return .init(headers: ["Dropbox-API-Result": #"{"rev":"r\#(chat.rev)"}"#], body: Data(chat.text.utf8))
            }
            let mode = arg["mode"] as? [String: Any]
            let expected = mode?[".tag"] as? String == "update" ? mode?["update"] as? String : nil
            guard expected == chat.map({ "r\($0.rev)" }) else { return .init(status: 409, body: Data(#"{"error_summary":"path/conflict/"}"#.utf8)) }
            chat = (String(decoding: request.body, as: UTF8.self), (chat?.rev ?? 0) + 1)
            return .init(body: Data(#"{"rev":"r\#(chat!.rev)"}"#.utf8))
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

    // MARK: Review findings (Codex R1, R2, R4, R5; adversary A5, A6)

    /// What the web's erase writes: a higher eraseEpoch and the removed rows listed.
    private func erased(_ before: [String: Any]) -> [String: Any] {
        var erased = before
        erased["erasedRows"] = ["fromEpoch": 1, "ids": ((before["measurements"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }]
        erased["measurements"] = []
        var meta = before["meta"] as! [String: Any]
        meta["eraseEpoch"] = 1
        meta["erasedAt"] = "2026-10-21T09:00:00.000Z"
        meta["updatedAt"] = "2026-10-21T09:00:00.000Z"
        meta["lamport"] = ((meta["lamport"] as? Int) ?? 0) + 10
        erased["meta"] = meta
        return erased
    }

    private func signIn() -> OAuthClient.Authenticate {
        { url, _ in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "db-xf96vqvjotm5xhx://2/token?code=c&state=\(state)")!
        }
    }

    func testR1ASheetOpenedBeforeARemoteEraseCannotSaveIntoTheErasedRecord() async throws {
        let before = try record(days: ["2026-10-01"], device: "web")
        dropbox.put(before)
        let (store, sync, _) = try app()
        await sync.start()
        store.pinScreen() // a sheet opens on the pre-erase record
        dropbox.put(erased(before))
        await sync.syncNow()
        XCTAssertEqual(activeDays(store.recordJSON), [], "the erase reached the phone")
        guard case .refused = store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")) else {
            return XCTFail("the old sheet's value must not land in the erased record")
        }
        store.unpinScreen()
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), [])
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")), .saved, "a sheet opened after the erase saves")
    }

    func testR2ASheetOpenedInMetricIsRefusedAfterTheWebSwitchesToUSUnits() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, engine) = try app()
        await sync.start()
        let rowId = try XCTUnwrap(store.myData?.vitals.first?.latest?.id)
        store.pinScreen()
        let us = try engine.apply(.units("conventional"), to: dropbox.file!.text, now: .now, deviceId: "web")
        dropbox.put(try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(us.record).utf8)) as! [String: Any])
        await sync.syncNow()
        XCTAssertEqual(store.myData?.unitSystem, "conventional")
        XCTAssertEqual(store.apply(.profile(sex: "female")), .saved, "an edit with no number in units still saves (F5)")
        guard case .refused = store.apply(.correct(id: rowId, value: 79)) else { return XCTFail("the replace path: 79 kg must not be 79 lb") }
        // The sheet still shows kg and still holds the typed 80: a second Save in it
        // is refused too, and says to close it (Codex re-check R1).
        guard case .refused(let message, _) = store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")) else {
            return XCTFail("a second Save in the same sheet must not store 80 lb")
        }
        XCTAssertTrue(message.contains("Close this"), message)
        store.unpinScreen()
        // A sheet opened now shows lb: its value saves.
        store.pinScreen()
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 176, day: "2026-10-02")), .saved)
        store.unpinScreen()
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01", "2026-10-02"])
    }

    func testR4AReopenThatFailsGoesBackToThePhoneAndKeepsEdits() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        XCTAssertNotNil(store.cloudErase)
        dropbox.online = false
        try await sync.connect(.dropbox, authenticate: signIn())
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)))
        XCTAssertNil(store.cloudErase, "edits go to the phone, not to a closed session")
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 80, day: "2026-10-06")), .saved)
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appending(path: "sync-pending").path(percentEncoded: false)))
        dropbox.online = true
        await sync.syncNow()
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-06"])
    }

    func testR5DisconnectWhileAnOpenIsInFlightWins() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        dropbox.downloadDelay = 0.4
        let (store, sync, _) = try app()
        let opening = Task { await sync.start() }
        try await Task.sleep(for: .milliseconds(100))
        let copied = await sync.disconnect()
        XCTAssertFalse(copied, "nothing was open to copy down, so the warning must show (F6)")
        await opening.value
        try await Task.sleep(for: .milliseconds(600))
        XCTAssertNil(store.cloudErase, "the late open did not switch the app back to the cloud")
        XCTAssertNil(sync.provider)
        XCTAssertEqual(sync.status, .onPhone)
        let uploads = dropbox.uploads
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 82, day: "2026-10-05")), .saved)
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertEqual(dropbox.uploads, uploads, "nothing reaches the cloud after Disconnect")
    }

    func testA5AnEditMadeWhileTheCloudOpensIsNotLeftBehind() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        dropbox.downloadDelay = 0.3
        let (store, sync, _) = try app()
        let opening = Task { await sync.start() }
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 79, day: "2026-10-02")), .saved, "the phone takes it meanwhile")
        await opening.value
        dropbox.downloadDelay = 0
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01", "2026-10-02"], "and the screen still shows it")
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01", "2026-10-02"])
    }

    func testA6SigningInAgainAsAnotherAccountIsRefusedAndMergesNothing() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app(connected: false)
        try await sync.connect(.dropbox, authenticate: signIn())
        let account = try String(contentsOf: folder.appending(path: "sync-account"), encoding: .utf8)
        XCTAssertEqual(account, "dbid:A")
        let uploads = dropbox.uploads
        dropbox.tokenAccount = "dbid:B"
        do {
            try await sync.connect(.dropbox, authenticate: signIn())
            XCTFail("another account must not take over this record")
        } catch {
            XCTAssertTrue(error.localizedDescription.contains("different Dropbox account"), error.localizedDescription)
        }
        XCTAssertEqual(tokens.load(.dropbox)?.refreshToken, "r-dbid:A", "the first account's sign-in is kept")
        XCTAssertNotNil(store.cloudErase)
        XCTAssertEqual(dropbox.uploads, uploads)
    }

    /// US-25 AC11e (2026-10-22): Sync names the connected account by its email. It is
    /// kept only on the phone, beside the account id, and goes on Disconnect.
    func testTheConnectedAccountsEmailIsKeptBesideItsIdAndGoesOnDisconnect() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, engine) = try app(connected: false)
        XCTAssertNil(sync.accountEmail)
        try await sync.connect(.dropbox, authenticate: signIn())
        XCTAssertEqual(sync.accountEmail, "brad@example.com")
        let file = folder.appending(path: "sync-account-email")
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "brad@example.com")
        XCTAssertEqual(file.deletingLastPathComponent().standardizedFileURL, store.file.deletingLastPathComponent().standardizedFileURL,
                       "in the Record folder, which backups leave out")
        let relaunched = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        XCTAssertEqual(relaunched.accountEmail, "brad@example.com")
        await relaunched.disconnect()
        XCTAssertNil(relaunched.accountEmail)
        XCTAssertFalse(FileManager.default.fileExists(atPath: file.path(percentEncoded: false)))
    }

    func testA3AfterDisconnectTheWordsSayACopyStaysInTheCloud() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (_, sync, _) = try app()
        await sync.start()
        await sync.disconnect()
        XCTAssertEqual(sync.syncedBefore, .dropbox)
        XCTAssertTrue(SyncStatusText.myDataFooter(provider: nil, earlier: sync.syncedBefore).contains("Dropbox"))
    }

    // MARK: Re-check findings (F2, F3, F7)

    func testF2AConnectWhileAnOlderOpenIsStillReadingShowsTheNewSessionOnly() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        dropbox.downloadDelay = 0.5
        let (store, sync, _) = try app()
        let stale = Task { await sync.start() }
        try await Task.sleep(for: .milliseconds(100))
        await sync.disconnect()
        dropbox.downloadDelay = 0
        try await sync.connect(.dropbox, authenticate: signIn())
        guard case .synced = sync.status else { return XCTFail("the new connect is open: \(sync.status)") }
        await stale.value
        try await Task.sleep(for: .milliseconds(700)) // the stale read lands and gives way
        XCTAssertNotNil(store.cloudErase)
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 81, day: "2026-10-03")), .saved)
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01", "2026-10-03"], "the shown session is the one the engine saves through")
    }

    func testF3EditsThatKeepArrivingWhileOpeningLeaveNoSessionBehind() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, engine) = try app()
        var day = 0
        dropbox.onDownload = {
            day += 1
            _ = store.apply(.add(metric: "weight", value: 80, day: "2026-10-0\(day)"))
        }
        await sync.start()
        dropbox.onDownload = nil
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .busy)))
        XCTAssertNil(store.cloudErase)
        let probe = try engine.cloudEdit(.add(metric: "weight", value: 80, day: "2026-10-09"), erase: "x", units: "si", now: .now)
        XCTAssertEqual(probe.reason, "not-open", "the engine holds no session that would poll and say Synced")
        XCTAssertNotNil(SyncProblem(kind: .busy).words(.dropbox).range(of: "on this iPhone"))
    }

    func testF7ADisconnectDuringSyncNowEndsOnThePhone() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 80, day: "2026-10-04")), .saved)
        dropbox.downloadDelay = 0.3
        let syncing = Task { await sync.syncNow() }
        try await Task.sleep(for: .milliseconds(50))
        await sync.disconnect()
        await syncing.value
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(sync.provider)
    }

    /// Codex re-check R3: "Synced" only when nothing waits on the phone. A reopen that
    /// merges a pending phone change only schedules its upload; with uploads failing
    /// the app must never say Synced.
    func testR3AReopenWithAPendingChangeAndFailingUploadsIsNeverSynced() async throws {
        dropbox.put(try record(days: [], device: "web"))
        dropbox.online = false
        let (store, sync, _) = try app()
        await sync.start()
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 80, day: "2026-10-06")), .saved)
        dropbox.online = true
        dropbox.uploadsWork = false
        await sync.foreground()
        XCTAssertNotNil(store.cloudErase, "the cloud record opened")
        if case .synced = sync.status { XCTFail("open with a pending change said Synced") }
        try await Task.sleep(for: .milliseconds(1500)) // the session's debounced save runs and fails
        if case .synced = sync.status { XCTFail("a failed upload left Synced on screen") }
        await sync.syncNow()
        if case .synced = sync.status { XCTFail("Sync now with failing uploads said Synced") }
        dropbox.uploadsWork = true
        await sync.syncNow()
        try await Task.sleep(for: .milliseconds(300))
        guard case .synced = sync.status else { return XCTFail("once the upload lands it is Synced: \(sync.status)") }
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-06"])
    }
}
