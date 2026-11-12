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

    // MARK: S10b · the cloud session goes with the cloud

    /// Lead S10: the phone's source has no session field, so showPhone leaves none behind.
    func testShowPhoneDropsTheCloudSession() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        XCTAssertEqual(store.source, .phone(link: nil), "no cloud record yet")
        let cloud = try cloudRecord(from: store.recordJSON, day: "2026-10-02", engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        XCTAssertEqual(store.source, .cloud(.init(erase: "e-1", session: 7, link: nil)))
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
}
