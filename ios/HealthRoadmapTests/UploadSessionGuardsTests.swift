import os
import UIKit
import XCTest
@testable import HealthRoadmap

/// PR 1908 fix round (US-25 AC11, lead S52; US-12 AC6, AC30; US-52 AC8b, AC8c): the shared upload's
/// guards as a caller meets them. The page pins the record it opened on, so an erase or a
/// Disconnect meanwhile refuses Save; a choice after a failed Save is what the retry writes; Close
/// while a pick is read holds and sends nothing; Replace selects its value; an engine whose view
/// has no phase takes today's flow; usage is told once a pick. Synthetic files and values only.
@MainActor
final class UploadSessionGuardsTests: XCTestCase, CloudFixtures {
    typealias Kit = UploadTestKit
    /// What each lab read answers: the extraction's JSON for read n.
    final class Answers: @unchecked Sendable {
        private let lock = NSLock()
        private var make: (Int) -> String = { UploadPageTests.letter("Letter \($0)") }
        func set(_ answer: @escaping (Int) -> String) { lock.withLock { make = answer } }
        func answer(_ n: Int) -> String { lock.withLock { make(n) } }
    }
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!
    private var server = Kit.Server()
    private var answers = Answers()

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Upload Guards \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        (server, answers) = (Kit.Server(), Answers())
        let (fake, server, answers) = (dropbox!, server, answers)
        StubHTTP.handler = { request in
            guard request.url.path == LabReadSender.path else { return fake.answer(request) }
            let n = server.seen.withLock { $0.append(""); return $0.count }
            let line = #"{"status":200,"body":{"success":true,"data":\#(answers.answer(n))}}"#
            return Kit.read("{\"accepted\":true}\n\(line)\n")
        }
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
    }

    private func session(_ store: RecordStore, engine: HealthEngine? = nil, analytics: Analytics? = nil,
                         save: (@Sendable (String, Int, Int) async -> String)? = nil) -> UploadSession {
        UploadSession(engine: engine ?? store.engine, store: store, analytics: analytics, sender: LabReadSender(attest: Kit.client()), frame: .milliseconds(1), save: save)
    }

    private func page(_ session: UploadSession) -> UploadPage? {
        if case .drawn(let text) = session.model.state { session.page(text) } else { nil }
    }

    private func until(_ what: String, line: UInt = #line, _ check: () async -> Bool) async throws { try await Kit.until(what, line: line, check) }

    private func cloud() async throws -> (RecordStore, CloudSync) {
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        await sync.start()
        return (store, sync)
    }

    private func readOne(_ upload: UploadSession) async throws {
        let started = await upload.start({ Kit.pictures(1) }, needsConsent: false)
        XCTAssertEqual(started, .running)
        try await until("read") { page(upload)?.save.enabled == true }
    }

    // MARK: 1. The record the page opened on

    /// Another device's erase lands while the page is open: Save is refused in the existing words,
    /// nothing reaches the erased record, and no original is put.
    func testAnEraseWhileThePageIsOpenRefusesItsSave() async throws {
        let before = try record(days: ["2026-10-01"], device: "web")
        dropbox.put(before)
        let (store, sync) = try await cloud()
        let upload = session(store)
        try await readOne(upload)
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
        upload.send(.save)
        try await until("refused") { page(upload)?.save.error != nil }
        XCTAssertEqual(page(upload)?.save.error, RecordStore.recordChanged)
        XCTAssertEqual(dropbox.documents, [:], "no original put")
        await sync.background()
        XCTAssertFalse(String(data: try JSONSerialization.data(withJSONObject: dropbox.record), encoding: .utf8)!.contains("Letter 1"))
        upload.end()
    }

    /// Codex re-check 1: another device's erase lands, then Save and at once Close (which unpins the
    /// record) before the saving view comes back. The Save is still checked against the record the
    /// page opened on: refused, nothing in the erased record, no original put. Close waits from the tap.
    func testSaveThenCloseAfterAnEraseIsStillRefused() async throws {
        let before = try record(days: ["2026-10-01"], device: "web")
        dropbox.put(before)
        let (store, sync) = try await cloud()
        let upload = session(store)
        try await readOne(upload)
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
        upload.send(.save)
        XCTAssertTrue(upload.saveClaimed, "Close waits from the instant of the tap")
        upload.end() // Close's unpin, before the saving view arrives
        try await until("refused") { page(upload)?.save.error != nil }
        XCTAssertEqual(page(upload)?.save.error, RecordStore.recordChanged)
        XCTAssertFalse(upload.saveClaimed)
        XCTAssertEqual(dropbox.documents, [:], "no original put")
        XCTAssertFalse(store.recordJSON.contains("Letter 1"))
        await sync.background()
        XCTAssertFalse(String(data: try JSONSerialization.data(withJSONObject: dropbox.record), encoding: .utf8)!.contains("Letter 1"))
    }

    /// A Disconnect while the page is open: Save is refused, never written to the phone's file instead.
    func testADisconnectWhileThePageIsOpenRefusesItsSave() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync) = try await cloud()
        let upload = session(store)
        try await readOne(upload)
        _ = await sync.disconnect()
        XCTAssertNil(store.cloudErase)
        upload.send(.save)
        try await until("refused") { page(upload)?.save.error != nil }
        XCTAssertEqual(page(upload)?.save.error, RecordStore.recordChanged)
        XCTAssertFalse(store.recordJSON.contains("Letter 1"))
        upload.end()
    }

    // MARK: 2. A choice after a failed Save

    /// A rename after a refused Save is the state's: the retry writes the title the page shows. While
    /// the Save runs, the page's choices are not editable.
    func testARenameAfterAFailedSaveIsWhatTheRecordHolds() async throws {
        let store = try RecordStore(folder: folder, engine: HealthEngine(session: StubHTTP.session()), deviceId: "ios-test")
        let attempts = OSAllocatedUnfairLock(initialState: 0)
        let gate = StubHTTP.Gate()
        let upload = session(store, save: { state, run, attempt in
            let n = attempts.withLock { $0 += 1; return $0 }
            if n == 1 {
                await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in gate.hold { done.resume() } }
                return UploadSession.event(.failure(LabRefusal(message: "Not saved.")), run: run, attempt: attempt)
            }
            return UploadSession.event(await store.saveUpload(state: state, originals: [:], read: { _ in nil }, as: await store.screen), run: run, attempt: attempt)
        })
        try await readOne(upload)
        upload.send(.save)
        XCTAssertTrue(upload.saveClaimed, "Close waits from the tap, before the saving view")
        try await until("saving") { page(upload)?.phase == "saving" }
        XCTAssertTrue(upload.saveClaimed, "and while the engine is saving")
        XCTAssertEqual(page(upload)?.editable, false, "no choice while a Save runs")
        gate.open()
        try await until("refused") { page(upload)?.save.error == "Not saved." }
        XCTAssertFalse(upload.saveClaimed, "the outcome drew: Close is free again")
        XCTAssertEqual(page(upload)?.editable, true)
        let id = try XCTUnwrap(page(upload)?.documents?.rows.first?.fileId)
        upload.send(.title(fileId: id, title: "Heart clinic"))
        try await until("renamed") { page(upload)?.documents?.rows.first?.title == "Heart clinic" }
        upload.send(.save)
        try await until("done") { page(upload)?.done != nil }
        XCTAssertTrue(store.recordJSON.contains("Heart clinic"))
        XCTAssertFalse(store.recordJSON.contains("Letter 1"))
        upload.end()
    }

    /// PR 1908 review: two Saves in a row fail with the same words on an unchanged record, so the
    /// second outcome's view is the text the tap saw. Close waits during each attempt and is free
    /// again once each attempt's outcome draws (US-52 AC8c).
    func testTwoIdenticalFailedSavesEachFreeClose_US52_AC8c() async throws {
        let store = try RecordStore(folder: folder, engine: HealthEngine(session: StubHTTP.session()), deviceId: "ios-test")
        let gates = [StubHTTP.Gate(), StubHTTP.Gate()]
        let attempts = OSAllocatedUnfairLock(initialState: 0)
        let upload = session(store, save: { _, run, attempt in
            let gate = gates[min(attempts.withLock { $0 += 1; return $0 } - 1, 1)]
            await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in gate.hold { done.resume() } }
            return UploadSession.event(.failure(LabRefusal(message: "Not saved.")), run: run, attempt: attempt)
        })
        try await readOne(upload)
        for gate in gates {
            upload.send(.save)
            XCTAssertTrue(upload.saveClaimed, "Close waits from the tap")
            try await until("saving") { page(upload)?.phase == "saving" }
            XCTAssertTrue(upload.saveClaimed, "and while the attempt runs")
            gate.open()
            try await Kit.until("Close free after the attempt", timeout: 5) { !upload.saveClaimed }
            XCTAssertEqual(page(upload)?.save.error, "Not saved.")
        }
        XCTAssertEqual(attempts.withLock { $0 }, 2)
        upload.end()
    }

    // MARK: 2b. The backup prompt counts a Save of values (US-57 AC9)

    /// An onboarded person with no cloud: values saved through three separate uploads count as three
    /// own saves, so the backup prompt is due, as three lab reports on the old path make it. A
    /// document-only upload, a refused Save and a repeat that writes no value count for nothing.
    func testThreeUploadsOfValuesMakeTheBackupPromptDue_US57_AC9() async throws {
        let store = try RecordStore(folder: folder, engine: HealthEngine(session: StubHTTP.session()), deviceId: "ios-test")
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "test.backup.\(UUID().uuidString)"))
        let prompt = CloudPrompt(defaults: defaults)
        let lastSaved = OSAllocatedUnfairLock(initialState: "")
        func upload(_ extraction: String, file: Int) async throws {
            answers.set { _ in extraction }
            let upload = session(store, save: { state, run, attempt in
                lastSaved.withLock { $0 = state }
                return UploadSession.event(await store.saveUpload(state: state, originals: [:], read: { _ in nil }, as: await store.screen), run: run, attempt: attempt)
            })
            let started = await upload.start({ Kit.pictures(1, from: file) }, needsConsent: false)
            XCTAssertEqual(started, .running)
            try await until("read") { page(upload)?.save.enabled == true }
            upload.send(.save)
            try await until("done") { page(upload)?.done != nil }
            upload.end()
            prompt.ownSaves(store.ownSaves) // RootView, once onboarded
        }
        try await upload(UploadPageTests.lab(reportDate: "2026-10-01", values: UploadPageTests.ldl), file: 0)
        XCTAssertEqual(store.ownSaves, 1, "a Save of values counts once")
        try await upload(UploadPageTests.letter("Letter A"), file: 3)
        XCTAssertEqual(store.ownSaves, 1, "a document-only Save does not count")
        let refused = await store.saveUpload(state: "{}", originals: [:], read: { _ in nil }, as: store.screen)
        guard case .failure = refused else { return XCTFail("a malformed state is refused") }
        XCTAssertEqual(store.ownSaves, 1, "a refused Save does not count")
        try await upload(UploadPageTests.lab(reportDate: "2026-10-02", values: UploadPageTests.ldl), file: 6)
        XCTAssertEqual(store.ownSaves, 2)
        XCTAssertFalse(prompt.isDue(connected: false), "two saves: not yet")
        // The page offers no Save when every value is held already, so the repeat is the same Save again.
        let repeated = await store.saveUpload(state: lastSaved.withLock { $0 }, originals: [:], read: { _ in nil }, as: store.screen)
        guard case .success(let outcome) = repeated else { return XCTFail("the repeat answers") }
        XCTAssertEqual(outcome.values, 0, "the repeat writes no value")
        XCTAssertEqual(store.ownSaves, 2, "a repeat that writes no value does not count")
        try await upload(UploadPageTests.lab(reportDate: "2026-10-03", values: UploadPageTests.ldl), file: 9)
        XCTAssertEqual(store.ownSaves, 3)
        XCTAssertTrue(prompt.isDue(connected: false), "the third own save makes the backup prompt due")
    }

    // MARK: 3. Close while a pick is read

    /// Close while a slow File Provider read is under way: the read's answer is never held or sent.
    func testCloseWhileAPickIsReadHoldsAndSendsNothing() async throws {
        let store = try RecordStore(folder: folder, engine: HealthEngine(session: StubHTTP.session()), deviceId: "ios-test")
        let upload = session(store)
        let reading = Task { await upload.start({ try? await Task.sleep(for: .milliseconds(400)); return Kit.pictures(2) }, needsConsent: false) }
        try await Task.sleep(for: .milliseconds(100))
        reading.cancel()
        upload.end()
        _ = await reading.value
        try await Task.sleep(for: .milliseconds(300))
        let held = await upload.runner.heldBytes
        XCTAssertEqual(held, 0)
        XCTAssertEqual(server.count, 0)
    }

    // MARK: 4. Replace on a cleared value

    /// A questioned value that conflicts with the record: cleared, then Replace on, then Save. Replace
    /// selects it, so the held row is entered in error and the correction names it.
    func testReplaceOnAClearedValueCorrectsTheHeldRow() async throws {
        let store = try RecordStore(folder: folder, engine: HealthEngine(session: StubHTTP.session()), deviceId: "ios-test")
        _ = await store.apply(.add(metric: "ldl", value: 2.0, day: "2026-10-01"))
        let asked = #"{"metric":"ldl","valueSI":3.1,"displayValue":3.1,"displayUnit":"mmol/L","displaySystem":"si","confidence":"medium","question":"Was this fasting?"}"#
        answers.set { _ in UploadPageTests.lab(values: asked) }
        let upload = session(store)
        _ = await upload.start({ Kit.pictures(1) }, needsConsent: false)
        try await until("read") { UploadPageTests.unsure(page(upload) ?? .empty).first?.replaces != nil }
        let row = try XCTUnwrap(UploadPageTests.unsure(try XCTUnwrap(page(upload))).first)
        upload.send(.tick(fileId: row.fileId, ref: row.ref, on: false))
        upload.send(.replace(fileId: row.fileId, ref: row.ref, correctsId: row.replaces))
        try await until("replacing") { UploadPageTests.unsure(page(upload) ?? .empty).first?.replacing == true }
        XCTAssertEqual(UploadPageTests.unsure(try XCTUnwrap(page(upload))).first?.ticked, true, "Replace selected the value")
        upload.send(.save)
        try await until("done") { page(upload)?.done != nil }
        let record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(store.recordJSON.utf8)) as? [String: Any])
        let ldl = ((record["labValues"] as? [[String: Any]]) ?? []).filter { $0["metricName"] as? String == "ldl" }
        let old = try XCTUnwrap(ldl.first { $0["id"] as? String == row.replaces })
        XCTAssertEqual(old["status"] as? String, "entered-in-error")
        XCTAssertTrue(ldl.contains { $0["correctsId"] as? String == row.replaces && $0["status"] as? String == "active" })
        upload.end()
    }

    // MARK: 11. An older engine

    /// An engine whose view carries no phase cannot draw the page: the pick is refused as not read
    /// (the sheet says the app's existing words), and nothing is sent.
    func testAnEngineWhoseViewHasNoPhaseTakesTodaysFlow() async throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let without = "HealthEngine = (function (e) { var o = Object.assign({}, e); var v = e.uploadViewJson; o.uploadViewJson = function () { var t = v.apply(null, arguments); var x = JSON.parse(t); delete x.phase; return JSON.stringify(x); }; return o; })(HealthEngine);"
        let engine = try HealthEngine(source: try String(contentsOf: url, encoding: .utf8) + "\n" + without, sourceURL: nil, session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let upload = session(store, engine: engine)
        let started = await upload.start({ Kit.pictures(1) }, needsConsent: false)
        XCTAssertEqual(started, .fallback)
        XCTAssertEqual(server.count, 0)
        upload.end()
    }

    // MARK: 9. Usage, once a pick

    /// One Save of a one-file upload: "Lab save one" once, however often Save is tapped; a file the
    /// record already held: "Lab upload known skipped". Never a count, a name or a hash.
    func testUsageIsToldOnceAPick() async throws {
        let store = try RecordStore(folder: folder, engine: HealthEngine(session: StubHTTP.session()), deviceId: "ios-test")
        let sdk = EventsSDK()
        let analytics = Analytics(sdk: sdk, projectId: "abc", testing: false)
        analytics.start(in: UIWindow())
        var upload = session(store, analytics: analytics)
        let file = Kit.pictures(1)
        _ = await upload.start({ file }, needsConsent: false)
        try await until("read") { page(upload)?.save.enabled == true }
        upload.send(.save)
        upload.send(.save)
        try await until("done") { page(upload)?.done != nil }
        try await until("told") { sdk.events.contains("Lab save one") }
        XCTAssertEqual(sdk.events.filter { $0.hasPrefix("Lab ") }.filter { $0 == "Lab save one" }.count, 1)
        XCTAssertFalse(sdk.events.contains("Lab save all"))
        upload.end()

        upload = session(store, analytics: analytics)
        _ = await upload.start({ file + Kit.pictures(1, from: 4) }, needsConsent: false)
        try await until("read") { page(upload)?.save.enabled == true }
        upload.send(.save)
        try await until("known told") { sdk.events.contains("Lab upload known skipped") }
        XCTAssertTrue(sdk.events.contains("Lab save all"))
        XCTAssertTrue(sdk.events.allSatisfy { !$0.contains("report") && !$0.contains("sha256") })
        upload.end()
    }

    /// No system error text reaches the screen from a source's load: an error that is not the
    /// reader's own (a Photos original not on the phone while offline, say) shows the app's line.
    func testALoadThatFailsWithASystemErrorShowsTheAppsWords_US52_AC10() async throws {
        let store = try RecordStore(folder: folder, engine: HealthEngine(session: StubHTTP.session()), deviceId: "ios-test")
        let upload = session(store)
        defer { upload.end() }
        let started = await upload.start({
            throw NSError(domain: NSCocoaErrorDomain, code: 4097, userInfo: [NSLocalizedDescriptionKey: "Couldn't communicate with a helper application."])
        }, needsConsent: false)
        XCTAssertEqual(started, .refused("Something went wrong, so this report was not read. Please try again."))
        // The reader's own refusals keep their words.
        let folderWords = await upload.start({ throw LabFileReader.Failure.folderEmpty }, needsConsent: false)
        XCTAssertEqual(folderWords, .refused("This folder holds no reports the app can read: no PDF, JPEG or PNG."))
    }

    /// A Save that sends nothing counts nothing (US-52 AC8c): tapped while the page holds a blocker
    /// (an undated report waiting for its day), no "Lab save one" or "Lab save all".
    func testASaveThatSendsNothingIsNotCounted_US52_AC8c() async throws {
        answers.set { _ in UploadPageTests.lab(reportDate: nil, values: UploadPageTests.ldl) }
        let store = try RecordStore(folder: folder, engine: HealthEngine(session: StubHTTP.session()), deviceId: "ios-test")
        let sdk = EventsSDK()
        let analytics = Analytics(sdk: sdk, projectId: "abc", testing: false)
        analytics.start(in: UIWindow())
        let upload = session(store, analytics: analytics)
        defer { upload.end() }
        _ = await upload.start({ Kit.pictures(1) }, needsConsent: false)
        try await until("read, waiting for its day") { page(upload)?.files.rows.first?.status != nil && page(upload)?.save.enabled == false && page(upload)?.save.why != nil }
        upload.send(.save)
        try await until("the claim let go") { !upload.saveClaimed }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertFalse(sdk.events.contains { $0 == "Lab save one" || $0 == "Lab save all" }, "\(sdk.events)")
    }

    private final class EventsSDK: AnalyticsSDK {
        var events: [String] = []
        func mask(_ view: UIView) {}
        func start(projectId: String) -> Bool { true }
        func screen(_ name: String) {}
        func event(_ name: String) { events.append(name) }
    }
}

extension UploadPage {
    /// An empty page, for a wait that reads a page not drawn yet.
    static let empty = UploadPage.decoded(#"{"summary":"","sections":[],"files":{"row":"","rows":[]},"notices":[],"save":{"label":"","enabled":false}}"#)!
}
