import os
import UIKit
import XCTest
@testable import HealthRoadmap

/// Design PR 15 (US-52 AC8c, AC13d, US-14 AC10, US-12 AC27): the app's shared upload end to end:
/// sends on the stand-in server (StubHTTP, a URLProtocol), the one Save through the record store,
/// on the phone and in a stand-in Dropbox. The record is written before the page says saved.
/// Synthetic files only.
@MainActor
final class UploadSessionTests: XCTestCase, CloudFixtures {
    typealias Kit = UploadTestKit
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!
    private var server = Kit.Server()

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Upload Session \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        server = Kit.Server()
        // Lab reads answer a letter, titled by the read's number; everything else is Dropbox.
        let (fake, server) = (dropbox!, server)
        StubHTTP.handler = { request in
            guard request.url.path == LabReadSender.path else { return fake.answer(request) }
            let n = server.seen.withLock { $0.append(""); return $0.count }
            let data = UploadPageTests.letter("Letter \(n)")
            let line = #"{"status":200,"body":{"success":true,"data":\#(data)}}"#
            return Kit.read("{\"accepted\":true}\n\(line)\n")
        }
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
    }

    private func phone() throws -> RecordStore {
        try RecordStore(folder: folder, engine: HealthEngine(session: StubHTTP.session()), deviceId: "ios-test")
    }

    private func session(_ store: RecordStore, save: (@Sendable (String, Int, Int) async -> String)? = nil) -> UploadSession {
        UploadSession(engine: store.engine, store: store, sender: LabReadSender(attest: Kit.client()), frame: .milliseconds(1), save: save)
    }

    private func page(_ session: UploadSession) -> UploadPage? {
        if case .drawn(let text) = session.model.state { session.page(text) } else { nil }
    }

    private func until(_ what: String, line: UInt = #line, _ check: () async -> Bool) async throws { try await Kit.until(what, line: line, check) }

    private var recordOnDisk: String { (try? String(contentsOf: RecordStore.file(in: folder), encoding: .utf8)) ?? "" }

    // MARK: Save on the phone

    /// The phone's file holds the letters before the page says saved; a repeat of the same files
    /// is all known: nothing is sent, nothing offered, nothing saved again.
    func testOnThePhoneTheRecordIsWrittenBeforeSavedAndARepeatAddsNothing() async throws {
        let store = try phone()
        let files = Kit.pictures(2)
        var upload = session(store)
        _ = await upload.runner.pick(files, needsConsent: false)
        try await until("both read") { page(upload)?.save.enabled == true }
        XCTAssertEqual(page(upload)?.save.label, "Save 2 documents")
        // The order itself: as the record lands on disk (the store's edit hook), the engine has not
        // yet taken `saved`: the page has no done screen, and the file already holds both letters.
        var seenAtWrite: (done: Bool, onDisk: Bool)?
        store.onEdit = { [unowned self] in seenAtWrite = (page(upload)?.done != nil, recordOnDisk.contains("Letter 1") && recordOnDisk.contains("Letter 2")) }
        upload.send(.save)
        try await until("done") { page(upload)?.done != nil }
        XCTAssertEqual(seenAtWrite?.done, false, "the record was on disk before the page said saved")
        XCTAssertEqual(seenAtWrite?.onDisk, true)
        XCTAssertEqual(page(upload)?.done?.line, "Saved 2 documents.")
        upload.send(.close)

        upload = session(store)
        let before = store.recordJSON
        _ = await upload.runner.pick(files, needsConsent: false)
        try await until("known") { page(upload)?.summary == "Everything here is already in your record." }
        XCTAssertEqual(server.count, 2, "a known file is never sent")
        XCTAssertNil(page(upload)?.documents)
        XCTAssertEqual(page(upload)?.save.enabled, false)
        upload.send(.save)
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(store.recordJSON, before, "a repeat writes nothing")
    }

    /// Consent first (AC13e): the page is in the engine's consent phase and nothing is sent until
    /// the agree; then the read runs.
    func testNothingIsSentBeforeConsentThenTheReadRuns() async throws {
        let store = try phone()
        let upload = session(store)
        _ = await upload.runner.pick(Kit.pictures(1), needsConsent: true)
        try await until("consent") { page(upload)?.phase == "consent" }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(server.count, 0, "nothing leaves the phone before the agree")
        await upload.runner.consented()
        try await until("read") { page(upload)?.save.enabled == true }
        XCTAssertEqual(server.count, 1)
    }

    /// A refused save says why and offers Save again; the second Save writes the record.
    func testARefusedSaveIsOfferedAgainAndThenSaves() async throws {
        let store = try phone()
        let refusals = OSAllocatedUnfairLock(initialState: 1)
        // The first Save is refused; the second is the store's own (a picture's original is not kept off-cloud).
        let upload = session(store, save: { state, run, attempt in
            guard refusals.withLock({ let left = $0; $0 = max(0, $0 - 1); return left > 0 }) else {
                return UploadSession.event(await store.saveUpload(state: state, originals: [:], read: { _ in nil }, as: await store.screen), run: run, attempt: attempt)
            }
            return UploadSession.event(.failure(LabRefusal(message: "Not saved.")), run: run, attempt: attempt)
        })
        _ = await upload.runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("read") { page(upload)?.save.enabled == true }
        upload.send(.save)
        try await until("refused") { page(upload)?.save.error == "Not saved." }
        XCTAssertEqual(page(upload)?.save.enabled, true)
        XCTAssertFalse(recordOnDisk.contains("Letter 1"))
        upload.send(.save)
        try await until("done") { page(upload)?.done != nil }
        XCTAssertTrue(recordOnDisk.contains("Letter 1"))
    }

    /// The real door refuses a state that is not saving, in its own words, and writes nothing.
    func testTheSaveDoorRefusesAStateNotSaving() async throws {
        let store = try phone()
        let before = store.recordJSON
        let state = #"{"phase":"choosing","platform":"phone","run":0}"#
        guard case .failure(let refusal) = await store.saveUpload(state: state, originals: [:], read: { _ in nil }, as: await store.screen) else { return XCTFail("saved") }
        XCTAssertEqual(refusal.message, "The upload is not saving.")
        XCTAssertEqual(store.recordJSON, before)
    }

    // MARK: Save in the cloud

    /// With Dropbox open: the original goes up, the row through the session, and the screen shows
    /// the record the session holds before the page says saved.
    func testInTheCloudTheOriginalIsStoredAndTheRecordDrawnBeforeSaved() async throws {
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        dropbox.put(try record(days: [], device: "web"))
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        await sync.start()
        XCTAssertNotNil(store.cloudErase)
        let upload = session(store)
        let file = Kit.pictures(1)[0]
        _ = await upload.runner.pick([file], needsConsent: false)
        try await until("read") { page(upload)?.save.enabled == true }
        upload.send(.save)
        try await until("done") { page(upload)?.done != nil }
        XCTAssertTrue(store.recordJSON.contains("Letter 1"), "drawn before the page said saved")
        XCTAssertEqual(Array(dropbox.documents.values), [file.data], "the original stored")
        await sync.background()
        let row = try XCTUnwrap((dropbox.record["documents"] as? [[String: Any]])?.first)
        XCTAssertEqual(row["contentHash"] as? String, LabFileReader.contentHash(file.data))
        XCTAssertNil(page(upload)?.done?.unstored)
    }

    // MARK: The owner's 18-file ZIP

    /// 18 files in one ZIP, 7 already in the record: one page, the 7 counted and never sent or
    /// offered, the 11 new letters listed, one Save.
    func testAnEighteenFileZipIsOnePageWithOneSaveAndKnownFilesNeverShown() async throws {
        let store = try phone()
        let pictures = Kit.pictures(18)
        let first = session(store)
        _ = await first.runner.pick(Array(pictures.prefix(7)), needsConsent: false)
        try await until("seven read") { page(first)?.save.enabled == true }
        first.send(.save)
        try await until("seven saved") { page(first)?.done != nil }
        first.send(.close)
        let sentBefore = server.count

        let upload = session(store)
        let zip = ZipLazyReadTests.zip(pictures.map { .init($0.name, $0.data, deflate: true) })
        _ = await upload.runner.pick([.init(id: "z", name: "records.zip", data: zip)], needsConsent: false)
        try await until("all settled") { page(upload)?.save.enabled == true }
        let page = try XCTUnwrap(page(upload))
        XCTAssertEqual(server.count - sentBefore, 11, "the 7 known files were never sent")
        XCTAssertTrue(page.summary.hasPrefix("18 files: 7 already in your record"), page.summary)
        XCTAssertEqual(page.documents?.rows.count, 11)
        XCTAssertEqual(page.files.rows.filter { $0.status == "Already in your record" }.count, 7)
        XCTAssertEqual(page.save.label, "Save 11 documents")
        upload.send(.save)
        try await until("done") { self.page(upload)?.done != nil }
        XCTAssertEqual(self.page(upload)?.done?.line, "Saved 11 documents.")
    }

    // MARK: Older engines

    /// An engine without the shared upload's doors: the pick does not run, the model says so (the
    /// sheet then reads in today's flow), and no letter is read from it.
    func testAnEngineWithoutTheDoorsLeavesTodaysFlow() async throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let without = "HealthEngine = (function (e) { var o = Object.assign({}, e); delete o.uploadStartJson; delete o.uploadStepJson; delete o.uploadSavePlanJson; return o; })(HealthEngine);"
        let engine = try HealthEngine(source: try String(contentsOf: url, encoding: .utf8) + "\n" + without, sourceURL: nil, session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let upload = session(store)
        let ran = await upload.runner.pick(Kit.pictures(1), needsConsent: false)
        XCTAssertFalse(ran)
        XCTAssertEqual(upload.model.state, .unavailable)
        XCTAssertEqual(server.count, 0)
        let letter = await upload.letter("f0")
        XCTAssertNil(letter)
    }

    /// A letter opens to the Markdown Save writes (the plan's text), drawn by DocumentText.
    func testALetterOpensToTheTextSaveWrites() async throws {
        let store = try phone()
        let upload = session(store)
        _ = await upload.runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("read") { page(upload)?.documents != nil }
        let letter = await upload.letter("f0")
        XCTAssertEqual(letter, "## Plan\n\nWalk daily.")
    }

    // MARK: The record changes while the page sits idle (PR 1908 review, accepted)

    /// Reading done, another writer lands a different LDL on the day the upload offers: the page draws
    /// the conflict, with Replace and the held value, without a tap. A change elsewhere in the record
    /// changes nothing on the page.
    func testARecordChangeWhileIdleRedrawsThePage() async throws {
        let store = try phone()
        let report = UploadPageTests.lab(values: UploadPageTests.ldl)
        StubHTTP.handler = { _ in Kit.read("{\"accepted\":true}\n{\"status\":200,\"body\":{\"success\":true,\"data\":\(report)}}\n") }
        let upload = session(store)
        _ = await upload.runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("read") { page(upload)?.save.enabled == true }
        XCTAssertTrue(UploadPageTests.unsure(try XCTUnwrap(page(upload))).isEmpty, "no conflict yet")

        _ = await store.apply(.add(metric: "ldl", value: 2.0, day: "2026-10-01"))
        try await until("the conflict drawn") { page(upload).map(UploadPageTests.unsure)?.first?.replace != nil }
        let row = try XCTUnwrap(page(upload).map(UploadPageTests.unsure)?.first)
        XCTAssertEqual(row.held, "2 mmol/L")
        XCTAssertNotNil(row.replaces)

        guard case .drawn(let before) = upload.model.state else { return XCTFail("no view") }
        _ = await store.apply(.add(metric: "hdl", value: 1.4, day: "2026-09-01"))
        try await Task.sleep(for: .milliseconds(300))
        guard case .drawn(let after) = upload.model.state else { return XCTFail("no view") }
        XCTAssertEqual(after, before, "a change the upload does not touch leaves the page as it was")
    }

    /// Codex re-check on c890ebc42, then PR 1912 review (US-13 AC23): a Save tapped while a choice's view is not
    /// drawn waits for that view and then saves it, from the one tap; it never sends back the page from before the choice.
    func testSaveWaitsForTheViewOfAChoiceJustMade() async throws {
        let store = try phone()
        _ = await store.apply(.add(metric: "ldl", value: 2.0, day: "2026-10-01"))
        let hdl = #"{"metric":"hdl","valueSI":1.2,"displayValue":1.2,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}"#
        let report = UploadPageTests.lab(values: "\(UploadPageTests.ldl),\(hdl)")
        StubHTTP.handler = { _ in Kit.read("{\"accepted\":true}\n{\"status\":200,\"body\":{\"success\":true,\"data\":\(report)}}\n") }
        let upload = session(store)
        _ = await upload.runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("read") { page(upload).map(UploadPageTests.unsure)?.first?.replaces != nil }
        let ldl = try XCTUnwrap(page(upload).map(UploadPageTests.unsure)?.first)
        upload.send(.replace(fileId: ldl.fileId, ref: ldl.ref, correctsId: ldl.replaces))
        XCTAssertTrue(upload.choicePending, "the choice's view is not drawn yet")
        upload.send(.save) // tapped before the redraw: held until it draws, then taken
        XCTAssertTrue(upload.saveClaimed, "Close waits from the tap")
        try await until("done") { page(upload)?.done != nil }
        XCTAssertEqual(page(upload)?.done?.line, "Saved 2 values.")
    }

    // MARK: One Save tap, in order after every choice (PR 1912 review R1, R2)

    /// R1 (US-13 AC23): a letter's title typed and not submitted, then one Save tap. The Save button sends the title
    /// first (its commitTitles), then Save: the save happens, and the record holds the typed title.
    func testOneSaveTapWithATitleStillTypedSavesIt_US13_AC23() async throws {
        let store = try phone()
        let upload = session(store)
        _ = await upload.runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("read") { page(upload)?.save.enabled == true }
        let id = try XCTUnwrap(page(upload)?.documents?.rows.first?.fileId)
        upload.send(.title(fileId: id, title: "Heart clinic")) // the Save button's commitTitles
        upload.send(.save)
        try await until("done") { page(upload)?.done != nil }
        XCTAssertTrue(store.recordJSON.contains("Heart clinic"))
        XCTAssertFalse(store.recordJSON.contains("Letter 1"))
    }

    /// R2 (US-13 AC23): two test-day changes wait behind a held engine, then Save. Save is taken only once the second
    /// change's view is drawn: the value saves on the second day, never the first's or the day before them.
    func testSaveAfterTwoQueuedChoicesWritesTheLastChoicesView_US13_AC23() async throws {
        let store = try phone()
        let report = UploadPageTests.lab(reportDate: nil, values: UploadPageTests.ldl)
        StubHTTP.handler = { _ in Kit.read("{\"accepted\":true}\n{\"status\":200,\"body\":{\"success\":true,\"data\":\(report)}}\n") }
        let upload = session(store)
        _ = await upload.runner.pick(Kit.pictures(1), needsConsent: false)
        func undated() -> UploadPage.Undated? {
            page(upload)?.sections.lazy.compactMap { if case .undated(let u) = $0 { u } else { nil } }.first
        }
        try await until("the day asked") { undated() != nil }
        let file = try XCTUnwrap(undated()?.fileId)
        upload.send(.testDay(fileId: file, day: "2026-09-01"))
        try await until("the first day drawn") { undated()?.chosen == "2026-09-01" && page(upload)?.save.enabled == true }
        // The engine is held: both changes wait behind it, and Save is tapped before either is stepped.
        let hold = DispatchSemaphore(value: 0)
        store.engine.enqueue { _ in hold.wait() }
        upload.send(.testDay(fileId: file, day: "2026-09-02"))
        upload.send(.testDay(fileId: file, day: "2026-09-03"))
        upload.send(.save)
        XCTAssertTrue(upload.saveClaimed, "Close waits from the tap")
        hold.signal()
        try await until("done") { page(upload)?.done != nil }
        let record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(store.recordJSON.utf8)) as? [String: Any])
        let ldl = ((record["labValues"] as? [[String: Any]]) ?? []).filter { $0["metricName"] as? String == "ldl" }
        XCTAssertEqual(ldl.map { String(($0["recordedAt"] as? String ?? "").prefix(10)) }, ["2026-09-03"])
    }

    /// Two files: read 1 is a letter, read 2 is `second`, every later read never answers (a file kept in flight).
    private func twoFiles(second: StubHTTP.Answer) {
        let reads = OSAllocatedUnfairLock(initialState: 0)
        StubHTTP.handler = { request in
            guard request.url.path == LabReadSender.path else { return .init(body: Data(#"{"challenge":"c"}"#.utf8)) }
            switch reads.withLock({ $0 += 1; return $0 }) {
            case 1: return Kit.read("{\"accepted\":true}\n{\"status\":200,\"body\":{\"success\":true,\"data\":\(UploadPageTests.letter("Letter 1"))}}\n")
            case 2: return second
            default: return .init(hang: true)
            }
        }
    }

    /// PR 1912 ruling (US-13 AC23): Try again on a failed file, then Save at once, behind a held engine. Save waits for
    /// the retry's view, which has a file in flight: Save is off there, so nothing is written and the claim is let go.
    func testSaveAfterTryAgainWaitsForTheRetrysView_US13_AC23() async throws {
        let store = try phone()
        twoFiles(second: .init(status: 503, headers: Kit.json, body: Data(#"{"error":"Busy","reason":"unavailable"}"#.utf8)))
        let upload = session(store)
        _ = await upload.runner.pick(Kit.pictures(2), needsConsent: false)
        try await until("one read, one failed") {
            page(upload)?.save.enabled == true && page(upload)?.sections.contains { if case .failed(_, _, let retry) = $0 { retry != nil } else { false } } == true
        }
        let before = store.recordJSON
        let hold = DispatchSemaphore(value: 0)
        store.engine.enqueue { _ in hold.wait() }
        upload.send(.retryAll)
        upload.send(.save)
        XCTAssertTrue(upload.saveClaimed, "Close waits from the tap")
        hold.signal()
        try await until("the claim let go") { !upload.saveClaimed && page(upload)?.save.enabled == false }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(page(upload)?.save.why, "Wait for 1 file to finish")
        XCTAssertNil(page(upload)?.done)
        XCTAssertEqual(store.recordJSON, before, "nothing written")
        upload.end()
    }

    /// PR 1912 ruling (US-13 AC23): Stop while a file is read, then Save at once, behind a held engine. Save waits for
    /// the stopped page and saves what it shows: the letter already read.
    func testSaveAfterStopSavesTheStoppedPage_US13_AC23() async throws {
        let store = try phone()
        twoFiles(second: .init(hang: true))
        let upload = session(store)
        _ = await upload.runner.pick(Kit.pictures(2), needsConsent: false)
        try await until("one read, one in flight") { page(upload)?.stop != nil && page(upload)?.documents?.rows.count == 1 }
        let hold = DispatchSemaphore(value: 0)
        store.engine.enqueue { _ in hold.wait() }
        upload.send(.stop)
        upload.send(.save)
        XCTAssertTrue(upload.saveClaimed, "Close waits from the tap")
        hold.signal()
        try await until("done") { page(upload)?.done != nil }
        XCTAssertEqual(page(upload)?.done?.line, "Saved 1 document.")
        XCTAssertTrue(store.recordJSON.contains("Letter 1"))
    }

    /// US-13 AC23: Save tapped as a choice unticks the only value. The awaited view says Save is off: nothing is
    /// written, the claim is let go (Close works), and the page shows the view's own reason.
    func testSaveEndsWithoutWritingWhenTheAwaitedViewTurnsSaveOff_US13_AC23() async throws {
        let store = try phone()
        let report = UploadPageTests.lab(values: UploadPageTests.ldl)
        StubHTTP.handler = { _ in Kit.read("{\"accepted\":true}\n{\"status\":200,\"body\":{\"success\":true,\"data\":\(report)}}\n") }
        let upload = session(store)
        _ = await upload.runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("read") { page(upload)?.save.label == "Save 1 value" && page(upload)?.save.enabled == true }
        let row = try XCTUnwrap(page(upload)?.sure?.rows.first)
        let before = store.recordJSON
        upload.send(.tick(fileId: row.fileId, ref: row.ref, on: false))
        upload.send(.save)
        XCTAssertTrue(upload.saveClaimed, "Close waits from the tap")
        try await until("the claim let go") { !upload.saveClaimed && page(upload)?.save.enabled == false }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(page(upload)?.save.why, "Nothing new to save")
        XCTAssertNil(page(upload)?.done)
        XCTAssertNotEqual(page(upload)?.closeEnabled, false, "Close works")
        XCTAssertFalse(upload.saveClaimed)
        XCTAssertEqual(store.recordJSON, before, "nothing written")
    }

    /// Save writes exactly what the page showed: a sync lands a different LDL after the page was drawn and
    /// before the tap; the LDL the page promised is counted as not added, never written over the synced one.
    func testSaveWritesWhatThePageShowedWhenTheRecordMovesBeforeTheTap() async throws {
        let store = try phone()
        let report = UploadPageTests.lab(values: UploadPageTests.ldl)
        StubHTTP.handler = { _ in Kit.read("{\"accepted\":true}\n{\"status\":200,\"body\":{\"success\":true,\"data\":\(report)}}\n") }
        let upload = session(store)
        _ = await upload.runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("read") { page(upload)?.save.label == "Save 1 value" }
        _ = await store.apply(.add(metric: "ldl", value: 2.0, day: "2026-10-01"))
        upload.send(.save) // the page drawn before the sync is the one tapped
        try await until("done") { page(upload)?.done != nil }
        XCTAssertEqual(page(upload)?.done?.line, "Saved 0 values.")
        XCTAssertEqual(page(upload)?.done?.skipped, ["1 blood test value was not added. Check your blood test table: a value was already recorded for that date, or changed during review."])
    }
}
