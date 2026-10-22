import XCTest
@testable import HealthRoadmap

/// US-25 AC13–AC15 (ios/architecture.md D6): Apple Health readings land in the
/// record through the engine, the anchor moves only after the record is on
/// disk, typed values go back to Health once per version, and a locked phone
/// waits instead of failing. HealthKit itself is faked (`FakeHealthStore`).
@MainActor
final class AppleHealthSyncTests: XCTestCase {
    private var folder: URL!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Apple Health \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        suite = "AppleHealthSyncTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        defaults.removePersistentDomain(forName: suite)
    }

    private func parts() throws -> (RecordStore, HealthEngine) {
        let engine = try HealthEngine()
        return (try RecordStore(folder: folder, engine: engine, deviceId: "test"), engine)
    }

    private func sync(_ store: RecordStore, _ engine: HealthEngine, _ health: FakeHealthStore) -> AppleHealthSync {
        AppleHealthSync(store: store, engine: engine, client: health, memory: HealthSyncMemory(defaults: defaults))
    }

    private static let morning = HealthSample(
        id: UUID(uuidString: "00000000-0000-0000-0000-000000000001")!, metric: "weight", value: 80,
        at: Date(timeIntervalSince1970: 1_792_000_000), timeZone: TimeZone(identifier: "Pacific/Auckland")!)

    private func activeRows(_ store: RecordStore) throws -> [[String: Any]] {
        let record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(store.recordJSON.utf8)) as? [String: Any])
        return (record["measurements"] as? [[String: Any]] ?? []).filter { $0["status"] as? String == "active" }
    }

    func testConnectingImportsReadingsAsAppleHealthRows() async throws {
        let (store, engine) = try parts()
        let health = FakeHealthStore()
        health.pending[.weight] = [Self.morning]
        let sync = sync(store, engine, health)

        await sync.connect()

        XCTAssertTrue(health.authorized)
        let rows = try activeRows(store)
        XCTAssertEqual(rows.count, 1)
        XCTAssertEqual(rows.first?["source"] as? String, "apple_health")
        XCTAssertEqual(rows.first?["externalId"] as? String, "00000000-0000-0000-0000-000000000001")
        XCTAssertEqual(store.myData?.vitals.first?.latest?.value, "80.0")
        // On disk, not only on screen.
        XCTAssertEqual(try String(contentsOf: folder.appending(path: "health-roadmap.json"), encoding: .utf8), store.recordJSON)
        guard case .upToDate = sync.status else { return XCTFail("status \(sync.status)") }
    }

    func testTheAnchorMovesOnlyAfterTheRecordIsSaved() async throws {
        let (store, engine) = try parts()
        let health = FakeHealthStore()
        health.pending[.weight] = [Self.morning]
        let memory = HealthSyncMemory(defaults: defaults)
        await sync(store, engine, health).connect()
        XCTAssertEqual(memory.anchor(for: .weight), health.anchorData(.weight))

        // A record the app cannot read refuses every write: the anchor must stay
        // put, so the readings come again once the record is readable.
        try "not json".write(to: folder.appending(path: "health-roadmap.json"), atomically: true, encoding: .utf8)
        let (broken, _) = try parts()
        let later = HealthSample(id: UUID(), metric: "waist", value: 90, at: Date(timeIntervalSince1970: 1_792_000_000), timeZone: .gmt)
        health.pending[.waist] = [later]
        let waistAnchor = memory.anchor(for: .waist)
        let brokenSync = sync(broken, engine, health)
        await brokenSync.refresh()
        XCTAssertEqual(memory.anchor(for: .waist), waistAnchor)
        XCTAssertNotEqual(health.anchorData(.waist), waistAnchor, "the fake did hand out a newer anchor")
        guard case .failed = brokenSync.status else { return XCTFail("status \(brokenSync.status)") }
    }

    /// iOS answers a read the person refused with no readings, not an error. Keeping
    /// that answer's anchor would skip every reading already in Health once they allow it.
    func testNoAnchorIsKeptUntilAKindHasGivenReadings() async throws {
        let (store, engine) = try parts()
        let health = FakeHealthStore()
        let sync = sync(store, engine, health)
        await sync.connect()
        let memory = HealthSyncMemory(defaults: defaults)
        XCTAssertNil(memory.anchor(for: .weight))

        health.pending[.weight] = [Self.morning]
        await sync.refresh()
        XCTAssertNotNil(memory.anchor(for: .weight))
        XCTAssertEqual(try activeRows(store).count, 1)
    }

    /// Health shows only the half of a blood pressure the person allowed. Its anchor
    /// waits for a whole pair, so allowing the other half later brings in the past.
    func testHalfABloodPressureKeepsNoAnchor() async throws {
        let (store, engine) = try parts()
        let health = FakeHealthStore()
        let sync = sync(store, engine, health)
        await sync.connect()
        let correlation = UUID()
        let at = Date(timeIntervalSince1970: 1_792_000_000)
        health.pending[.bloodPressure] = [HealthSample(id: UUID(), metric: "systolic_bp", value: 130, at: at, pairId: correlation)]
        await sync.refresh()
        XCTAssertNil(HealthSyncMemory(defaults: defaults).anchor(for: .bloodPressure))
        XCTAssertTrue(try activeRows(store).isEmpty)

        health.pending[.bloodPressure] = [
            HealthSample(id: UUID(), metric: "systolic_bp", value: 130, at: at, pairId: correlation),
            HealthSample(id: UUID(), metric: "diastolic_bp", value: 85, at: at, pairId: correlation),
        ]
        await sync.refresh()
        XCTAssertNotNil(HealthSyncMemory(defaults: defaults).anchor(for: .bloodPressure))
        XCTAssertEqual(try activeRows(store).count, 2)
    }

    func testALockedPhoneWaitsAndKeepsItsAnchor() async throws {
        let (store, engine) = try parts()
        let health = FakeHealthStore()
        health.pending[.weight] = [Self.morning]
        health.locked = true
        let sync = sync(store, engine, health)
        await sync.connect()
        XCTAssertEqual(sync.status, .waitingForUnlock)
        XCTAssertTrue(try activeRows(store).isEmpty)
        XCTAssertNil(HealthSyncMemory(defaults: defaults).anchor(for: .weight))

        health.locked = false
        await sync.refresh()
        XCTAssertEqual(try activeRows(store).count, 1)
    }

    func testTypedValuesGoToHealthOncePerVersion() async throws {
        let (store, engine) = try parts()
        let health = FakeHealthStore()
        let sync = sync(store, engine, health)
        await sync.connect()
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 82, day: "2026-10-20")))
        await sync.refresh()
        XCTAssertEqual(health.saved.count, 1)
        let first = try XCTUnwrap(health.saved.first)
        XCTAssertEqual(first.values, ["weight": 82])

        await sync.refresh()
        XCTAssertEqual(health.saved.count, 1, "an unchanged value is not written again")

        let rowId = try XCTUnwrap(store.myData?.vitals.first?.latest?.id)
        await XCTAssertSaved(await store.apply(.correct(id: rowId, value: 81)))
        await sync.refresh()
        XCTAssertEqual(health.saved.count, 2)
        XCTAssertEqual(health.saved.last?.syncId, first.syncId, "a correction replaces the sample")
        XCTAssertGreaterThan(health.saved.last?.version ?? 0, first.version)
    }

    func testOneRefusedWriteDoesNotBlockTheOthers() async throws {
        let (store, engine) = try parts()
        // Both values typed, and Health set to refuse the first, before Health connects:
        // an edit now waits, so a refresh the first edit started would otherwise run between them.
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 82, day: "2026-10-19")))
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 81, day: "2026-10-20")))
        let shown = store.recordJSON
        let first = try XCTUnwrap(engine.blocking { try $0.healthWrites(recordJSON: shown, now: .now, deviceId: "test") }.first)
        let health = FakeHealthStore()
        health.refusing = [first.syncId]
        let sync = sync(store, engine, health)
        await sync.connect()
        await sync.refresh()
        XCTAssertEqual(health.saved.map(\.values), [["weight": 81]])
        guard case .failed = sync.status else { return XCTFail("status \(sync.status)") }
    }

    /// A refresh asked for while one runs returns only once that one has saved: an
    /// observer query tells iOS the background work is done when it returns.
    func testARefreshDuringARefreshWaitsForIt() async throws {
        let (store, engine) = try parts()
        let health = FakeHealthStore()
        let sync = sync(store, engine, health)
        await sync.connect()
        health.pending[.weight] = [Self.morning]
        let first = Task { await sync.refresh() }
        await Task.yield()
        await sync.refresh()
        XCTAssertEqual(try activeRows(store).count, 1)
        await first.value
    }

    func testNothingIsWrittenWhenHealthRefusesSharing() async throws {
        let (store, engine) = try parts()
        let health = FakeHealthStore()
        health.writable = []
        let sync = sync(store, engine, health)
        await sync.connect()
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 82, day: "2026-10-20")))
        await sync.refresh()
        XCTAssertTrue(health.saved.isEmpty)
    }

    func testNotConnectedReadsAndWritesNothing() async throws {
        let (store, engine) = try parts()
        let health = FakeHealthStore()
        health.pending[.weight] = [Self.morning]
        let sync = sync(store, engine, health)
        await sync.refresh()
        XCTAssertEqual(sync.status, .notConnected)
        XCTAssertTrue(try activeRows(store).isEmpty)
    }

    func testANewBatchWithNothingNewLeavesTheFileAlone() async throws {
        let (store, engine) = try parts()
        let health = FakeHealthStore()
        health.pending[.weight] = [Self.morning]
        let sync = sync(store, engine, health)
        await sync.connect()
        let file = folder.appending(path: "health-roadmap.json")
        let written = try FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false))[.modificationDate] as? Date
        health.pending[.weight] = [Self.morning] // the same reading, offered again
        await sync.refresh()
        let after = try FileManager.default.attributesOfItem(atPath: file.path(percentEncoded: false))[.modificationDate] as? Date
        XCTAssertEqual(written, after)
    }
}

/// HealthSample's time: the instant, in the zone it was taken in, with that zone's offset.
final class HealthSampleTests: XCTestCase {
    func testTheTimeIsTheReadingsOwnZoneWithItsOffset() throws {
        // 2026-10-20 19:30 UTC is 08:30 on 21 October in Auckland (NZDT, +13)
        // and 12:30 on 20 October in Los Angeles (PDT, -7).
        let instant = try Date("2026-10-20T19:30:00Z", strategy: .iso8601)
        let auckland = HealthSample(id: UUID(), metric: "weight", value: 80, at: instant, timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        XCTAssertEqual(auckland.measuredAt, "2026-10-21T08:30:00+13:00")
        let la = HealthSample(id: UUID(), metric: "weight", value: 80, at: instant, timeZone: TimeZone(identifier: "America/Los_Angeles")!)
        XCTAssertEqual(la.measuredAt, "2026-10-20T12:30:00-07:00")
        XCTAssertEqual(HealthSample(id: UUID(), metric: "weight", value: 80, at: instant, timeZone: .gmt).measuredAt, "2026-10-20T19:30:00+00:00")
    }

    func testAWriteForTodayIsNeverInTheFuture() throws {
        let zone = TimeZone(identifier: "Pacific/Auckland")!
        let now = try Date("2026-10-20T19:30:00Z", strategy: .iso8601) // 08:30 on the 21st in Auckland
        let write = HealthWrite(syncId: "a", version: 1, day: "2026-10-21", values: ["weight": 80])
        XCTAssertEqual(write.date(timeZone: zone, now: now), now)
    }

    func testOurOwnSamplesAreNeverReadBack() {
        XCTAssertTrue(HealthKitClient.isOwn(bundleIdentifier: "com.drbrad.healthroadmap", syncIdentifier: nil, ownBundle: "com.drbrad.healthroadmap"))
        XCTAssertTrue(HealthKitClient.isOwn(bundleIdentifier: "com.apple.Health", syncIdentifier: "healthroadmap:abc", ownBundle: "com.drbrad.healthroadmap"))
        XCTAssertFalse(HealthKitClient.isOwn(bundleIdentifier: "com.withings.wiScaleNG", syncIdentifier: nil, ownBundle: "com.drbrad.healthroadmap"))
    }

    func testAWriteLandsAtNoonOnItsDay() throws {
        let write = HealthWrite(syncId: "a", version: 1, day: "2026-10-20", values: ["weight": 80])
        let zone = TimeZone(identifier: "America/New_York")!
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let parts = calendar.dateComponents([.year, .month, .day, .hour], from: try XCTUnwrap(write.date(timeZone: zone)))
        XCTAssertEqual([parts.year, parts.month, parts.day, parts.hour], [2026, 10, 20, 12])
        XCTAssertEqual(write.kind, .weight)
        XCTAssertEqual(HealthWrite(syncId: "b", version: 1, day: "2026-10-20", values: ["systolic_bp": 120, "diastolic_bp": 80]).kind, .bloodPressure)
    }
}

/// HealthKit, faked: readings waiting per kind, an anchor per kind, a lock switch, and what was saved.
@MainActor
final class FakeHealthStore: HealthStoreClient {
    var pending: [HealthKind: [HealthSample]] = [:]
    var locked = false
    var authorized = false
    var writable: Set<HealthKind> = Set(HealthKind.allCases)
    /// Saves of these sync ids fail, as HealthKit can refuse one sample.
    var refusing: Set<String> = []
    private(set) var saved: [HealthWrite] = []
    private var served: [HealthKind: Int] = [:]

    let isAvailable = true

    func requestAuthorization() async throws { authorized = true }

    func anchorData(_ kind: HealthKind) -> Data { Data("\(kind.rawValue)-\(served[kind] ?? 0)".utf8) }

    func samples(of kind: HealthKind, after anchor: Data?) async throws -> HealthBatch {
        if locked { throw HealthStoreError.locked }
        // HealthKit answers later: another refresh can be asked for meanwhile.
        await Task.yield()
        let batch = pending[kind] ?? []
        pending[kind] = nil
        served[kind, default: 0] += 1
        return HealthBatch(samples: batch, anchor: anchorData(kind))
    }

    func canWrite(_ kind: HealthKind) -> Bool { writable.contains(kind) }

    var characteristicsGiven = HealthCharacteristics.none
    func characteristics() -> HealthCharacteristics { characteristicsGiven }

    func save(_ write: HealthWrite) async throws {
        if locked { throw HealthStoreError.locked }
        if refusing.contains(write.syncId) { throw CocoaError(.validationNumberTooLarge) }
        saved.append(write)
    }

    func observe(_ kinds: [HealthKind], onChange: @escaping @MainActor () async -> Void) {}

    /// How many times the app asked Health to delete its own samples (US-25 AC16).
    private(set) var ownDeletes = 0
    var deleteFails = false

    func deleteOwnSamples() async throws {
        if deleteFails { throw HealthStoreError.locked }
        ownDeletes += 1
        saved = []
    }
}
