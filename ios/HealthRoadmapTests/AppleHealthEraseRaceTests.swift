import HealthKit
import UIKit
import XCTest
@testable import HealthRoadmap

/// US-72 AC10, the PR 1218 review round (Fable's rulings 2026-11-11): what races an erase.
/// R1: no HealthKit read or write proceeds unless the connection generation it started under is
/// still current, the live cards and pages included. R2: a save in flight is drained, within a
/// bound, before the Health delete. R3: the written-ids list is the delete still owed. F4: a
/// Connect meeting a pending erase disconnects first. F5: the record's source is the provider
/// and the account. F7: the remote delete asks only for this app's samples.
/// HealthKit is faked (FakeHealthStore, FakeLiveStore); Dropbox is CloudSyncTests' stub.
@MainActor
final class AppleHealthEraseRaceTests: XCTestCase {
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!
    private var health: FakeHealthStore!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Apple Health Erase Race \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
        health = FakeHealthStore()
        suite = "AppleHealthEraseRaceTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
        defaults.removePersistentDomain(forName: suite)
    }

    private struct App {
        let store: RecordStore
        let sync: CloudSync
        let eraser: DataEraser
        let health: AppleHealthSync
    }

    private var memory: HealthSyncMemory { HealthSyncMemory(defaults: defaults) }

    /// The app's parts as AppParts makes them; `cloud`: Dropbox is connected (not yet opened),
    /// as `account` when given.
    private func app(cloud: Bool, account: String? = nil, live: LiveHealth? = nil) throws -> App {
        if cloud { try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider")) }
        if let account { try Data(account.utf8).write(to: folder.appending(path: "sync-account")) }
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test")
        let appleHealth = AppleHealthSync(store: store, engine: engine, client: health, memory: memory, live: live) { await sync.syncNow() }
        let eraser = DataEraser(store: store, sync: sync, chat: chat, reminders: nil, health: appleHealth, live: live)
        return App(store: store, sync: sync, eraser: eraser, health: appleHealth)
    }

    /// The live cards on a filled fake, read in UTC.
    private func liveHealth() -> (LiveHealth, FakeLiveStore) {
        let store = FakeLiveStore(due: false)
        store.fill(now: .now)
        return (LiveHealth(store: store, calendar: utc), store)
    }

    private let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }()

    /// Measured 2026-10-15, before any erase these tests make.
    private static let morning = HealthSample(
        id: UUID(uuidString: "00000000-0000-0000-0000-0000000000a1")!, metric: "weight", value: 80,
        at: Date(timeIntervalSince1970: 1_792_000_000), timeZone: TimeZone(identifier: "Pacific/Auckland")!)

    private func object(_ json: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
    }

    private func rows(_ record: [String: Any], source: String) -> [[String: Any]] {
        (record["measurements"] as? [[String: Any]] ?? []).filter { $0["source"] as? String == source && $0["status"] as? String == "active" }
    }

    private func epoch(_ record: [String: Any]) -> Int? {
        (record["meta"] as? [String: Any])?["eraseEpoch"] as? Int
    }

    /// An empty record from the web, as the cloud holds it, at `epoch`.
    private func webRecord(epoch: Int = 0) throws -> [String: Any] {
        let json = try HealthEngine().blocking { try $0.newRecord(now: .now, deviceId: "web", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        let record = object(json)
        return epoch == 0 ? record : erased(record, to: epoch)
    }

    /// Another device's erase of `record`: a higher epoch, its time, a later clock, the rows it erased listed.
    private func erased(_ record: [String: Any], to epoch: Int) -> [String: Any] {
        var copy = record
        var meta = record["meta"] as? [String: Any] ?? [:]
        let stamp = Date().addingTimeInterval(-3600).formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        meta["eraseEpoch"] = epoch
        meta["erasedAt"] = stamp
        meta["updatedAt"] = stamp
        meta["lamport"] = ((meta["lamport"] as? Int) ?? 0) + 10
        copy["meta"] = meta
        copy["measurements"] = [[String: Any]]()
        copy["labValues"] = [[String: Any]]()
        let rows = (record["measurements"] as? [[String: Any]] ?? []) + (record["labValues"] as? [[String: Any]] ?? [])
        copy["erasedRows"] = ["fromEpoch": epoch, "ids": rows.compactMap { $0["id"] as? String }]
        return copy
    }

    private func until(_ what: String, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<300 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), what, file: file, line: line)
    }

    private func settle() async {
        try? await Task.sleep(for: .milliseconds(300))
    }

    /// Dropbox open with Health connected, a typed weight written to Health and gone up.
    /// Returns the sync ids written.
    private func connectedInTheCloud(live: LiveHealth? = nil) async throws -> (App, [String]) {
        dropbox.put(try webRecord())
        let app = try app(cloud: true, live: live)
        await app.sync.start()
        await app.health.connect()
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        await app.health.refresh()
        await app.sync.background()
        return (app, health.saved.map(\.syncId).sorted())
    }

    /// Another device's erase, taken in: Apple Health disconnects.
    private func remoteErase(_ app: App) async {
        dropbox.put(erased(dropbox.record, to: 1))
        await app.sync.syncNow()
        await until("the remote erase disconnects Apple Health") { !app.health.connected }
    }

    /// The read threw `CancellationError`: the gate refused it.
    private func refused<T>(_ read: () async throws -> T) async -> Bool {
        do {
            _ = try await read()
            return false
        } catch {
            return error is CancellationError
        }
    }

    // MARK: R1, the connection generation

    func testARemoteEraseDuringAHeldLiveRefreshLandsNothing_US72_AC10_R1() async throws {
        let (live, liveStore) = liveHealth()
        let (app, _) = try await connectedInTheCloud(live: live)
        let before = live.cards
        XCTAssertFalse(before.isEmpty)
        // A read that landed now would empty every card.
        liveStore.empty = Set(LiveMetric.allCases)
        liveStore.delay = .milliseconds(500)
        let latest = liveStore.latestCalls
        let held = Task { await live.refresh(force: true) }
        await until("the live read is under way") { liveStore.latestCalls > latest }

        await remoteErase(app)
        await held.value

        XCTAssertNil(live.ticket(), "no read may start while disconnected")
        XCTAssertEqual(live.cards, before, "the read begun before the disconnect landed nothing")
    }

    func testHistoryReadsWhileDisconnectedReadNothing_US72_AC10_R1() async throws {
        let (live, liveStore) = liveHealth()
        let app = try app(cloud: false, live: live)
        await app.health.connect()
        let before = try XCTUnwrap(live.ticket())
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        let reads = liveStore.reads + liveStore.latestCalls

        XCTAssertNil(live.ticket(), "a page's load stops at its first line")
        let first = await live.firstDays(.steps, reaching: nil)
        XCTAssertNil(first, "a metric page's first days read nothing")
        let days = await refused { try await live.history.refreshDays(live.reader(before), .steps, now: .now, calendar: self.utc) }
        XCTAssertTrue(days, "a metric page's history read under the old ticket is refused")
        let hours = await refused { try await live.history.refreshHours(live.reader(before), .steps, day: .now, now: .now, calendar: self.utc) }
        XCTAssertTrue(hours, "and its hours")
        XCTAssertEqual(liveStore.reads + liveStore.latestCalls, reads, "Health was not read")
        let kept = await live.history.keptDays(.steps)
        XCTAssertNil(kept, "nothing kept")
    }

    /// SleepPage's reads, the first nights and the kept history, under a ticket a remote erase
    /// overtakes mid-read: refused after the read returns, and nothing kept. A SwiftUI page's
    /// body cannot run in a unit test; these are the calls its `load` makes, on the gate it takes.
    func testSleepPageReadsStopWhenAnEraseDisconnectsMidRead_US72_AC10_R1() async throws {
        let (live, liveStore) = liveHealth()
        let (app, _) = try await connectedInTheCloud(live: live)
        let ticket = try XCTUnwrap(live.ticket())
        liveStore.delay = .milliseconds(400)
        let history = Task { try await live.history.refreshNights(live.reader(ticket), now: .now, calendar: self.utc) }
        let first = Task { try await LiveHealth.readNights(live.reader(ticket), reaching: nil, now: .now, calendar: self.utc) }
        try? await Task.sleep(for: .milliseconds(50))

        await remoteErase(app)

        let historyRefused = await refused { try await history.value }
        XCTAssertTrue(historyRefused, "the sleep history read is refused once it returns")
        let firstRefused = await refused { try await first.value }
        XCTAssertTrue(firstRefused, "and the first nights")
        let kept = await live.history.keptNights(calendar: utc)
        XCTAssertNil(kept, "nothing kept")
        XCTAssertFalse(live.holds(ticket))
    }

    // MARK: R2, a save across an erase

    func testASaveHeldAcrossAnEraseIsDeletedAfterItLands_US72_AC10_R2() async throws {
        let app = try app(cloud: false)
        await app.health.connect()
        var reached = false, released = false
        health.saveHold = { [health] in
            health?.saveHold = nil
            reached = true
            for _ in 0..<500 where !released { try? await Task.sleep(for: .milliseconds(10)) }
        }
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        await until("the save is in HealthKit") { reached }

        let erase = Task { await app.eraser.eraseAll() }
        await settle()
        XCTAssertEqual(epoch(object(app.store.recordJSON)), 1, "the record's erase landed first")
        XCTAssertEqual(health.ownDeletes, 0, "the Health delete waits for the save")
        released = true
        guard case .erased = await erase.value else { return XCTFail("the erase was refused") }

        XCTAssertEqual(health.ownDeletes, 1)
        XCTAssertTrue(health.saved.isEmpty, "the held save landed, then was deleted")
        XCTAssertTrue(memory.writtenIds.isEmpty)
        XCTAssertFalse(memory.connected)
    }

    /// A HealthKit call that hangs: the erase waits no longer than the bound, and the sample the
    /// call saves later is deleted on the next return to the foreground.
    func testAHungSaveNeverHoldsTheEraseAndIsDeletedOnTheNextForeground_US72_AC10_R2() async throws {
        let app = try app(cloud: false)
        await app.health.connect()
        var reached = false, released = false
        health.saveHold = { [health] in
            health?.saveHold = nil
            reached = true
            for _ in 0..<1000 where !released { try? await Task.sleep(for: .milliseconds(10)) }
        }
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        await until("the save is in HealthKit") { reached }

        let began = ContinuousClock.now
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        XCTAssertLessThan(ContinuousClock.now - began, AppleHealthSync.drainBound + .seconds(2), "the erase never waits on Health")
        XCTAssertEqual(health.ownDeletes, 1)

        released = true
        await until("the hung save lands") { !health.saved.isEmpty }
        await until("and is listed as owed") { !memory.writtenIds.isEmpty }
        let owed = memory.writtenIds.sorted()
        await app.health.foreground()

        XCTAssertEqual(health.deletedSyncIds.last, owed)
        XCTAssertTrue(health.saved.isEmpty)
        XCTAssertTrue(memory.writtenIds.isEmpty)
        XCTAssertFalse(memory.connected, "the save did not reconnect anything")
    }

    // MARK: R3, the written-ids list is the delete owed

    func testALockedDeleteIsRetriedOnUnlock_US72_AC10_R3() async throws {
        let (app, written) = try await connectedInTheCloud()
        XCTAssertFalse(written.isEmpty)
        health.deleteFails = true
        await remoteErase(app)
        await until("the delete was tried") { health.deleteAttempts == 1 }
        await settle()
        XCTAssertEqual(memory.writtenIds.sorted(), written, "a locked delete keeps the list")

        health.deleteFails = false
        NotificationCenter.default.post(name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        await until("the unlock deletes what is owed") { memory.writtenIds.isEmpty }

        XCTAssertEqual(health.deletedSyncIds, [written])
        XCTAssertNil(defaults.dictionary(forKey: "appleHealth.written"))
    }

    /// Write access turned off: every delete fails. It is tried once per foreground or unlock,
    /// never in a loop, and the list stays. A local erase then deletes, though Health was not
    /// connected as it began.
    func testARefusedDeleteStaysOwedAndIsNotRetriedInALoop_US72_AC10_R3() async throws {
        let (app, written) = try await connectedInTheCloud()
        health.deleteRefusal = CocoaError(.fileWriteNoPermission)
        await remoteErase(app)
        await until("the delete was tried") { health.deleteAttempts == 1 }
        await settle()
        XCTAssertEqual(health.deleteAttempts, 1, "no retry loop")

        await app.health.foreground()
        await settle()
        XCTAssertEqual(health.deleteAttempts, 2, "one try per foreground")
        XCTAssertEqual(memory.writtenIds.sorted(), written, "the list stays: the delete is still owed")

        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        XCTAssertEqual(health.ownDeletes, 1, "a local erase deletes when a delete is owed, connected or not")
        XCTAssertTrue(memory.writtenIds.isEmpty)
    }

    // MARK: F4, a Connect meeting a pending erase

    /// Still connected (Connect is offered after a failed refresh) and the record erased since
    /// the last pass: Connect disconnects first, every anchor reset, then connects again and
    /// reads everything from the start.
    func testConnectWithAPendingEraseDisconnectsThenConnectsAgain_US72_AC10_F4() async throws {
        memory.connected = true
        memory.eraseSeen = EraseSeen(epoch: 0, source: "phone")
        memory.setAnchor(Data("before-the-erase".utf8), for: .weight)
        let app = try app(cloud: false)
        guard case .erased = await app.store.erasePhone(historyJSON: nil, keepChat: { _, _ in true }) else {
            return XCTFail("the record was not erased")
        }
        XCTAssertEqual(epoch(object(app.store.recordJSON)), 1)
        health.pending[.weight] = [Self.morning]

        await app.health.connect()

        XCTAssertEqual(health.stops, 1, "disconnected first")
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 1, source: "phone"))
        XCTAssertTrue(app.health.connected, "then connected again")
        XCTAssertEqual(health.observed, HealthKind.allCases)
        let firstRead = try XCTUnwrap(health.sampleAnchors[.weight]?.first, "weight was read")
        XCTAssertNil(firstRead, "read from the start, not from the anchor kept before the erase")
        XCTAssertEqual(rows(object(app.store.recordJSON), source: "apple_health").count, 1)
    }

    // MARK: F5, the record's source

    func testAnotherAccountOnTheSameProviderIsANewSource_US72_AC10_F5() async throws {
        dropbox.put(try webRecord(epoch: 2))
        memory.eraseSeen = EraseSeen(epoch: 0, source: "dropbox:dbid:A")
        let app = try app(cloud: true, account: "dbid:B")
        await app.health.connect()
        XCTAssertNil(app.store.recordSource, "no source until the cloud record is drawn")

        await app.sync.start()
        XCTAssertNotNil(app.store.cloudErase, "the cloud record is open")
        await settle()

        XCTAssertEqual(app.store.recordSource, "dropbox:dbid:B", "the provider and the account")
        XCTAssertTrue(app.health.connected, "another account's erase is a new source: adopted")
        XCTAssertEqual(health.stops, 0)
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 2, source: "dropbox:dbid:B"))
    }

    // MARK: F7, only this app's samples

    /// The remote delete's predicate: our sync ids AND this app as the source. The fake cannot
    /// run a HealthKit query, so this pins the predicate the real client sends; no test runs it
    /// against Health's own store.
    func testTheRemoteDeleteAsksOnlyForThisAppsSamples_US72_AC10_F7() throws {
        let predicate = try XCTUnwrap(HealthKitClient.deletePredicate(syncIds: ["abc"]) as? NSCompoundPredicate)
        XCTAssertEqual(predicate.compoundPredicateType, .and)
        let parts = try XCTUnwrap(predicate.subpredicates as? [NSPredicate])
        XCTAssertEqual(parts.count, 2)
        XCTAssertTrue(parts[0].predicateFormat.contains("healthroadmap:abc"), parts[0].predicateFormat)
        XCTAssertEqual(parts[1].predicateFormat, HKQuery.predicateForObjects(from: HKSource.default()).predicateFormat, "and the source is this app")
    }
}
