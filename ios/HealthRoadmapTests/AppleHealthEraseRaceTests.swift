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
        XCTAssertFalse(live.cards.isEmpty)
        // The erase forgets the cards (edge 3); a read that landed after it would draw them again.
        liveStore.delay = .milliseconds(500)
        let latest = liveStore.latestCalls
        let held = Task { await live.refresh(force: true) }
        await until("the live read is under way") { liveStore.latestCalls > latest }

        await remoteErase(app)
        await held.value

        XCTAssertNil(live.ticket(), "no read may start while disconnected")
        await until("the read begun before the disconnect landed nothing") { live.cards.isEmpty }
        await settle()
        XCTAssertTrue(live.cards.isEmpty, "and draws nothing later")
        XCTAssertFalse(live.hasRead)
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
        XCTAssertTrue(memory.owed.isEmpty)
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
        await until("and is listed as owed") { !memory.owed.isEmpty }
        let owed = memory.owed.keys.sorted()
        await app.health.foreground()

        XCTAssertEqual(health.deletedSyncIds.last, owed)
        XCTAssertTrue(health.saved.isEmpty)
        XCTAssertTrue(memory.owed.isEmpty)
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
        XCTAssertEqual(memory.owed.keys.sorted(), written, "a locked delete keeps the list")

        health.deleteFails = false
        NotificationCenter.default.post(name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        await until("the unlock deletes what is owed") { memory.owed.isEmpty }

        XCTAssertEqual(health.deletedSyncIds, [written])
        XCTAssertNil(defaults.dictionary(forKey: "appleHealth.owed"))
    }

    /// Write access turned off: every delete fails. It is tried once per foreground or unlock,
    /// never in a loop, and the list stays. A local erase then tries, though Health was not
    /// connected as it began; refused again, the ids stay owed and the erase says so (A1).
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
        XCTAssertEqual(memory.owed.keys.sorted(), written, "the list stays: the delete is still owed")

        guard case .erased(let words) = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        XCTAssertEqual(health.ownDeletes, 1, "a local erase deletes when a delete is owed, connected or not")
        XCTAssertEqual(memory.owed.keys.sorted(), written, "refused again: still owed")
        XCTAssertTrue(words.hasSuffix(EraseText.healthNotErased), words)

        health.deleteRefusal = nil
        await app.health.foreground()
        XCTAssertTrue(memory.owed.isEmpty, "the next foreground deletes them")
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

    // MARK: Round 3: edges 1-3, Codex C-R1 and C-R2, F6

    /// The owed list's two invariants: an id is in at most one of written and owed, and an id
    /// leaves owed only on its own successful delete at the version snapshotted for it.
    /// The first is checked on a live pass too, after a Connect whose owed delete failed
    /// (`testASurvivingRowIsNeverDeletedByAnOwedRetryAfterReconnect_US72_AC10`), and after
    /// every step of the sequences in `testNoIdIsEverWrittenAndOwedAtOnce_US72_AC10`.
    func testTheOwedListInvariants_US72_AC10() {
        let memory = memory
        func disjoint() -> Bool { memory.owed.keys.allSatisfy { memory.writtenVersion($0) == 0 } }
        memory.setWritten(1, for: "a")
        memory.setWritten(1, for: "b")
        XCTAssertTrue(disjoint())

        memory.oweWritten()
        XCTAssertEqual(memory.owed, ["a": 1, "b": 1])
        XCTAssertEqual(memory.writtenVersion("a"), 0, "moved, not copied")
        XCTAssertTrue(disjoint())

        memory.owe(2, for: "a")
        XCTAssertTrue(disjoint())
        memory.paid(["a": 1, "b": 1])
        XCTAssertEqual(memory.owed, ["a": 2], "a newer version saved after the snapshot stays")
        memory.paid([:])
        XCTAssertEqual(memory.owed, ["a": 2], "an id not deleted stays")
        memory.paid(["a": 2])
        XCTAssertTrue(memory.owed.isEmpty)
        XCTAssertNil(defaults.dictionary(forKey: "appleHealth.owed"))
    }

    /// Edge 1: Connect runs the owed delete first. Locked, it still connects, and the old ids
    /// stay owed, never taken as written; the next foreground deletes them.
    func testAConnectWhoseOwedDeleteFailsStillConnectsAndKeepsTheOldIdsOwed_US72_AC10_E1() async throws {
        let (app, written) = try await connectedInTheCloud()
        health.deleteFails = true
        await remoteErase(app)
        await until("the erase's delete was tried") { health.deleteAttempts == 1 }

        await app.health.connect()

        XCTAssertEqual(health.deleteAttempts, 2, "Connect tried the owed delete")
        XCTAssertTrue(app.health.connected, "and connected though it failed")
        XCTAssertEqual(memory.owed.keys.sorted(), written, "the old ids stay owed")
        XCTAssertTrue(written.allSatisfy { memory.writtenVersion($0) == 0 }, "never taken as written")

        health.deleteFails = false
        await app.health.foreground()
        XCTAssertEqual(health.deletedSyncIds.last, written)
        XCTAssertTrue(memory.owed.isEmpty)
        XCTAssertTrue(app.health.connected)
    }

    /// Edge 2 (adversary A1): write access to waist turned off before a local erase. The weight
    /// sample is deleted and its id leaves; the waist sample stays in Health, its id stays owed,
    /// and the erase says the samples could not all be deleted.
    func testAKindWithWriteAccessOffStaysOwed_US72_AC10_E2() async throws {
        let app = try app(cloud: false)
        await app.health.connect()
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        await XCTAssertSaved(await app.store.apply(.add(metric: "waist", value: 90, day: "2026-10-01")))
        await app.health.refresh()
        let waist = try XCTUnwrap(health.saved.first { $0.kind == .waist }?.syncId)
        XCTAssertNotNil(health.saved.first { $0.kind == .weight })
        health.writable.remove(.waist)

        guard case .erased(let words) = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }

        XCTAssertEqual(memory.owed.keys.sorted(), [waist], "only the waist id stays owed")
        XCTAssertEqual(health.saved.map(\.syncId), [waist], "the weight sample went; the waist sample stays")
        XCTAssertTrue(words.hasSuffix(EraseText.healthNotErased), words)
    }

    /// Edge 3 (adversary A3): a remote erase forgets the live cards and the kept history, as a
    /// local erase does: nothing from before it stays on screen or on disk.
    func testARemoteEraseForgetsTheCardsAndTheKeptHistory_US72_AC10_E3() async throws {
        let kept = folder.appending(path: "Live/last-readings.json")
        try FileManager.default.createDirectory(at: kept.deletingLastPathComponent(), withIntermediateDirectories: true)
        let liveStore = FakeLiveStore(due: false)
        liveStore.fill(now: .now)
        let live = LiveHealth(store: liveStore, calendar: utc, kept: kept)
        let (app, _) = try await connectedInTheCloud(live: live)
        XCTAssertFalse(live.cards.isEmpty, "a card is drawn")
        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.path(percentEncoded: false)))
        let ticket = try XCTUnwrap(live.ticket())
        _ = try await live.history.refreshDays(live.reader(ticket), .steps, now: .now, calendar: utc)
        let before = await live.history.keptDays(.steps)
        XCTAssertNotNil(before, "history is kept")

        await remoteErase(app)

        await until("the cards are gone") { live.cards.isEmpty }
        XCTAssertFalse(FileManager.default.fileExists(atPath: kept.path(percentEncoded: false)), "and their file")
        let after = await live.history.keptDays(.steps)
        XCTAssertNil(after, "and the kept history")
    }

    /// Codex C-R1: a correction keeps its sync id. Held past the drain, it lands after the
    /// delete took that id's sample but before the delete returned: the newer version stays
    /// owed, and the next foreground deletes it.
    func testACorrectionLandingDuringTheDeleteStaysOwed_US72_AC10_CR1() async throws {
        let app = try app(cloud: false)
        await app.health.connect()
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        await app.health.refresh()
        let first = try XCTUnwrap(health.saved.first)
        var reached = false, released = false
        health.saveHold = { [health] in
            health?.saveHold = nil
            reached = true
            for _ in 0..<1000 where !released { try? await Task.sleep(for: .milliseconds(10)) }
        }
        let rowId = try XCTUnwrap(app.store.myData?.vitals.first?.latest?.id)
        await XCTAssertSaved(await app.store.apply(.correct(id: rowId, value: 81)))
        await until("the correction is in HealthKit") { reached }
        let memory = memory
        health.deleteHold = { [health] in
            health?.deleteHold = nil
            released = true
            for _ in 0..<300 where (memory.owed[first.syncId] ?? 0) <= first.version { try? await Task.sleep(for: .milliseconds(10)) }
        }

        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }

        let owed = try XCTUnwrap(memory.owed[first.syncId], "the newer version stays owed")
        XCTAssertGreaterThan(owed, first.version)
        await app.health.foreground()
        XCTAssertEqual(health.deletedSyncIds.last, [first.syncId])
        XCTAssertTrue(memory.owed.isEmpty)
    }

    /// Codex C-R2: an erase disconnects during a live refresh, then Connect asks for a forced
    /// one while it still runs. The old read lands nothing; the queued one, under the new
    /// ticket, runs exactly once and draws the cards.
    func testARefreshQueuedAfterAReconnectRunsOnce_US72_AC10_CR2() async throws {
        let (live, liveStore) = liveHealth()
        let app = try app(cloud: false, live: live)
        await app.health.connect()
        let measured = liveStore.latestCalls
        await live.refresh(force: true)
        let perRead = liveStore.latestCalls - measured
        XCTAssertGreaterThan(perRead, 0)

        liveStore.delay = .seconds(3)
        let start = liveStore.latestCalls
        let held = Task { await live.refresh(force: true) }
        await until("the read is under way") { liveStore.latestCalls > start }
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        XCTAssertTrue(live.cards.isEmpty)
        liveStore.delay = nil
        await app.health.connect()
        await held.value

        XCTAssertEqual(liveStore.latestCalls - start, 2 * perRead, "the held read, then the queued one, once")
        XCTAssertFalse(live.cards.isEmpty, "the queued refresh drew the cards")
    }

    // MARK: Codex round 3: an owed id is never written (Option S)

    /// No id is in both written and owed.
    private var disjoint: Bool {
        let memory = memory
        return memory.owed.keys.allSatisfy { memory.writtenVersion($0) == 0 }
    }

    /// The sync id's samples in Health, by version.
    private func savedVersions(_ syncId: String) -> [Int64] {
        health.saved.filter { $0.syncId == syncId }.map(\.version)
    }

    /// An erase from another device made on the record as it was before K was typed: it lists
    /// no row of ours, so K's row survives it (merge.ts, US-09 AC23) and keeps its sync id.
    private func remoteEraseSparingTheRow(_ app: App, to epoch: Int = 1) async throws {
        dropbox.put(erased(try webRecord(), to: epoch))
        await app.sync.syncNow()
    }

    /// Connected with K written; a remote erase that spares K's row, whose delete fails; then
    /// Connect, whose owed delete fails too. Returns K.
    private func reconnectedWithKOwed() async throws -> (App, String) {
        let (app, written) = try await connectedInTheCloud()
        let k = try XCTUnwrap(written.first)
        XCTAssertEqual(written, [k])
        health.deleteFails = true
        try await remoteEraseSparingTheRow(app)
        await until("the erase disconnects Apple Health") { !app.health.connected }
        await until("the erase's delete was tried") { health.deleteAttempts == 1 }
        await app.health.connect()
        return (app, k)
    }

    /// Codex round 3: a row that survives a remote erase keeps its sync id. Written again after
    /// Connect while its old sample's delete was still owed, the next owed retry would delete the
    /// new sample and leave it listed as written, so it was never exported again.
    func testASurvivingRowIsNeverDeletedByAnOwedRetryAfterReconnect_US72_AC10() async throws {
        let (app, k) = try await reconnectedWithKOwed()

        XCTAssertNotNil(app.store.myData?.vitals.first?.latest, "the row survived the erase")
        XCTAssertEqual(savedVersions(k), [1], "only the old sample, whose delete failed: K was not written again")
        XCTAssertEqual(memory.owed[k], 1)
        XCTAssertEqual(memory.writtenVersion(k), 0)
        XCTAssertTrue(disjoint, "the pass after Connect wrote no owed id")

        health.deleteFails = false
        await app.health.foreground()

        XCTAssertEqual(health.deletedSyncIds.last, [k])
        XCTAssertEqual(savedVersions(k), [1], "written again once, after its delete was paid")
        XCTAssertTrue(memory.owed.isEmpty)
        XCTAssertEqual(memory.writtenVersion(k), 1)
    }

    /// The same, with the row corrected while its delete is owed: the correction waits, and goes
    /// to Health at its own version once the delete is paid.
    func testACorrectionOfAnOwedRowIsWrittenOnlyOnceItsDeleteIsPaid_US72_AC10() async throws {
        let (app, k) = try await reconnectedWithKOwed()
        let rowId = try XCTUnwrap(app.store.myData?.vitals.first?.latest?.id)
        await XCTAssertSaved(await app.store.apply(.correct(id: rowId, value: 81)))
        await app.health.refresh()

        XCTAssertEqual(savedVersions(k), [1], "no new K while it is owed")
        XCTAssertEqual(memory.owed[k], 1)

        health.deleteFails = false
        await app.health.foreground()

        XCTAssertEqual(savedVersions(k), [2], "the correction alone, once the delete is paid")
        XCTAssertTrue(memory.owed.isEmpty)
    }

    /// A pass that runs while the owed delete is in flight (it took the samples but has not
    /// returned) writes no owed id; the refresh after the delete writes it once.
    func testAPassDuringAnOwedDeleteInFlightWritesNoOwedId_US72_AC10() async throws {
        let (app, k) = try await reconnectedWithKOwed()
        health.deleteFails = false
        var reached = false, released = false
        health.deleteHold = { [health] in
            health?.deleteHold = nil
            reached = true
            for _ in 0..<500 where !released { try? await Task.sleep(for: .milliseconds(10)) }
        }
        let foreground = Task { await app.health.foreground() }
        await until("the owed delete is in flight") { reached }

        await XCTAssertSaved(await app.store.apply(.add(metric: "waist", value: 90, day: "2026-10-01")))
        await app.health.refresh()
        XCTAssertEqual(savedVersions(k), [], "the pass wrote no owed id")
        XCTAssertNotNil(health.saved.first { $0.kind == .waist }, "the pass ran")

        released = true
        await foreground.value
        XCTAssertEqual(savedVersions(k), [1], "the refresh after the delete wrote K once")
        XCTAssertTrue(memory.owed.isEmpty)
    }

    /// Lead H32 (Codex, PR 1218 re-check): an unlock runs foreground() and the unlock handler
    /// together, and both find K owed. Before the one claim, each paid it: the first pay's refresh
    /// wrote K again, then the second pay's slow query deleted that new sample while written still
    /// listed K, so K never went to Health again. With the claim, the second awaits the first pay.
    func testAnUnlockOverlappingAForegroundPaysAnOwedIdOnce_US72_AC10_H32() async throws {
        let (app, k) = try await reconnectedWithKOwed()
        health.deleteFails = false
        let attempts = health.deleteAttempts
        var calls = 0, released = false
        health.deleteBegin = { [health] in
            calls += 1
            if calls == 1 {
                for _ in 0..<500 where !released { try? await Task.sleep(for: .milliseconds(10)) }
            } else {
                // A second pay's query reaches Health only after the first pay's refresh wrote K again.
                for _ in 0..<500 where health?.saved.contains(where: { $0.syncId == k }) != true {
                    try? await Task.sleep(for: .milliseconds(10))
                }
            }
        }
        let foreground = Task { await app.health.foreground() }
        await until("the first pay is in flight") { calls == 1 }
        NotificationCenter.default.post(name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        await settle()

        released = true
        await foreground.value
        await settle()

        XCTAssertEqual(health.deleteAttempts - attempts, 1, "one pay for both triggers")
        XCTAssertEqual(savedVersions(k), [1], "K stays in Health")
        XCTAssertTrue(memory.owed.isEmpty)
        XCTAssertEqual(memory.writtenVersion(k), 1)
    }

    private enum Step {
        case connect, write
        /// A remote erase sparing the rows; its delete fails or not.
        case erase(fails: Bool)
        /// The next foreground: the owed delete succeeds, or fails.
        case pay, failPay
    }

    /// Fable: no id is ever in both written and owed, after any step of any sequence of
    /// connect, write, erase, pay and failed pay.
    func testNoIdIsEverWrittenAndOwedAtOnce_US72_AC10() async throws {
        let sequences: [[Step]] = [
            [.erase(fails: true), .connect, .write, .failPay, .pay, .write],
            [.erase(fails: false), .connect, .write, .erase(fails: true), .failPay, .connect, .pay],
            [.write, .erase(fails: true), .write, .connect, .erase(fails: true), .connect, .write, .pay, .write],
            [.erase(fails: true), .connect, .erase(fails: true), .connect, .failPay, .write, .pay],
        ]
        for (index, sequence) in sequences.enumerated() {
            if index > 0 {
                try await tearDown()
                try await setUp()
            }
            let (app, _) = try await connectedInTheCloud()
            var epoch = 0, day = 1
            var lastSync = Date()
            XCTAssertTrue(disjoint, "sequence \(index), start")
            for (number, step) in sequence.enumerated() {
                switch step {
                case .connect:
                    await app.health.connect()
                case .write:
                    day += 1
                    await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: String(format: "2026-10-%02d", day))))
                    await app.health.refresh()
                case .erase(let fails):
                    health.deleteFails = fails
                    let wasConnected = app.health.connected
                    epoch += 1
                    // The session re-reads the cloud at most once per 5 s (record-session.ts:31, US-34).
                    if Date().timeIntervalSince(lastSync) < 5 { try? await Task.sleep(for: .seconds(5.1)) }
                    try await remoteEraseSparingTheRow(app, to: epoch)
                    lastSync = Date()
                    await until("sequence \(index) step \(number): the erase was read") { app.store.myData?.eraseEpoch == epoch }
                    if wasConnected { await until("sequence \(index) step \(number): disconnected") { !app.health.connected } }
                    await settle()
                case .pay:
                    health.deleteFails = false
                    await app.health.foreground()
                case .failPay:
                    health.deleteFails = true
                    await app.health.foreground()
                }
                await settle()
                XCTAssertTrue(disjoint, "sequence \(index), step \(number) (\(step)): an id is written and owed at once")
            }
        }
    }

    /// F6: an erase lands between a pass's last check and its save's turn in the store's line.
    /// The save is not made, nothing red is shown, and the next pass meets the erase.
    func testAnEraseTakingTheSavesTurnEndsInASilentRetry_US72_AC10_F6() async throws {
        let app = try app(cloud: false)
        await app.health.connect()
        health.pending[.weight] = [Self.morning]
        var reached = false, released = false, open = false
        health.hold = { [health] in
            health?.hold = nil
            reached = true
            for _ in 0..<500 where !released { try? await Task.sleep(for: .milliseconds(10)) }
        }
        let refresh = Task { await app.health.refresh() }
        await until("the import read its batch") { reached }
        // The store's line held, the erase queued in it, then the batch's save behind the erase.
        app.store.chain { for _ in 0..<500 where !open { try? await Task.sleep(for: .milliseconds(10)) } }
        let erase = Task { await app.eraser.eraseAll() }
        await settle()
        released = true
        await settle()
        open = true

        guard case .erased = await erase.value else { return XCTFail("the erase was refused") }
        await refresh.value

        XCTAssertTrue(rows(object(app.store.recordJSON), source: "apple_health").isEmpty, "the batch did not land")
        XCTAssertEqual(app.health.status, .notConnected, "no failure shown: the next pass met the erase")
    }

    // MARK: Leads H29, H33, H34 (PR 1218 follow-ups)
    // HealthKit authorization is not modelled by the simulator: FakeHealthStore's `writable`
    // stands in for it, and its deleteSamples mirrors HealthKitClient's.

    /// Lead H29: waist write access off, and the weight sample the app wrote deleted in Health by
    /// the person. Health finds no sample for the weight's id under a kind it could write: the id
    /// is paid, not owed, and the erase does not say Health kept samples.
    func testAWritableKindsIdHealthDidNotFindIsPaid_US72_AC10_H29() async throws {
        let app = try app(cloud: false)
        await app.health.connect()
        health.writable.remove(.waist)
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        await app.health.refresh()
        let weight = try XCTUnwrap(health.saved.first?.syncId)
        health.saved.removeAll()

        guard case .erased(let words) = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }

        XCTAssertEqual(health.deletedSyncIds.last, [weight], "the delete asked for it")
        XCTAssertTrue(memory.owed.isEmpty, "not found under a writable kind: paid")
        XCTAssertFalse(words.hasSuffix(EraseText.healthNotErased), words)
    }

    /// Lead H29, re-export: the same id, its row spared by a remote erase, is paid, so Connect
    /// writes it to Health again (Option S skips an owed id for as long as it stays owed).
    func testAPaidIdNotFoundIsExportedAgain_US72_AC10_H29() async throws {
        let (app, written) = try await connectedInTheCloud()
        let k = try XCTUnwrap(written.first)
        health.writable.remove(.waist)
        health.saved.removeAll()
        try await remoteEraseSparingTheRow(app)
        await until("the erase disconnects Apple Health") { !app.health.connected }
        await until("the erase's delete was tried") { health.deleteAttempts == 1 }
        await settle()
        XCTAssertTrue(memory.owed.isEmpty, "not found under a writable kind: paid")

        await app.health.connect()

        XCTAssertNotNil(app.store.myData?.vitals.first?.latest, "the row survived the erase")
        XCTAssertEqual(savedVersions(k), [1], "written to Health again")
        XCTAssertEqual(memory.writtenVersion(k), 1)
    }

    /// Lead H29, the other side: an id of a kind whose write access is off stays owed (its sample
    /// is still in Health). Once the kind is writable again, it is deleted, then written again.
    func testAnUnwritableKindsIdStaysOwedUntilWritableThenIsExportedAgain_US72_AC10_H29() async throws {
        let (app, _) = try await connectedInTheCloud()
        await XCTAssertSaved(await app.store.apply(.add(metric: "waist", value: 90, day: "2026-10-01")))
        await app.health.refresh()
        let waist = try XCTUnwrap(health.saved.first { $0.kind == .waist }?.syncId)
        health.writable.remove(.waist)
        try await remoteEraseSparingTheRow(app)
        await until("the erase disconnects Apple Health") { !app.health.connected }
        await until("the erase's delete was tried") { health.deleteAttempts == 1 }
        await settle()
        XCTAssertEqual(memory.owed.keys.sorted(), [waist], "its sample is still in Health")
        XCTAssertEqual(health.saved.map(\.syncId), [waist])

        await app.health.connect()
        XCTAssertEqual(memory.owed.keys.sorted(), [waist], "still unwritable at Connect")
        health.writable.insert(.waist)
        await app.health.foreground()

        XCTAssertTrue(memory.owed.isEmpty)
        XCTAssertEqual(savedVersions(waist), [1], "deleted, then written again")
        XCTAssertEqual(memory.writtenVersion(waist), 1)
    }

    /// PR 1256 review R1: waist write access is turned off while the delete runs (after weight's
    /// query began). Health never asked about waist, so the waist id stays owed: write access read
    /// before the delete must not count it as paid.
    func testAKindRevokedDuringTheDeleteKeepsItsIdOwed_US72_AC10_H29() async throws {
        let app = try app(cloud: false)
        await app.health.connect()
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        await XCTAssertSaved(await app.store.apply(.add(metric: "waist", value: 90, day: "2026-10-01")))
        await app.health.refresh()
        let waist = try XCTUnwrap(health.saved.first { $0.kind == .waist }?.syncId)
        health.deleteBegin = { [health] in
            health?.deleteBegin = nil
            health?.writable.remove(.waist)
        }

        guard case .erased(let words) = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }

        XCTAssertEqual(memory.owed.keys.sorted(), [waist], "its sample is still in Health")
        XCTAssertEqual(health.saved.map(\.syncId), [waist])
        XCTAssertTrue(words.hasSuffix(EraseText.healthNotErased), words)
    }

    /// PR 1256 review R2: an exported row stops being listed for Health (another device flipped
    /// it to entered-in-error) before the erase. Its kind is kept while it is written, so with
    /// waist blocked and its sample deleted in Health by the person, the erase pays it.
    func testAWrittenIdNoLongerListedKeepsItsKind_US72_AC10_H29() async throws {
        let (app, written) = try await connectedInTheCloud()
        let k = try XCTUnwrap(written.first)
        var record = dropbox.record
        var meta = record["meta"] as? [String: Any] ?? [:]
        meta["lamport"] = ((meta["lamport"] as? Int) ?? 0) + 10
        meta["updatedAt"] = Date().formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        record["meta"] = meta
        record["measurements"] = (record["measurements"] as? [[String: Any]] ?? []).map { row in
            var row = row
            if row["metricType"] as? String == "weight" { row["status"] = "entered-in-error" }
            return row
        }
        // The session re-reads the cloud at most once per 5 s (record-session.ts:31, US-34).
        try? await Task.sleep(for: .seconds(5.1))
        dropbox.put(record)
        await app.sync.syncNow()
        await until("the row is no longer active") { app.store.myData?.vitals.first?.latest == nil }
        await app.health.refresh()
        XCTAssertEqual(memory.writtenVersion(k), 1, "still listed as written")
        XCTAssertEqual(memory.kind(k), .weight, "and its kind kept")

        health.writable.remove(.waist)
        health.saved.removeAll()
        guard case .erased(let words) = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }

        XCTAssertTrue(memory.owed.isEmpty, "not found under a kind Health was asked about: paid")
        XCTAssertFalse(words.hasSuffix(EraseText.healthNotErased), words)
    }

    /// PR 1256 review R3: an owed id whose kind is not known (written before kinds were kept),
    /// not found while one kind is unwritable, may be that kind's: it stays owed.
    func testAnOwedIdOfUnknownKindStaysOwedWhileAKindIsBlocked_US72_AC10_H29() async throws {
        let app = try app(cloud: false)
        health.writable.remove(.waist)
        memory.owe(1, for: "written-by-build-10")
        XCTAssertNil(memory.kind("written-by-build-10"))

        await app.health.connect()

        XCTAssertEqual(health.deletedSyncIds.last, ["written-by-build-10"], "Connect tried the owed delete")
        XCTAssertEqual(memory.owed, ["written-by-build-10": 1], "it may be a waist sample still in Health")
    }

    /// Lead H33: K's owed delete is in flight (its snapshot holds K alone) when a remote erase
    /// owes L. The erase waits that pay out, then pays L itself, with no other trigger.
    func testARemoteEraseDuringAPayInFlightPaysWhatItOwed_US72_AC10_H33() async throws {
        let (app, k) = try await reconnectedWithKOwed()
        await XCTAssertSaved(await app.store.apply(.add(metric: "waist", value: 90, day: "2026-10-01")))
        await app.health.refresh()
        let l = try XCTUnwrap(health.saved.first { $0.kind == .waist }?.syncId)
        XCTAssertEqual(memory.writtenVersion(l), 1)
        health.deleteFails = false
        var held = false, released = false
        health.deleteBegin = { [health] in
            health?.deleteBegin = nil
            held = true
            for _ in 0..<1500 where !released { try? await Task.sleep(for: .milliseconds(10)) }
        }
        let foreground = Task { await app.health.foreground() }
        await until("K's delete is in flight") { held }
        // The session re-reads the cloud at most once per 5 s (record-session.ts:31, US-34).
        try? await Task.sleep(for: .seconds(5.1))
        try await remoteEraseSparingTheRow(app, to: 2)
        await until("the erase owes L") { memory.owed[l] != nil }

        released = true
        await foreground.value
        await until("L is paid with no other trigger") { memory.owed.isEmpty }

        XCTAssertEqual(Array(health.deletedSyncIds.suffix(2)), [[k], [l]], "K's pay, then the erase's own")
        XCTAssertTrue(savedVersions(l).isEmpty, "L's sample left Health")
    }

    /// Lead H34: a correction of a written id hangs in HealthKit. A local erase drains once: the
    /// Health delete begins within one `drainBound`, not two.
    func testALocalEraseBeginsTheHealthDeleteWithinOneDrain_US72_AC10_H34() async throws {
        let app = try app(cloud: false)
        await app.health.connect()
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        await app.health.refresh()
        XCTAssertEqual(health.saved.count, 1)
        var reached = false, released = false
        health.saveHold = { [health] in
            health?.saveHold = nil
            reached = true
            for _ in 0..<1000 where !released { try? await Task.sleep(for: .milliseconds(10)) }
        }
        let rowId = try XCTUnwrap(app.store.myData?.vitals.first?.latest?.id)
        await XCTAssertSaved(await app.store.apply(.correct(id: rowId, value: 81)))
        await until("the correction is in HealthKit") { reached }
        var began: ContinuousClock.Instant?
        health.deleteBegin = { [health] in
            health?.deleteBegin = nil
            began = .now
        }

        let start = ContinuousClock.now
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }

        let delay = try XCTUnwrap(began, "the owed delete ran") - start
        XCTAssertLessThan(delay, AppleHealthSync.drainBound + .seconds(1), "one drain, not two")
        released = true
        await settle()
    }
}
