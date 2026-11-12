import XCTest
@testable import HealthRoadmap

/// Pins today's behaviour of RecordStore's phone/cloud source (US-25 AC11; the mark, US-72 AC10;
/// leads S10, S23, H28, 2026-11-12), before its cloud fields (cloudErase, cloudSession, cloudName, cloudAccount,
/// marksPending, recordJSON) become one `Source` union. Each test is named "...Today": the
/// Source union PR changes what it shows, and says so. The engine is held on its own queue
/// or the cloud's reads at a StubHTTP.Gate, never with a fixed delay.
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

    /// Holds the engine's queue until `release()`: every engine call asked for meanwhile waits.
    private func holdEngine(_ engine: HealthEngine) -> () -> Void {
        let held = DispatchSemaphore(value: 0)
        engine.enqueue { _ in held.wait() }
        return { held.signal() }
    }

    /// Fulfilled when the store's cloud erase is about to change.
    private func eraseChanges(_ store: RecordStore) -> XCTestExpectation {
        let changed = XCTestExpectation(description: "the cloud erase changes")
        withObservationTracking { _ = store.cloudErase } onChange: { changed.fulfill() }
        return changed
    }

    // MARK: S10 · showPhone's window

    /// Pins today's behaviour (lead S10); the Source union PR changes this. showPhone clears
    /// the cloud erase before it awaits the engine's read of the phone's file, so while that
    /// read runs the screen reports the phone (erase nil) over the cloud's record and drawing
    /// (US-25 AC11).
    func testShowPhoneReportsThePhoneOverTheCloudRecordWhileItReadsToday() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let phone = store.recordJSON
        let cloud = try cloudRecord(from: phone, day: "2026-10-02", engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        XCTAssertEqual(store.screen.erase, "e-1")
        let drawsOnCloud = store.draws

        let release = holdEngine(engine)
        let cleared = eraseChanges(store)
        let showing = store.showPhone()
        await fulfillment(of: [cleared], timeout: 10)
        // The step has cleared the erase and now waits for the held loadPhone.
        XCTAssertNil(store.screen.erase, "the screen reports the phone's file")
        XCTAssertNil(store.mark.erase)
        XCTAssertEqual(store.recordJSON, cloud, "while the record is still the cloud's")
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-10-02"])
        XCTAssertEqual(store.draws, drawsOnCloud, "and My data is still the cloud's drawing")
        XCTAssertNotNil(store.myData)
        release()
        await showing.value
        XCTAssertEqual(store.recordJSON, phone, "the phone's record once its read lands")
        XCTAssertEqual(store.draws, drawsOnCloud + 1)
    }

    // MARK: S10 · cloudSession is never cleared

    /// Pins today's behaviour (lead S10); the Source union PR changes this. showPhone clears
    /// the erase and the cloud's name, never the engine session the cloud record came from.
    func testShowPhoneKeepsTheCloudSessionToday() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        XCTAssertNil(store.cloudSession, "no cloud record yet")
        let cloud = try cloudRecord(from: store.recordJSON, day: "2026-10-02", engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        XCTAssertEqual(store.cloudSession, 7)
        await store.showPhone().value
        XCTAssertNil(store.cloudErase)
        XCTAssertEqual(store.recordSource, "phone", "the phone's file is shown")
        XCTAssertEqual(store.cloudSession, 7, "the cloud's session is still held")
    }

    /// Pins today's behaviour (lead S10); the Source union PR changes this. A real Disconnect
    /// (CloudSync, Dropbox stub) ends on showPhone and leaves the store's session set.
    func testADisconnectKeepsTheCloudSessionToday() async throws {
        let dropbox = CloudSyncTests.FakeDropbox()
        StubHTTP.handler = { dropbox.answer($0) }
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        await sync.start()
        XCTAssertNotNil(store.cloudErase, "the cloud record is open")
        let opened = try XCTUnwrap(store.cloudSession)
        let copied = await sync.disconnect()
        XCTAssertTrue(copied)
        XCTAssertEqual(sync.status, .onPhone)
        XCTAssertNil(store.cloudErase)
        XCTAssertEqual(store.recordSource, "phone")
        XCTAssertEqual(store.cloudSession, opened, "the closed session is still held")
    }

    // MARK: S23 · the store's own copies of the account and the pending marker

    /// Pins today's behaviour (lead S23); the Source union PR changes this. CloudSync pushes
    /// cloudAccount and marksPending into the store; showPhone alone keeps both, so the phone's
    /// file then has no source for Apple Health (US-72 AC10). Disconnect's transition clears them.
    func testTheStoreKeepsCloudSyncsAccountAndMarkerUntilItsTransitionToday() async throws {
        let dropbox = CloudSyncTests.FakeDropbox()
        StubHTTP.handler = { dropbox.answer($0) }
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        await sync.start()
        let account = try XCTUnwrap(store.cloudAccount)
        XCTAssertTrue(account.hasPrefix("dropbox"), account)
        XCTAssertNotNil(store.marksPending, "set while connected, even with the record open")
        XCTAssertEqual(store.recordSource, account)
        await store.showPhone().value
        XCTAssertEqual(store.cloudAccount, account, "showPhone alone keeps the account")
        XCTAssertNotNil(store.marksPending, "and the marker")
        XCTAssertNil(store.recordSource, "so the phone's file has no source")
        _ = await sync.disconnect()
        XCTAssertNil(store.cloudAccount, "Disconnect's transition clears both")
        XCTAssertNil(store.marksPending)
        XCTAssertEqual(store.recordSource, "phone")
    }

    // MARK: H28 · a cloud mark holds on the phone

    /// Pins today's behaviour (lead H28); the Source union PR changes this. Mark.holds compares
    /// the cloud erase only while both marks have one (RecordStore+Mark.swift:17), so a mark
    /// taken on the cloud record still holds once the phone's file is shown, and an Apple
    /// Health batch read from the cloud lands on the phone's file (US-72 AC10).
    func testACloudMarkHoldsOnThePhoneRecordToday() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let cloud = try cloudRecord(from: store.recordJSON, day: "2026-10-02", engine: engine)
        await store.showCloud(HealthEngine.CloudView(record: cloud, erase: "e-1", session: 7)).value
        let onCloud = store.mark
        XCTAssertEqual(onCloud.erase, "e-1")
        await store.showPhone().value
        XCTAssertNil(store.mark.erase)
        XCTAssertTrue(onCloud.holds(at: store.mark), "the cloud's mark holds on the phone")
        let result = await store.applyNow(.add(metric: "weight", value: 81, day: "2026-10-05"), on: onCloud)
        XCTAssertEqual(result, .saved(), "the batch read on the cloud lands on the phone")
        XCTAssertEqual(activeDays(try String(contentsOf: RecordStore.file(in: folder), encoding: .utf8)), ["2026-10-05"])
    }
}
