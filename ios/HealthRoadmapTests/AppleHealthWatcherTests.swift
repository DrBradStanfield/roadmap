import XCTest
@testable import HealthRoadmap

/// S52 follow-up F3 (US-25 AC13, AC16f, AC21): the Apple Health record watcher starts a HealthKit
/// pass for a new record revision and for the erase window (`predatesErase`) opening or closing,
/// never for a redraw of the same record (coming forward, midnight). A pass is counted by its
/// reads: each one reads every kind once (FakeHealthStore.reads; Health Records stay off).
@MainActor
final class AppleHealthWatcherTests: XCTestCase {
    private var folder: URL!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Apple Health Watcher \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        suite = "AppleHealthWatcherTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        defaults.removePersistentDomain(forName: suite)
    }

    private struct Watched {
        let store: RecordStore
        let health: FakeHealthStore
        let sync: AppleHealthSync
    }

    /// A drawn record with a weight, Apple Health connected and its connect pass over.
    private func watched() async throws -> Watched {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")))
        let health = FakeHealthStore()
        let sync = AppleHealthSync(store: store, engine: engine, client: health, memory: HealthSyncMemory(defaults: defaults))
        await sync.connect()
        await settle()
        XCTAssertNotNil(store.myData, "the record is drawn")
        return Watched(store: store, health: health, sync: sync)
    }

    /// The passes started since `reads`, once every pass the change started has finished.
    private func passCount(since reads: Int, _ health: FakeHealthStore) async -> Int {
        await settle()
        let made = health.reads - reads
        XCTAssertEqual(made % HealthKind.allCases.count, 0, "whole passes only")
        return made / HealthKind.allCases.count
    }

    private func settle() async {
        try? await Task.sleep(for: .milliseconds(300))
    }

    func testARedrawOfTheSameRecordStartsNoPass_F3() async throws {
        let w = try await watched()
        let reads = w.health.reads
        let draws = w.store.draws

        await w.store.redraw().value
        await w.store.redraw(now: .now.addingTimeInterval(86_400)).value

        XCTAssertEqual(w.store.draws, draws + 2, "both redraws drew")
        let passes = await passCount(since: reads, w.health)
        XCTAssertEqual(passes, 0, "a redraw of the same record reads nothing from HealthKit")
    }

    func testANewRecordRevisionStartsOnePass_F3() async throws {
        let w = try await watched()
        let reads = w.health.reads
        let revision = w.store.revision

        await XCTAssertSaved(await w.store.apply(.add(metric: "waist", value: 90, day: "2026-10-21")))

        XCTAssertEqual(w.store.revision, revision + 1)
        let passes = await passCount(since: reads, w.health)
        XCTAssertEqual(passes, 1, "the typed value goes to Health in one pass")
    }

    /// One pass each way. Opening: the pass meets the window, writes nothing typed (`readable` is
    /// nil) and its imports are refused, so the record is untouched. Closing: the record is
    /// readable again, so what it holds for Health goes out without waiting for the next edit.
    /// Neither moves `revision` here: the store keeps the same record text throughout.
    func testTheEraseWindowOpeningAndClosingEachStartOnePass_F3() async throws {
        let w = try await watched()
        let held = try XCTUnwrap(w.store.readable?.json)
        let revision = w.store.revision

        var reads = w.health.reads
        await w.store.showErased(nil).value
        XCTAssertTrue(w.store.predatesErase)
        XCTAssertEqual(w.store.revision, revision, "the window opens with no new revision")
        var passes = await passCount(since: reads, w.health)
        XCTAssertEqual(passes, 1, "the window opening")

        reads = w.health.reads
        await w.store.redraw().value
        passes = await passCount(since: reads, w.health)
        XCTAssertEqual(passes, 0, "a redraw inside the window")

        reads = w.health.reads
        await w.store.showCloud(HealthEngine.CloudView(record: held, erase: "e2", session: 2, order: 1)).value
        XCTAssertFalse(w.store.predatesErase)
        XCTAssertEqual(w.store.revision, revision, "the window closes on the same record text")
        passes = await passCount(since: reads, w.health)
        XCTAssertEqual(passes, 1, "the window closing")
    }
}
