import XCTest
@testable import HealthRoadmap

/// Lead H27's owner rulings (US-72 AC10), each a behaviour fix. D1: a pass that ends locked or
/// failed after an erase disconnected Apple Health shows "not connected", never the pass's own end
/// over it. D3: a phone with no Health keeps the section hidden after an erase.
/// HealthKit is faked (FakeHealthStore).
@MainActor
final class AppleHealthRunPinsTests: XCTestCase {
    private var folder: URL!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Apple Health Run Pins \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        suite = "AppleHealthRunPinsTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        defaults.removePersistentDomain(forName: suite)
    }

    func testALockedPassAfterAnEraseDisconnectShowsNotConnected_US72_AC10_D1() async throws {
        try await assertNotConnected(afterAPassThat: HealthStoreError.locked)
    }

    func testAFailedPassAfterAnEraseDisconnectShowsNotConnected_US72_AC10_D1() async throws {
        try await assertNotConnected(afterAPassThat: CocoaError(.validationNumberTooLarge))
    }

    func testAPhoneWithoutHealthStaysUnavailableAfterAnErase_US72_AC10_D3() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let health = FakeHealthStore()
        health.isAvailable = false
        // Connected on a phone with Health, then restored onto one without it.
        let memory = HealthSyncMemory(defaults: defaults)
        memory.connected = true
        let sync = AppleHealthSync(store: store, engine: engine, client: health, memory: memory)
        XCTAssertEqual(sync.status, .unavailable)

        _ = await sync.erased(wasConnected: sync.everConnected)
        await sync.refresh()

        XCTAssertEqual(sync.status, .unavailable, "the Apple Health section stays hidden")
    }

    /// Review R1 (US-72 AC10): a Connect that fails while an erase drains a pass leaves the pass
    /// its claim, so `drained` still waits and a reconnect queues behind it, never a second pass
    /// beside it.
    func testAFailedConnectDuringTheDrainKeepsThePassItsClaim_US72_AC10() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")))
        let health = FakeHealthStore()
        var reached = false, released = false
        health.saveHold = { [weak health] in
            health?.saveHold = nil
            reached = true
            while !released { await Task.yield() }
        }
        let sync = AppleHealthSync(store: store, engine: engine, client: health, memory: HealthSyncMemory(defaults: defaults))
        let connecting = Task { await sync.connect() }
        while !reached { await Task.yield() }
        let erase = Task { await sync.erased(wasConnected: true) }
        while sync.run != .stopping { await Task.yield() }

        health.authorizationError = CocoaError(.userCancelled)
        await sync.connect()
        XCTAssertEqual(sync.run, .stopping, "the draining pass keeps its claim")
        XCTAssertTrue(sync.run.passing, "an erase's delete still waits for it")

        health.authorizationError = nil
        let reconnecting = Task { await sync.connect() }
        while sync.run != .running(queued: true) { await Task.yield() }
        released = true
        await connecting.value
        await reconnecting.value
        _ = await erase.value

        guard case .upToDate = sync.status else { return XCTFail("status \(sync.status)") }
        XCTAssertTrue(sync.waiting.isEmpty, "every caller was let go")
    }

    /// The connect pass's one save to Health is held, an erase disconnects Health meanwhile, then
    /// the save throws `error`, ending the pass locked or failed.
    private func assertNotConnected(afterAPassThat error: Error) async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")))
        let health = FakeHealthStore()
        var reached = false, released = false
        health.saveHold = { [weak health] in
            health?.saveHold = nil
            reached = true
            while !released { await Task.yield() }
            throw error
        }
        let sync = AppleHealthSync(store: store, engine: engine, client: health, memory: HealthSyncMemory(defaults: defaults))
        let connecting = Task { await sync.connect() }
        while !reached { await Task.yield() }

        let erase = Task { await sync.erased(wasConnected: true) }
        while sync.status != .notConnected { await Task.yield() }
        released = true
        await connecting.value
        _ = await erase.value

        XCTAssertTrue(health.saved.isEmpty, "the held save never landed")
        XCTAssertEqual(sync.status, .notConnected, "the erase disconnect shows, not how the pass ended")
    }
}
