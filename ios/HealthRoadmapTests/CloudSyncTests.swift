import CryptoKit
import UIKit
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
        /// Originals the app filed, by path (US-52 AC13d).
        var documents: [String: Data] = [:]

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
            if let path = arg["path"] as? String, path != "/health-roadmap.json", request.url.path.hasSuffix("/files/upload") {
                documents[path] = request.body
                return .init(body: Data("{}".utf8))
            }
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
        var json = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: device, locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        for day in days {
            json = try XCTUnwrap(engine.blocking { [now] in try $0.apply(.add(metric: "weight", value: 80, day: day), to: json, now: now, deviceId: device) }.record)
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

        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 81, day: "2026-10-04")))
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
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 82, day: "2026-10-05")))
        XCTAssertEqual(dropbox.uploads, uploads)
    }

    func testFirstConnectMergesThePhoneRecordUp() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app(connected: false)
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 79, day: "2026-10-02")))
        try await sync.connect(.dropbox) { url, _ in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "db-xf96vqvjotm5xhx://2/token?code=c&state=\(state)")!
        }
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01", "2026-10-02"])
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01", "2026-10-02"])
    }

    /// US-09 AC4 (Codex re-check R1): a save asked for while disconnected, held behind
    /// another change, lands after the first connect lifted the phone's record. It is
    /// marked pending when its turn comes, so the reopen merges it up.
    func testASaveAskedForBeforeAFirstConnectThatLandsAfterTheLiftIsMerged() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app(connected: false)
        store.chain { try? await Task.sleep(for: .milliseconds(400)) } // a change still landing
        let save = Task { await store.apply(.add(metric: "weight", value: 79, day: "2026-10-02")) }
        try await sync.connect(.dropbox, authenticate: signIn())
        let saved = await save.value
        XCTAssertEqual(saved, .saved)
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01", "2026-10-02"], "the screen shows the save")
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01", "2026-10-02"], "the save reached the cloud")
    }

    /// US-52 AC8 (Codex re-check R3): a lab report's summary is taken against the record
    /// the import lands on, so a value another device brings in meanwhile is never
    /// counted as saved: what the summary says was saved is what the cloud file holds.
    func testALabSummaryMatchesWhatTheImportSavedWhenARemoteValueArrives() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, engine) = try app()
        await sync.start()
        // Another device fills the report's LDL slot.
        let web = dropbox.file!.text
        let filled = try XCTUnwrap(engine.blocking { try $0.apply(.add(metric: "ldl", value: 2.5, day: "2026-10-01"), to: web, now: .now, deviceId: "web") }.record)
        dropbox.put(try JSONSerialization.jsonObject(with: Data(filled.utf8)) as! [String: Any])
        let extraction = #"""
        {"classification":"lab_report","reportDate":"2026-10-01",
         "values":[{"metric":"ldl","valueSI":3.1,"displayValue":3.1,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"},
                   {"metric":"hba1c","valueSI":40,"displayValue":40,"displayUnit":"mmol/mol","displaySystem":"si","confidence":"medium","recordedAt":"2025-04-02"}],
         "additionalValues":[{"name":"Ferritin","value":85,"unit":"µg/L"}], "refusedValues":[]}
        """#
        // The re-read and the import race; whichever lands first, the summary must match.
        let reread = Task { await sync.syncNow() }
        let result = await store.importLabs(extractionJSON: extraction, refs: ["v0", "v1", "a0"], reportDay: "2026-10-01")
        await reread.value
        await sync.background()
        let summary = try result.get()
        let file = dropbox.record
        let imported = ((file["measurements"] as? [[String: Any]]) ?? []).filter { $0["source"] as? String == "lab_import" }.count
            + ((file["labValues"] as? [Any]) ?? []).count
        XCTAssertEqual(summary.saved, imported, "the summary counts what was saved, no more")
        XCTAssertEqual(summary.saved + summary.skipped, 3)
    }

    /// US-25 AC21 (adversary R2): an import asked for after the open resolved, while the
    /// handover decision waits its turn, is never hidden on the phone: it reaches the
    /// cloud record and the screen.
    func testAnImportAskedForDuringTheHandoverDecisionReachesTheCloud() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        var asked = false
        var imported: Task<RecordStore.ApplyResult, Never>?
        dropbox.onDownload = {
            guard !asked else { return }
            asked = true
            store.chain { try? await Task.sleep(for: .milliseconds(400)) } // a change still landing
            imported = Task {
                try? await Task.sleep(for: .milliseconds(200)) // the open has resolved by now
                return await store.applyNow(.add(metric: "weight", value: 80, day: "2026-10-02"))
            }
        }
        await sync.start()
        dropbox.onDownload = nil
        let result = await imported?.value
        XCTAssertEqual(result, .saved)
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01", "2026-10-02"], "the screen shows the import")
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01", "2026-10-02"], "the import reached the cloud")
    }

    /// US-25 AC21 (Codex R1): a first connect that lifts the phone's file while a phone
    /// erase waits on the engine never restores what the erase removed: the erase is a
    /// counted change, the reopen merges it in, and its higher eraseEpoch wins.
    func testASignInCompletingDuringAPhoneEraseEndsWithTheErase() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app(connected: false)
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 79, day: "2026-10-02")))
        dropbox.downloadDelay = 0.3
        var erase: Task<RecordStore.PhoneErase, Never>?
        dropbox.onDownload = {
            guard erase == nil else { return }
            erase = Task { await store.erasePhone(historyJSON: nil) { _, _ in true } } // the lift has read the phone
        }
        try await sync.connect(.dropbox, authenticate: signIn())
        dropbox.onDownload = nil
        dropbox.downloadDelay = 0
        let erased = await erase?.value
        XCTAssertEqual(erased, .erased(chatErased: true))
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01"], "the erased value is not back on screen")
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01"], "nor in the cloud")
    }

    /// US-25 AC21 (adversary R2, R4): a record and a failure the opening session sends
    /// before the handover shows it are held, then shown with it, never dropped.
    func testNewsFromASessionBeforeItIsShownIsHeldAndShownWithIt() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, _) = try app()
        let news = try record(days: ["2026-10-01", "2026-10-03"], device: "web")
        let newsText = String(decoding: try JSONSerialization.data(withJSONObject: news), as: UTF8.self)
        var sent = false
        dropbox.onDownload = {
            guard !sent else { return }
            sent = true
            store.chain { try? await Task.sleep(for: .milliseconds(400)) } // the handover waits its turn
            Task {
                try? await Task.sleep(for: .milliseconds(200)) // the open has resolved; session 1 is not shown yet
                let view = String(decoding: try! JSONSerialization.data(withJSONObject: ["record": newsText, "erase": "e-news", "session": 1]), as: UTF8.self)
                sync.notify("changed", view, session: 1, order: 1_000)
                sync.notify("failed", #"{"kind":"unreachable","detail":"Dropbox could not be reached."}"#, session: 1, order: 1_001)
            }
        }
        await sync.start()
        dropbox.onDownload = nil
        try await Task.sleep(for: .milliseconds(100)) // the held record, queued after the handover, lands
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01", "2026-10-03"], "the record it sent is shown")
        guard case .problem = sync.status else { return XCTFail("the failure it sent was dropped: \(sync.status)") }
    }

    /// US-25 AC21 (R2): a held failure followed by a "synced" before the handover shows
    /// the session ends synced; and (below) a failure arriving after the session is shown,
    /// while the open is still finishing, is never overwritten by it.
    func testASyncedAfterAHeldFailureWins() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, engine) = try app()
        let failure = #"{"kind":"unreachable","detail":"Dropbox could not be reached."}"#
        var sent = false
        dropbox.onDownload = {
            guard !sent else { return }
            sent = true
            store.chain {
                try? await Task.sleep(for: .milliseconds(400)) // the handover waits its turn
                engine.queue.async { Thread.sleep(forTimeInterval: 0.3) } // and its draw waits on the engine
            }
            Task {
                try? await Task.sleep(for: .milliseconds(200)) // before the handover: held
                sync.notify("failed", failure, session: 1, order: 1_000)
                sync.notify("synced", "", session: 1, order: 1_001)
            }
        }
        await sync.start()
        dropbox.onDownload = nil
        guard case .synced = sync.status else { return XCTFail("a held failure beat the synced after it: \(sync.status)") }
    }

    func testAFailureAfterTheHandoverIsNotOverwrittenByTheOpen() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, engine) = try app()
        let failure = #"{"kind":"unreachable","detail":"Dropbox could not be reached."}"#
        var sent = false
        dropbox.onDownload = {
            guard !sent else { return }
            sent = true
            store.chain {
                try? await Task.sleep(for: .milliseconds(400))
                engine.queue.async { Thread.sleep(forTimeInterval: 0.3) }
            }
            Task {
                try? await Task.sleep(for: .milliseconds(550)) // shown, its draw still waiting
                sync.notify("failed", failure, session: 1, order: 2_000)
            }
        }
        await sync.start()
        dropbox.onDownload = nil
        guard case .problem = sync.status else { return XCTFail("the open overwrote a newer failure: \(sync.status)") }
    }

    func testACloudThatCannotBeReachedLeavesThePhoneRecordAndMarksEditsForLater() async throws {
        StubHTTP.handler = { _ in .init(offline: true) }
        let (store, sync, engine) = try app()
        await sync.start()
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)))
        XCTAssertNil(store.cloudErase)
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-06")))
        engine.blocking { _ in } // the marker is set on the engine's queue, in line with its own reads and clears
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
        guard case .refused = await store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")) else {
            return XCTFail("the old sheet's value must not land in the erased record")
        }
        store.unpinScreen()
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), [])
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")), "a sheet opened after the erase saves")
    }

    func testR2ASheetOpenedInMetricIsRefusedAfterTheWebSwitchesToUSUnits() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, engine) = try app()
        await sync.start()
        let rowId = try XCTUnwrap(store.myData?.vitals.first?.latest?.id)
        store.pinScreen()
        let web = dropbox.file!.text
        let us = try engine.blocking { try $0.apply(.units("conventional"), to: web, now: .now, deviceId: "web") }
        dropbox.put(try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(us.record).utf8)) as! [String: Any])
        await sync.syncNow()
        XCTAssertEqual(store.myData?.unitSystem, "conventional")
        await XCTAssertSaved(await store.apply(.profile(sex: "female")), "an edit with no number in units still saves (F5)")
        guard case .refused = await store.apply(.correct(id: rowId, value: 79)) else { return XCTFail("the replace path: 79 kg must not be 79 lb") }
        // The sheet still shows kg and still holds the typed 80: a second Save in it
        // is refused too, and says to close it (Codex re-check R1).
        guard case .refused(let message, _) = await store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")) else {
            return XCTFail("a second Save in the same sheet must not store 80 lb")
        }
        XCTAssertTrue(message.contains("Close this"), message)
        store.unpinScreen()
        // A sheet opened now shows lb: its value saves.
        store.pinScreen()
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 176, day: "2026-10-02")))
        store.unpinScreen()
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01", "2026-10-02"])
    }

    /// US-25 AC20: the sheet's pin covers Lp(a)'s unit, which the record holds, so a value
    /// typed in mg/dL is refused after the web switches Lp(a) to mg/L, never read as mg/L.
    func testLpaValueTypedBeforeTheWebChangesItsUnitIsRefused() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, engine) = try app()
        await sync.start()
        let chosen = await store.setLpaUnit("mg/dL")
        XCTAssertEqual(chosen, .saved, "the menu's choice goes through the session")
        store.pinScreen()
        XCTAssertEqual(store.screen.lpaUnit, "mg/dL")
        // Saved without a re-read: the session throttles re-reads, and the web's change comes next.
        _ = try await engine.cloudFlush()
        XCTAssertEqual((dropbox.record["profile"] as? [String: Any])?["lpaUnit"] as? String, "mg/dL")
        let web = try await engine.apply(.lpaUnit("mg/L"), to: dropbox.file!.text, now: .now, deviceId: "web")
        dropbox.put(try JSONSerialization.jsonObject(with: Data(try XCTUnwrap(web.record).utf8)) as! [String: Any])
        await sync.syncNow()
        XCTAssertEqual(store.myData?.lpaUnit, "mg/L")
        guard case .refused(let message, _) = await store.apply(.add(metric: "lpa", value: 50, day: "2026-10-02")) else {
            return XCTFail("50 typed as mg/dL must not be stored as 50 mg/L")
        }
        XCTAssertTrue(message.contains("Close this"), message)
        let weight = await store.apply(.add(metric: "weight", value: 80, day: "2026-10-02"))
        XCTAssertEqual(weight, .saved, "another test's value still saves")
        store.unpinScreen()
        // A sheet opened now shows mg/L: its value saves, read in mg/L.
        store.pinScreen()
        let lpaSaved = await store.apply(.add(metric: "lpa", value: 500, day: "2026-10-02"))
        XCTAssertEqual(lpaSaved, .saved)
        store.unpinScreen()
        await sync.background()
        let lpa = (dropbox.record["measurements"] as? [[String: Any]])?.first { $0["metricType"] as? String == "lpa" }
        XCTAssertEqual(try XCTUnwrap(lpa?["value"] as? Double), 125, accuracy: 1e-9)
    }

    func testR4AReopenThatFailsGoesBackToThePhoneAndKeepsEdits() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, engine) = try app()
        await sync.start()
        XCTAssertNotNil(store.cloudErase)
        dropbox.online = false
        try await sync.connect(.dropbox, authenticate: signIn())
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)))
        XCTAssertNil(store.cloudErase, "edits go to the phone, not to a closed session")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-06")))
        engine.blocking { _ in } // the marker is set on the engine's queue, in line with its own reads and clears
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
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 82, day: "2026-10-05")))
        try await Task.sleep(for: .milliseconds(1200))
        XCTAssertEqual(dropbox.uploads, uploads, "nothing reaches the cloud after Disconnect")
    }

    func testA5AnEditMadeWhileTheCloudOpensIsNotLeftBehind() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        dropbox.downloadDelay = 0.3
        let (store, sync, _) = try app()
        let opening = Task { await sync.start() }
        try await Task.sleep(for: .milliseconds(50))
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 79, day: "2026-10-02")), "the phone takes it meanwhile")
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
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 81, day: "2026-10-03")))
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01", "2026-10-03"], "the shown session is the one the engine saves through")
    }

    func testF3EditsThatKeepArrivingWhileOpeningLeaveNoSessionBehind() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, engine) = try app()
        var day = 0
        dropbox.onDownload = {
            day += 1
            let day = day
            Task { _ = await store.apply(.add(metric: "weight", value: 80, day: "2026-10-0\(day)")) }
        }
        await sync.start()
        dropbox.onDownload = nil
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .busy)))
        XCTAssertNil(store.cloudErase)
        let probe = try engine.blocking { try $0.cloudEdit(.add(metric: "weight", value: 80, day: "2026-10-09"), erase: "x", units: "si", now: .now, lpaUnit: "nmol/L") }
        XCTAssertEqual(probe.reason, "not-open", "the engine holds no session that would poll and say Synced")
        XCTAssertNotNil(SyncProblem(kind: .busy).words(.dropbox).range(of: "on this iPhone"))
    }

    /// US-09 AC4, US-25 AC21: an edit asked for while the cloud opens, whose write lands
    /// on the phone only as the open resolves, is neither hidden nor left behind: it
    /// reaches the cloud file and the screen.
    func testAnEditLandingAsTheOpenResolvesReachesTheCloudAndTheScreen() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync, engine) = try app()
        var asked = false
        dropbox.onDownload = {
            guard !asked else { return }
            asked = true
            // Held on the engine's queue until the open's own download has been answered.
            engine.queue.async { Thread.sleep(forTimeInterval: 0.05) }
            Task { _ = await store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")) }
        }
        await sync.start()
        dropbox.onDownload = nil
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-01", "2026-10-02"], "the screen shows the edit")
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), ["2026-10-01", "2026-10-02"], "the edit reached the cloud")
    }

    func testF7ADisconnectDuringSyncNowEndsOnThePhone() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-04")))
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
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-06")))
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

    /// US-52 AC13d: a clinic letter from "Add medical records", with a cloud open: the
    /// original lands in Dropbox under the web's folder, then the row goes up through the
    /// session, its contentHash the web's sha256Blob of the same bytes (CryptoKit here).
    func testALetterIsFiledInTheCloudWithItsOriginalAndTheWebsHash() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        let letter = ##"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Cardiology follow-up","documentDate":"2026-09-14","contentMarkdown":"# Letter","metadata":{}}}"##
        let bytes = Data("%PDF-1.7 synthetic letter".utf8)
        let original = LabFileReader.Original(bytes, mimeType: "application/pdf")
        let choice = DocumentChoice(kind: .document, sourceFileName: "Letter.pdf", title: "Heart clinic", documentDate: "2026-09-14", mimeType: "application/pdf", contentHash: original.contentHash)
        let result = await store.saveDocument(extractionJSON: letter, choice: choice, original: original)
        XCTAssertEqual(result, .saved(count: 1, stored: true, unstored: 0, stale: false))
        XCTAssertEqual(dropbox.documents, ["/Clinic letters/2026-09-14 Heart clinic.pdf": bytes])
        await sync.background()
        let row = try XCTUnwrap((dropbox.record["documents"] as? [[String: Any]])?.first)
        let hex = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(row["contentHash"] as? String, "sha256-\(hex)")
        XCTAssertEqual(row["fileRef"] as? String, "Clinic letters/2026-09-14 Heart clinic.pdf")
        XCTAssertEqual(row["mimeType"] as? String, "application/pdf")
        XCTAssertEqual(row["title"] as? String, "Heart clinic")
        XCTAssertTrue(store.recordJSON.contains("Heart clinic"), "the screen shows the record the session holds")
    }

    private let cloudLetter = ##"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Cardiology follow-up","documentDate":"2026-09-14","contentMarkdown":"# Letter","metadata":{}}}"##

    /// US-52 AC13d (Codex R2): a picked file that is gone by Save is not uploaded; the row
    /// is filed with the reviewed bytes' hash, metadata-only, and the result says so.
    func testAnOriginalGoneBeforeSaveFilesOnlyTheText() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync, _) = try app()
        await sync.start()
        let picked = folder.appending(path: "Letter.pdf")
        try UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 200)).pdfData { $0.beginPage() }.write(to: picked)
        let original = try XCTUnwrap(LabFileReader.documents(picked: picked).first?.original)
        try FileManager.default.removeItem(at: picked)
        let choice = DocumentChoice(kind: .document, sourceFileName: "Letter.pdf", title: "Heart clinic", documentDate: nil, mimeType: "application/pdf", contentHash: original.contentHash)
        let result = await store.saveDocument(extractionJSON: cloudLetter, choice: choice, original: original)
        XCTAssertEqual(result, .saved(count: 1, stored: false, unstored: 0, stale: true))
        XCTAssertEqual(dropbox.documents, [:], "nothing uploaded")
        await sync.background()
        let row = try XCTUnwrap((dropbox.record["documents"] as? [[String: Any]])?.first)
        XCTAssertEqual(row["contentHash"] as? String, original.contentHash)
        XCTAssertEqual(row["fileRef"] as? String, "")
    }

    /// US-52 AC13d (Codex R1): the review pins the record it opened on. An erase from
    /// another device that arrives before Save refuses both the values and the document.
    func testAnEraseAfterTheReviewOpensRefusesItsSave() async throws {
        let before = try record(days: ["2026-10-01"], device: "web")
        dropbox.put(before)
        let (store, sync, _) = try app()
        await sync.start()
        store.pinScreen() // LabReviewView, as it appears
        defer { store.unpinScreen() }
        var erased = before
        erased["measurements"] = []
        erased["erasedRows"] = ["fromEpoch": 1, "ids": ((before["measurements"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }]
        var meta = before["meta"] as! [String: Any]
        meta["eraseEpoch"] = 1
        meta["erasedAt"] = "2026-10-21T09:00:00.000Z"
        meta["updatedAt"] = "2026-10-21T09:00:00.000Z"
        meta["lamport"] = ((meta["lamport"] as? Int) ?? 0) + 10
        erased["meta"] = meta
        dropbox.put(erased)
        await sync.syncNow()
        let original = LabFileReader.Original(Data("%PDF".utf8), mimeType: "application/pdf")
        let choice = DocumentChoice(kind: .document, sourceFileName: "Letter.pdf", title: "Letter", documentDate: nil, mimeType: "application/pdf", contentHash: original.contentHash)
        guard case .refused = await store.saveDocument(extractionJSON: cloudLetter, choice: choice, original: original) else { return XCTFail("a pre-erase document was saved") }
        guard case .refused = await store.apply(.add(metric: "weight", value: 80, day: "2026-10-02")) else { return XCTFail("a pre-erase value was saved") }
        XCTAssertEqual(dropbox.documents, [:])
    }
}
