import UIKit
import XCTest
@testable import HealthRoadmap

/// US-72 AC10 (Brad's yes, 2026-11-11; ios/architecture.md D6): "Delete all my data"
/// disconnects Apple Health on this iPhone and resets every import anchor, vitals and lab
/// results alike. While disconnected nothing is read. An erase taken in from another device,
/// newer than the last one this phone saw on the same record source, disconnects the same
/// way; a first open or a new source adopts the record's erase and never disconnects. Connect,
/// the person's own act, reads everything from the start. A batch read before an erase never
/// lands after it. HealthKit is faked (FakeHealthStore); Dropbox is CloudSyncTests' stub.
@MainActor
final class AppleHealthEraseTests: XCTestCase {
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!
    private var health: FakeHealthStore!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Apple Health Erase \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
        health = FakeHealthStore()
        suite = "AppleHealthEraseTests-\(UUID().uuidString)"
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

    /// The app's parts as AppParts makes them; `cloud`: Dropbox is connected (not yet opened).
    private func app(cloud: Bool, live: LiveHealth? = nil) throws -> App {
        if cloud { try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider")) }
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: "ios-test")
        let appleHealth = AppleHealthSync(store: store, engine: engine, client: health, memory: memory, live: live) { await sync.syncNow() }
        let eraser = DataEraser(store: store, sync: sync, chat: chat, reminders: nil, health: appleHealth, live: live)
        return App(store: store, sync: sync, eraser: eraser, health: appleHealth)
    }

    /// Measured 2026-10-15, before any erase these tests make.
    private static let morning = HealthSample(
        id: UUID(uuidString: "00000000-0000-0000-0000-0000000000a1")!, metric: "weight", value: 80,
        at: Date(timeIntervalSince1970: 1_792_000_000), timeZone: TimeZone(identifier: "Pacific/Auckland")!)

    private static func waist() -> HealthSample {
        HealthSample(id: UUID(), metric: "waist", value: 90, at: Date(timeIntervalSince1970: 1_792_000_000), timeZone: .gmt)
    }

    private static func bloodPressure() -> [HealthSample] {
        let pair = UUID(), at = Date(timeIntervalSince1970: 1_792_000_000)
        return [HealthSample(id: UUID(), metric: "systolic_bp", value: 130, at: at, pairId: pair),
                HealthSample(id: UUID(), metric: "diastolic_bp", value: 85, at: at, pairId: pair)]
    }

    /// An R4 HbA1c drawn 2026-10-01, before any erase these tests make.
    private static func hba1c() -> HealthRecord {
        let json = """
        {"resourceType":"Observation","id":"obs-erase","meta":{"versionId":"1"},"status":"final",\
        "code":{"coding":[{"system":"http://loinc.org","code":"4548-4","display":"Hemoglobin A1c"}]},\
        "effectiveDateTime":"2026-10-01T09:00:00Z",\
        "valueQuantity":{"value":5.6,"unit":"%","system":"http://unitsofmeasure.org","code":"%"}}
        """
        return HealthRecord(sourceId: "com.apple.health.clinical.test|Test Hospital", resourceType: "Observation", fhirVersion: "4.0.1", json: json)
    }

    private func object(_ json: String) -> [String: Any] {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any]) ?? [:]
    }

    private func rows(_ record: [String: Any], source: String) -> [[String: Any]] {
        let all = (record["measurements"] as? [[String: Any]] ?? []) + (record["labValues"] as? [[String: Any]] ?? [])
        return all.filter { $0["source"] as? String == source && $0["status"] as? String == "active" }
    }

    private func epoch(_ record: [String: Any]) -> Int? {
        (record["meta"] as? [String: Any])?["eraseEpoch"] as? Int
    }

    /// An empty record from the web, as the cloud holds it, at `epoch` (erased an hour ago when above 0).
    private func webRecord(epoch: Int = 0) throws -> [String: Any] {
        let json = try HealthEngine().blocking { try $0.newRecord(now: .now, deviceId: "web", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        let record = object(json)
        return epoch == 0 ? record : erased(record, to: epoch)
    }

    /// Another device's erase of `record`: a higher epoch, its time, a later clock, and the rows
    /// it erased listed, as a real erase lists every row it read (US-09 AC23).
    private func erased(_ record: [String: Any], to epoch: Int, at: Date = Date().addingTimeInterval(-3600)) -> [String: Any] {
        var copy = record
        var meta = record["meta"] as? [String: Any] ?? [:]
        let stamp = at.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
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

    private func instant(_ stamp: String) throws -> Date {
        let fractional = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
        if let date = try? fractional.parse(stamp) { return date }
        return try Date.ISO8601FormatStyle().parse(stamp)
    }

    private func signIn() -> OAuthClient.Authenticate {
        { url, _ in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "db-xf96vqvjotm5xhx://2/token?code=c&state=\(state)")!
        }
    }

    /// Waits up to about 3 s for what the app does after a record is drawn (its observation runs in a Task).
    private func until(_ what: String, _ condition: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async {
        for _ in 0..<300 where !condition() { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertTrue(condition(), what, file: file, line: line)
    }

    /// Lets any Task the app started run, for a "nothing happens" check.
    private func settle() async {
        try? await Task.sleep(for: .milliseconds(300))
    }

    private func assertDisconnected(_ sync: AppleHealthSync, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(sync.connected, "Apple Health is disconnected", file: file, line: line)
        XCTAssertEqual(sync.status, .notConnected, file: file, line: line)
        XCTAssertFalse(memory.connected, "and remembered as disconnected across launches", file: file, line: line)
        for kind in HealthKind.allCases {
            XCTAssertNil(memory.anchor(for: kind), "\(kind) anchor reset", file: file, line: line)
        }
        XCTAssertNil(memory.labResultsAnchor, "lab results anchor reset", file: file, line: line)
        XCTAssertEqual(health.stops, 1, "observers and background delivery stopped once", file: file, line: line)
        XCTAssertTrue(health.observed.isEmpty, file: file, line: line)
    }

    // MARK: The gate (one pure function, one stored value)

    /// The gate's table: (connection, the record's erase, the record's source) against the erase
    /// this phone saw last. A first open or a new source adopts; a newer erase on the same source
    /// disconnects a connected phone; anything else keeps.
    func testTheEraseGateTable_US72_AC10() {
        let dropbox1 = EraseSeen(epoch: 1, source: "dropbox")
        let rows: [(connected: Bool, seen: EraseSeen?, epoch: Int, source: String, want: EraseGate, why: String)] = [
            (true, nil, 3, "dropbox", .adopt, "first open of a record with an old erase: adopt, never disconnect (c4-1)"),
            (false, nil, 0, "phone", .adopt, "first open, not connected: adopt"),
            (true, dropbox1, 1, "dropbox", .keep, "the same erase: keep"),
            (true, dropbox1, 2, "dropbox", .disconnect, "a newer erase on the same source: disconnect"),
            (false, dropbox1, 2, "dropbox", .adopt, "a newer erase while not connected: nothing to disconnect, adopt"),
            (true, EraseSeen(epoch: 0, source: "phone"), 2, "dropbox", .adopt, "a newly connected cloud with an erase: adopt"),
            (true, dropbox1, 4, "googleDrive", .adopt, "another cloud: adopt"),
            (true, EraseSeen(epoch: 2, source: "dropbox"), 1, "dropbox", .keep, "an older erase than seen: keep"),
            (true, EraseSeen(epoch: 0, source: "phone"), 1, "phone", .disconnect, "the phone's own erase drawn: disconnect"),
        ]
        for row in rows {
            XCTAssertEqual(EraseGate.decide(connected: row.connected, seen: row.seen, recordErase: row.epoch, recordSource: row.source), row.want, row.why)
        }
    }

    /// The erase seen and its source are one stored value, written in one step.
    func testTheEraseSeenAndItsSourceAreOneStoredValue_US72_AC10() {
        XCTAssertNil(memory.eraseSeen)
        memory.eraseSeen = EraseSeen(epoch: 2, source: "dropbox")
        XCTAssertEqual(HealthSyncMemory(defaults: defaults).eraseSeen, EraseSeen(epoch: 2, source: "dropbox"))
        let keys = defaults.dictionaryRepresentation().keys.filter { $0.lowercased().contains("eraseseen") }
        XCTAssertEqual(keys.count, 1, "one key holds both: \(keys)")
    }

    // MARK: A local erase

    func testTheEraseDisconnectsAppleHealthAndResetsEveryAnchor_US72_AC10() async throws {
        let app = try app(cloud: false)
        health.supportsHealthRecords = true
        health.pending[.weight] = [Self.morning]
        health.pending[.waist] = [Self.waist()]
        health.pending[.bloodPressure] = Self.bloodPressure()
        health.pendingRecords = [Self.hba1c()]
        await app.health.connect()
        XCTAssertNotNil(memory.anchor(for: .weight))
        XCTAssertNotNil(memory.anchor(for: .bloodPressure))
        XCTAssertNotNil(memory.labResultsAnchor)
        let asked = try XCTUnwrap(memory.labResultsAsked)

        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }

        assertDisconnected(app.health)
        XCTAssertEqual(memory.labResultsAsked, asked, "labResultsAsked stays: no repeat prompt")
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 1, source: "phone"), "the phone's own erase is seen")
        XCTAssertEqual(epoch(object(app.store.recordJSON)), 1)
    }

    func testAfterAnEraseNoWakeUnlockOrForegroundImports_US72_AC10() async throws {
        let app = try app(cloud: false)
        health.supportsHealthRecords = true
        health.pending[.weight] = [Self.morning]
        await app.health.connect()
        let staleDelivery = try XCTUnwrap(health.onChange, "a background delivery handler HealthKit may still call")
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        let readsAfterErase = health.reads
        let asksAfterErase = health.labRequests + health.requests

        health.pending[.weight] = [HealthSample(id: UUID(), metric: "weight", value: 79, at: Date().addingTimeInterval(-60))]
        health.pendingRecords = [Self.hba1c()]
        await staleDelivery()
        NotificationCenter.default.post(name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        await app.health.foreground()
        await app.health.refresh()
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 78, day: "2026-11-01")))
        await settle()

        XCTAssertEqual(health.reads, readsAfterErase, "no wake, unlock, foreground or record change read Health")
        XCTAssertEqual(health.labRequests + health.requests, asksAfterErase, "no sheet")
        XCTAssertTrue(health.saved.isEmpty, "the typed value is not written to Health")
        XCTAssertTrue(rows(object(app.store.recordJSON), source: "apple_health").isEmpty)
        XCTAssertTrue(rows(object(app.store.recordJSON), source: "health_records").isEmpty)
        XCTAssertEqual(app.health.status, .notConnected)
    }

    func testARulesBumpWhileDisconnectedReadsNothing_US72_AC10() async throws {
        let app = try app(cloud: false)
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        await app.health.connect()
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        let reads = health.recordReads
        // A build with a newer lab results rules version starts while disconnected.
        memory.labResultsRules = HealthSyncMemory.labResultsRulesVersion - 1
        health.pendingRecords = [Self.hba1c()]

        await app.health.foreground()
        await app.health.refresh()
        await settle()

        XCTAssertEqual(health.recordReads, reads, "a rules bump reads nothing while disconnected")
        XCTAssertNil(memory.labResultsAnchor)
        XCTAssertTrue(rows(object(app.store.recordJSON), source: "health_records").isEmpty)
    }

    /// The order pin's first half: a batch read before the erase, saved after it, is refused in
    /// its turn (the mark taken at the read no longer holds); its anchors never move.
    func testABatchReadBeforeAnEraseNeverLandsAfterIt_US72_AC10() async throws {
        let app = try app(cloud: false)
        await app.health.connect()
        var reached = false, released = false
        health.pending[.weight] = [Self.morning]
        health.hold = { [health] in
            health?.hold = nil
            reached = true
            for _ in 0..<300 where !released { try? await Task.sleep(for: .milliseconds(10)) }
        }
        let refresh = Task { await app.health.refresh() }
        await until("the import read its batch") { reached }
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        released = true
        await refresh.value

        XCTAssertTrue(rows(object(app.store.recordJSON), source: "apple_health").isEmpty, "the pre-erase batch did not land")
        assertDisconnected(app.health)

        // The store's neutral mark (renamed from ChatMark; chat and health both use it): taken
        // before the erase, it refuses in-turn after it.
        let before: RecordStore.Mark = app.store.mark
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the second erase was refused") }
        let late = await app.store.applyNow(.add(metric: "weight", value: 81, day: "2026-10-02"), on: before)
        XCTAssertNil(late, "an edit marked before the erase was not saved after it, and says nothing (F6)")
        let now = await app.store.applyNow(.add(metric: "weight", value: 81, day: "2026-10-02"), on: app.store.mark)
        XCTAssertEqual(now, .saved(), "a mark taken now holds")
    }

    /// The order pin's second half: the erase lands first, then the disconnect. A failed erase
    /// leaves Apple Health connected, observing, with its anchors where they were.
    func testAFailedEraseLeavesAppleHealthConnected_US72_AC10() async throws {
        dropbox.put(try webRecord())
        let app = try app(cloud: true)
        await app.sync.start()
        health.pending[.weight] = [Self.morning]
        await app.health.connect()
        let anchor = try XCTUnwrap(memory.anchor(for: .weight))
        dropbox.online = false

        guard case .refused = await app.eraser.eraseAll() else { return XCTFail("an unreachable cloud refuses the erase") }

        XCTAssertTrue(app.health.connected)
        XCTAssertTrue(memory.connected)
        XCTAssertEqual(memory.anchor(for: .weight), anchor, "anchors unmoved")
        XCTAssertEqual(health.stops, 0, "still observing")
        XCTAssertEqual(health.observed, HealthKind.allCases)
    }

    // MARK: Connect after an erase

    /// Connect reads everything from the start, and the rows it imports (created after the erase)
    /// survive the merge with another device's copy of the erased record.
    func testConnectAfterAnEraseReadsEverythingFromTheStart_US72_AC10() async throws {
        dropbox.put(try webRecord())
        let app = try app(cloud: true)
        await app.sync.start()
        health.supportsHealthRecords = true
        health.pending[.weight] = [Self.morning]
        health.pendingRecords = [Self.hba1c()]
        await app.health.connect()
        await app.sync.background()
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        let erasedAt = try XCTUnwrap((dropbox.record["meta"] as? [String: Any])?["erasedAt"] as? String)

        // Health still holds the same readings, measured before the erase.
        health.pending[.weight] = [Self.morning]
        health.pendingRecords = [Self.hba1c()]
        let readsBefore = health.sampleAnchors.mapValues(\.count), recordReadsBefore = health.recordAnchors.count
        await app.health.connect()

        for kind in HealthKind.allCases {
            let after = health.sampleAnchors[kind] ?? []
            let first = readsBefore[kind] ?? 0
            XCTAssertGreaterThan(after.count, first, "\(kind) read on Connect")
            if after.count > first { XCTAssertNil(after[first], "\(kind) read from the start") }
        }
        XCTAssertGreaterThan(health.recordAnchors.count, recordReadsBefore)
        if health.recordAnchors.count > recordReadsBefore { XCTAssertNil(health.recordAnchors[recordReadsBefore], "lab results read from the start") }
        XCTAssertEqual(rows(object(app.store.recordJSON), source: "apple_health").count, 1, "no erase rule filters the reading")
        XCTAssertEqual(rows(object(app.store.recordJSON), source: "health_records").count, 1, "nor the lab result")

        // Another device writes the erased record (the same erase, a later clock) before ours goes up.
        var otherCopy = dropbox.record
        var otherMeta = otherCopy["meta"] as? [String: Any] ?? [:]
        otherMeta["lamport"] = ((otherMeta["lamport"] as? Int) ?? 0) + 10
        otherMeta["updatedAt"] = Date().formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        otherCopy["meta"] = otherMeta
        dropbox.beforeNextUpload = { [dropbox] in dropbox!.put(otherCopy) }
        await app.sync.background()

        let cloud = dropbox.record
        let landed = rows(cloud, source: "apple_health") + rows(cloud, source: "health_records")
        XCTAssertEqual(landed.count, 2, "the Connect's rows survive the merge")
        for row in landed {
            let created = try XCTUnwrap(row["createdAt"] as? String)
            XCTAssertGreaterThan(try instant(created), try instant(erasedAt), "createdAt after erasedAt")
        }
    }

    /// Reconnecting reads lab results from the start when access was granted, with no repeat prompt;
    /// when it never was (iOS answers a refusal with nothing), it reads nothing and asks nothing.
    func testReconnectAfterAnEraseReadsLabResultsWhenGrantedAndNothingWithoutARepeatPrompt_US72_AC10() async throws {
        let app = try app(cloud: false)
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        await app.health.connect()
        XCTAssertNotNil(memory.labResultsAsked)
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }

        health.pendingRecords = [Self.hba1c()]
        let readsBefore = health.recordAnchors.count
        await app.health.connect()
        await app.health.foreground()
        XCTAssertGreaterThan(health.recordAnchors.count, readsBefore)
        if health.recordAnchors.count > readsBefore { XCTAssertNil(health.recordAnchors[readsBefore], "read from the start") }
        XCTAssertEqual(rows(object(app.store.recordJSON), source: "health_records").count, 1, "granted: read from the start")
        XCTAssertEqual(health.labRequests, 0, "no lab results sheet of its own")

        // Never granted: a second erase, then a Connect where Health hands over nothing.
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the second erase was refused") }
        await app.health.connect()
        await app.health.foreground()
        XCTAssertNil(memory.labResultsAnchor, "a refused read keeps no anchor")
        XCTAssertTrue(rows(object(app.store.recordJSON), source: "health_records").isEmpty)
        XCTAssertEqual(health.labRequests, 0, "and no repeat prompt")
        XCTAssertNotNil(memory.labResultsAsked, "labResultsAsked stays")
    }

    func testAReconnectInTheSameLaunchObservesAgain_US72_AC10() async throws {
        let app = try app(cloud: false)
        await app.health.connect()
        XCTAssertEqual(health.observeCalls, 1)
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        XCTAssertTrue(health.observed.isEmpty)

        await app.health.connect()
        XCTAssertEqual(health.observeCalls, 2, "the reconnect observes again")
        XCTAssertEqual(health.observed, HealthKind.allCases)
        health.pending[.weight] = [Self.morning]
        await health.onChange?()
        XCTAssertEqual(rows(object(app.store.recordJSON), source: "apple_health").count, 1, "a delivery after the reconnect imports")

        // One unlock observer and one record watcher, not one per connect: an unlock refreshes once.
        await settle()
        let reads = health.reads
        NotificationCenter.default.post(name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        await settle()
        XCTAssertEqual(health.reads - reads, HealthKind.allCases.count, "one refresh per unlock")
    }

    // MARK: An erase from another device

    func testAnEraseFromAnotherDeviceDisconnectsAppleHealth_US72_AC10() async throws {
        dropbox.put(try webRecord())
        let app = try app(cloud: true)
        await app.sync.start()
        health.pending[.weight] = [Self.morning]
        await app.health.connect()
        await app.sync.background()
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 0, source: "dropbox"))

        dropbox.put(erased(dropbox.record, to: 1))
        await app.sync.syncNow()
        await until("the remote erase disconnects Apple Health") { !app.health.connected }

        assertDisconnected(app.health)
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 1, source: "dropbox"))
        health.pending[.weight] = [HealthSample(id: UUID(), metric: "weight", value: 79, at: Date().addingTimeInterval(-60))]
        await app.health.refresh()
        XCTAssertTrue(rows(object(app.store.recordJSON), source: "apple_health").isEmpty, "nothing read while disconnected")
    }

    func testFirstOpenOfARecordWithAnOldEraseKeepsAFreshConnect_US72_AC10() async throws {
        dropbox.put(try webRecord(epoch: 3))
        let app = try app(cloud: true)
        // A fresh install: Health connected on the phone's file before the cloud record opens.
        health.pending[.weight] = [Self.morning]
        await app.health.connect()
        XCTAssertNotNil(memory.anchor(for: .weight))

        await app.sync.start()
        XCTAssertNotNil(app.store.cloudErase, "the cloud record is open")
        await settle()

        XCTAssertTrue(app.health.connected, "a first open adopts the erase and never disconnects")
        XCTAssertEqual(health.stops, 0)
        // A refresh after the open moves the anchor on, never back to the start.
        XCTAssertNotNil(memory.anchor(for: .weight))
        XCTAssertFalse(health.sampleAnchors[.weight, default: []].dropFirst().contains(nil), "anchors kept: no read from the start")
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 3, source: "dropbox"))
        // The fresh Connect's row went up and survives the merge with the old erase (createdAt after erasedAt).
        await app.sync.background()
        XCTAssertEqual(rows(dropbox.record, source: "apple_health").count, 1)
    }

    func testConnectingANewCloudWithAnEraseDoesNotDisconnect_US72_AC10() async throws {
        let app = try app(cloud: false)
        health.pending[.weight] = [Self.morning]
        await app.health.connect()
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 0, source: "phone"))
        dropbox.put(try webRecord(epoch: 2))

        try await app.sync.connect(.dropbox, authenticate: signIn())
        XCTAssertNotNil(app.store.cloudErase, "the cloud record is open")
        await settle()

        XCTAssertTrue(app.health.connected, "a new source adopts its erase")
        XCTAssertEqual(health.stops, 0)
        XCTAssertNotNil(memory.anchor(for: .weight))
        XCTAssertEqual(memory.eraseSeen, EraseSeen(epoch: 2, source: "dropbox:dbid:A"), "the provider and the account signed in (F5)")
    }

    // MARK: Live cards (US-56)

    func testLiveCardsReadNothingWhileDisconnected_US72_AC10() async throws {
        let liveStore = FakeLiveStore(due: false)
        liveStore.fill(now: .now)
        let live = LiveHealth(store: liveStore, calendar: Calendar(identifier: .gregorian))
        let app = try app(cloud: false, live: live)
        await app.health.connect()
        XCTAssertFalse(live.cards.isEmpty)
        guard case .erased = await app.eraser.eraseAll() else { return XCTFail("the erase was refused") }
        let reads = liveStore.reads

        live.wake()
        await live.refresh()
        await live.refresh(force: true)
        await settle()

        XCTAssertEqual(liveStore.reads, reads, "no card read while disconnected")
        XCTAssertTrue(live.cards.isEmpty)
    }

    // MARK: k2 (Brad 2026-11-11: "limited strictly to readings our app wrote")

    /// A remote-erase disconnect also deletes the samples this app wrote, only those its
    /// written-versions memory lists (`forgetWritten`), never a query by source.
    func testARemoteEraseDeletesOnlyTheSamplesThisAppWrote_US72_AC10_k2() async throws {
        dropbox.put(try webRecord())
        let app = try app(cloud: true)
        await app.sync.start()
        await app.health.connect()
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        await app.health.refresh()
        let written = health.saved.map(\.syncId).sorted()
        XCTAssertFalse(written.isEmpty)
        await app.sync.background()

        dropbox.put(erased(dropbox.record, to: 1))
        await app.sync.syncNow()
        await until("the remote erase disconnects Apple Health") { !app.health.connected }
        await until("the written samples are deleted") { !health.deletedSyncIds.isEmpty }

        XCTAssertEqual(health.deletedSyncIds, [written], "exactly the sync ids the memory listed")
        XCTAssertEqual(health.ownDeletes, 0, "never a delete by source")
        XCTAssertNil(defaults.dictionary(forKey: "appleHealth.written"), "and forgotten")
    }

    /// k2: a sample in Health the app did not write (no sync id in its memory) survives a remote erase.
    func testARemoteEraseLeavesASampleTheAppDidNotWrite_US72_AC10_k2() async throws {
        dropbox.put(try webRecord())
        let app = try app(cloud: true)
        await app.sync.start()
        await app.health.connect()
        await XCTAssertSaved(await app.store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        await app.health.refresh()
        let written = health.saved.map(\.syncId).sorted()
        XCTAssertFalse(written.isEmpty)
        let theirs = HealthWrite(syncId: "another-app-sample", version: 1, day: "2026-10-02", values: ["weight": 79])
        health.saved.append(theirs)
        await app.sync.background()

        dropbox.put(erased(dropbox.record, to: 1))
        await app.sync.syncNow()
        await until("the remote erase disconnects Apple Health") { !app.health.connected }
        await until("the written samples are deleted") { !health.deletedSyncIds.isEmpty }

        XCTAssertEqual(health.deletedSyncIds, [written], "only the app's own sync ids are asked for")
        XCTAssertEqual(health.saved, [theirs], "the sample the app did not write stays in Health")
    }
}
