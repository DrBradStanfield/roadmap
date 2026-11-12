import XCTest
@testable import HealthRoadmap

/// RecordStore's phone/cloud source as one `Source` union (US-25 AC11; the mark, US-72 AC10;
/// leads S10, S23, H28). These began as pins of the old fields' behaviour; the union PR flipped
/// them to what it shows now. The engine is held on its own queue or the cloud's reads at a
/// StubHTTP.Gate, never with a fixed delay. Every cell of the transition: RecordSourceTests.
@MainActor
final class RecordSourcePinsTests: XCTestCase, CloudFixtures {
    private var folder: URL!
    private var tokens: TokenStore!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Record Source \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
        UnitChoices().save()
    }

    /// The phone's record with one more weight row, as a cloud record: the same eraseEpoch.
    private func cloudRecord(from phone: String, day: String, engine: HealthEngine) throws -> String {
        try XCTUnwrap(engine.blocking { try $0.apply(.add(metric: "weight", value: 80, day: day), to: phone, now: .now, deviceId: "web") }.record)
    }

    /// The days the phone's file holds; none when there is no file yet.
    private func phoneFileDays() -> [String] {
        (try? String(contentsOf: RecordStore.file(in: folder), encoding: .utf8)).map(activeDays) ?? []
    }

    /// Holds the engine's queue until `release()`: every engine call asked for meanwhile waits.
    private func holdEngine(_ engine: HealthEngine) -> () -> Void {
        let held = DispatchSemaphore(value: 0)
        engine.enqueue { _ in held.wait() }
        return { held.signal() }
    }

    /// Fulfilled when the store's source is about to change.
    private func sourceChanges(_ store: RecordStore) -> XCTestExpectation {
        let changed = XCTestExpectation(description: "the source changes")
        withObservationTracking { _ = store.source } onChange: { changed.fulfill() }
        return changed
    }

    // MARK: S10 · showPhone's window

    /// Lead S10: while showPhone reads the phone's file, the screen still shows the cloud's record
    /// and reports the cloud (`leaving`), so nothing taken in that window is checked against the
    /// phone. An edit asked then is refused in its turn with the usual words and never reaches the
    /// phone's file (US-25 AC11).
    func testShowPhoneReportsTheCloudUntilThePhoneRecordLands() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let phone = store.recordJSON
        let cloud = try cloudRecord(from: phone, day: "2026-10-02", engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        XCTAssertEqual(store.screen.erase, "e-1")
        let drawsOnCloud = store.draws

        let release = holdEngine(engine)
        let leaving = sourceChanges(store)
        let showing = store.showPhone()
        await fulfillment(of: [leaving], timeout: 10)
        // The step is leaving the cloud and waits for the held loadPhone.
        XCTAssertEqual(store.screen.erase, "e-1", "the screen still reports the cloud")
        XCTAssertEqual(store.mark.erase, "e-1")
        XCTAssertNil(store.recordSource, "no source for Apple Health while it moves")
        XCTAssertEqual(store.recordJSON, cloud, "the record is still the cloud's")
        XCTAssertEqual(store.draws, drawsOnCloud, "and so is the drawing")
        // An edit asked now, on the screen it sees: it waits behind showPhone.
        let seen = store.screen
        let asked = Task { await store.apply(.add(metric: "weight", value: 82, day: "2026-10-07"), as: seen) }
        release()
        await showing.value
        XCTAssertNil(store.screen.erase, "the phone's record once its read lands")
        XCTAssertEqual(store.recordJSON, phone)
        XCTAssertEqual(store.draws, drawsOnCloud + 1)
        let result = await asked.value
        XCTAssertEqual(result, .refused(message: "Your record changed while this was open, so this was not saved. Close this and enter the value again.", existingId: nil))
        XCTAssertFalse(phoneFileDays().contains("2026-10-07"), "the edit never reaches the phone's file")
        XCTAssertEqual(store.recordJSON, phone)
    }

    /// Shows a cloud record, then starts showPhone with the engine held: returns once the store
    /// is `leaving`, with the release and the showPhone step.
    private func leavingTheCloud(_ store: RecordStore, engine: HealthEngine) async throws -> (release: () -> Void, showing: Task<Void, Never>) {
        let cloud = try cloudRecord(from: store.recordJSON, day: "2026-10-02", engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        let release = holdEngine(engine)
        let leaving = sourceChanges(store)
        let showing = store.showPhone()
        await fulfillment(of: [leaving], timeout: 10)
        XCTAssertEqual(store.screen.erase, "e-1", "leaving: the screen still reports the cloud")
        return (release, showing)
    }

    /// Lead S10 (review R2): a lab report saved during showPhone's read is refused in its turn with
    /// the existing words before anything is read against the phone's record, so a summary that
    /// would fail there (a value the report lacks) cannot answer instead. Nothing is written.
    func testALabImportAskedWhileLeavingTheCloudIsRefused() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let (release, showing) = try await leavingTheCloud(store, engine: engine)
        store.pinScreen()  // the review sheet opens on the cloud's screen
        defer { store.unpinScreen() }
        let extraction = #"{"classification":"lab_report","reportDate":"2026-10-01","values":[{"metric":"ldl","valueSI":3.1,"displayValue":3.1,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}],"additionalValues":[],"refusedValues":[]}"#
        let asked = Task { await store.importLabs(extractionJSON: extraction, refs: ["v9"], reportDay: "2026-10-01") }
        release()
        await showing.value
        let result = await asked.value
        XCTAssertEqual(result, .failure(LabRefusal(message: "Your record changed while this was open, so this was not saved. Close this and enter the value again.")))
        let onDisk = (try? Data(contentsOf: RecordStore.file(in: folder))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        XCTAssertEqual((onDisk?["labValues"] as? [Any])?.count ?? 0, 0, "nothing reaches the phone's file")
    }

    /// Lead S10 (review R2): a document filed during showPhone's read is refused in its turn with
    /// the existing words, and nothing is written.
    func testADocumentSavedWhileLeavingTheCloudIsRefused() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let (release, showing) = try await leavingTheCloud(store, engine: engine)
        store.pinScreen()
        defer { store.unpinScreen() }
        let letter = ##"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Cardiology follow-up","documentDate":null,"contentMarkdown":"# Letter","metadata":{}}}"##
        let choice = DocumentChoice(kind: .document, sourceFileName: "Letter.pdf", title: "Cardiology follow-up", documentDate: nil, mimeType: "application/pdf", contentHash: nil)
        let asked = Task { await store.saveDocument(extractionJSON: letter, choice: choice, original: nil) }
        release()
        await showing.value
        let result = await asked.value
        XCTAssertEqual(result, .refused("Your record changed while this was open, so this was not saved. Close this and try again."))
        let onDisk = (try? Data(contentsOf: RecordStore.file(in: folder))).flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        XCTAssertEqual((onDisk?["documents"] as? [Any])?.count ?? 0, 0, "nothing reaches the phone's file")
        XCTAssertFalse(store.recordJSON.contains("Cardiology follow-up"))
    }

    // MARK: S10b · the cloud session goes with the cloud

    /// Lead S10: the phone's source has no session field, so showPhone leaves none behind.
    func testShowPhoneDropsTheCloudSession() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        XCTAssertEqual(store.source, .phone(link: nil), "no cloud record yet")
        let cloud = try cloudRecord(from: store.recordJSON, day: "2026-10-02", engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        XCTAssertEqual(store.source, .cloud(.init(erase: "e-1", session: 7, link: nil, drawnAccount: nil)))
        await store.showPhone().value
        XCTAssertEqual(store.source, .phone(link: nil), "the phone's file, and no session")
        XCTAssertEqual(store.recordSource, "phone")
    }

    /// Lead S10: a real Disconnect (CloudSync, Dropbox stub) ends on the phone with no link and no session.
    func testADisconnectDropsTheCloudSession() async throws {
        let dropbox = CloudSyncTests.FakeDropbox()
        StubHTTP.handler = { dropbox.answer($0) }
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        await sync.start()
        guard case .cloud(let open) = store.source else { return XCTFail("the cloud record is open: \(store.source)") }
        XCTAssertEqual(sync.connection.shownSession, open.session)
        let copied = await sync.disconnect()
        XCTAssertTrue(copied)
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertEqual(store.source, .phone(link: nil), "no link and no session")
        XCTAssertEqual(store.recordSource, "phone")
    }

    // MARK: S23 · one link, set by one event

    /// Lead S23: CloudSync's link (account and pending marker) is one value in the source, set only
    /// by `link`. A bare showPhone keeps it, so the phone's file has no Apple Health source while a
    /// cloud is connected (US-72 AC10); Disconnect clears it, and the source is "phone".
    func testTheLinkMovesWithTheSourceAndOnlyCloudSyncSetsIt() async throws {
        let dropbox = CloudSyncTests.FakeDropbox()
        StubHTTP.handler = { dropbox.answer($0) }
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        await sync.start()
        guard case .cloud(let open) = store.source, let link = open.link else { return XCTFail("a linked cloud record: \(store.source)") }
        XCTAssertTrue(link.account.hasPrefix("dropbox"), link.account)
        XCTAssertEqual(store.recordSource, link.account)
        await store.showPhone().value
        XCTAssertEqual(store.source, .phone(link: link), "a bare showPhone keeps the link")
        XCTAssertNil(store.recordSource, "so the phone's file has no source while connected")
        _ = await sync.disconnect()
        XCTAssertEqual(store.source, .phone(link: nil), "Disconnect clears it")
        XCTAssertEqual(store.recordSource, "phone")
    }

    /// Review R1 (US-72 AC10): Apple Health's source names the account the shown record was drawn
    /// under, never a newer link. A switch can link another account while the old cloud's record
    /// is still shown (its showPhone queued behind a held step); the gate must decide nothing then.
    func testTheSourceIsTheAccountTheShownRecordWasDrawnUnder() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let pending = PhoneFiles(record: nil, pending: nil)
        store.link(.init(account: "dropbox:A", pending: pending))
        let cloud = try cloudRecord(from: store.recordJSON, day: "2026-10-02", engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        XCTAssertEqual(store.recordSource, "dropbox:A")

        let release = holdEngine(engine)
        let held = store.redraw()  // a chained step held on the engine, as an upload would be
        store.link(.init(account: "googleDrive:B", pending: pending))
        XCTAssertNil(store.recordSource, "the shown record is A's: no source while the link says B")
        release()
        await held.value
        XCTAssertNil(store.recordSource, "still A's record on screen")

        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-2", session: 8)).value
        XCTAssertEqual(store.recordSource, "googleDrive:B", "B's own record names B")
    }

    /// Review round 2 (US-72 AC10): a re-read of the old cloud in its own session, queued behind a
    /// held step, lands after a switch linked another account. It keeps the account its session's
    /// first record was drawn under, so the source stays nil until the new cloud's own record.
    func testASameSessionReReadAfterARelinkKeepsTheDrawnAccount() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let pending = PhoneFiles(record: nil, pending: nil)
        let a = RecordStore.Source.Link(account: "dropbox:A", pending: pending)
        let b = RecordStore.Source.Link(account: "googleDrive:B", pending: pending)
        store.link(a)
        let cloud = try cloudRecord(from: store.recordJSON, day: "2026-10-02", engine: engine)
        let view = HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)
        await store.showCloud(view).value
        XCTAssertEqual(store.recordSource, "dropbox:A")

        let release = holdEngine(engine)
        let reread = store.showCloud(view)  // the old session's news, queued behind the held engine
        store.link(b)                       // the switch's keep
        release()
        await reread.value
        XCTAssertEqual(store.source, .cloud(.init(erase: "e-1", session: 7, link: b, drawnAccount: "dropbox:A")))
        XCTAssertNil(store.recordSource, "A's record is shown: no source while the link says B")

        await store.showPhone().value
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-2", session: 8)).value
        XCTAssertEqual(store.recordSource, "googleDrive:B", "B's own record names B")
    }

    // MARK: H28 · a cloud mark never lands on the phone

    /// Lead H28: an Apple Health batch read from the cloud record writes nothing once the phone's
    /// file is shown, in its turn (US-72 AC10): `applyNow(_:on:)` compares the sides too. Mark.holds
    /// itself is unchanged, so the chat still reads connecting or disconnecting as no erase (US-67).
    func testACloudMarkDoesNotLandOnThePhoneRecord() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let cloud = try cloudRecord(from: store.recordJSON, day: "2026-10-02", engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        let onCloud = store.mark
        XCTAssertEqual(onCloud.erase, "e-1")
        await store.showPhone().value
        XCTAssertNil(store.mark.erase)
        XCTAssertTrue(onCloud.holds(at: store.mark), "Mark.holds is unchanged: the chat sees no erase")
        let result = await store.applyNow(.add(metric: "weight", value: 81, day: "2026-10-05"), on: onCloud)
        XCTAssertNil(result, "the batch read on the cloud writes nothing on the phone")
        XCTAssertFalse(phoneFileDays().contains("2026-10-05"))
        XCTAssertFalse(activeDays(store.recordJSON).contains("2026-10-05"))
    }

    /// Lead H28, the other way (review R3): a batch read on the phone while a cloud connects writes
    /// nothing once the handover shows the cloud record.
    func testAPhoneMarkDoesNotLandOnTheCloudRecord() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let onPhone = store.mark
        XCTAssertNil(onPhone.erase)
        let cloud = try cloudRecord(from: store.recordJSON, day: "2026-10-02", engine: engine)
        let shown = await store.handOver(to: HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)) { true }
        XCTAssertTrue(shown)
        XCTAssertEqual(store.mark.erase, "e-1")
        XCTAssertTrue(onPhone.holds(at: store.mark), "Mark.holds is unchanged: the chat sees no erase")
        let result = await store.applyNow(.add(metric: "weight", value: 81, day: "2026-10-05"), on: onPhone)
        XCTAssertNil(result, "the batch read on the phone writes nothing on the cloud record")
        XCTAssertEqual(store.recordJSON, cloud)
        XCTAssertFalse(phoneFileDays().contains("2026-10-05"))
    }
}
