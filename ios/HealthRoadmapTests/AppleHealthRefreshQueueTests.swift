import XCTest
@testable import HealthRoadmap

/// Lead H27 pin (US-25 AC13, US-72 AC10): any number of refreshes asked for while a pass runs
/// give exactly one more pass, and every caller returns only after it; a pass that meets a locked
/// phone drops the queued run. A pass is counted by its reads of the first kind (each pass reads
/// every kind once; Health Records stay off).
@MainActor
final class AppleHealthRefreshQueueTests: XCTestCase {
    private var folder: URL!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Apple Health Queue \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        suite = "AppleHealthRefreshQueueTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        defaults.removePersistentDomain(forName: suite)
    }

    private static let callers = 3
    private static let first = HealthKind.allCases[0]

    /// Connected, its connect pass over, and a pass held at its first read with `callers` refreshes
    /// queued behind it. Returns the passes before the held one, the held pass and the callers, each
    /// caller answering how many passes had started when it returned.
    private func queued() async throws -> (FakeHealthStore, AppleHealthSync, Int, Task<Void, Never>, [Task<Int, Never>], () -> Void) {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let health = FakeHealthStore()
        let sync = AppleHealthSync(store: store, engine: engine, client: health, memory: HealthSyncMemory(defaults: defaults))
        await sync.connect()
        let before = Self.passes(health)
        var reached = false, released = false
        health.hold = { [weak health] in
            health?.hold = nil
            reached = true
            while !released { await Task.yield() }
        }
        let held = Task { await sync.refresh() }
        while !reached { await Task.yield() }
        let callers = (0..<Self.callers).map { _ in
            Task { () -> Int in
                await sync.refresh()
                return Self.passes(health)
            }
        }
        while sync.waiting.count < Self.callers { await Task.yield() }
        return (health, sync, before, held, callers, { released = true })
    }

    private static func passes(_ health: FakeHealthStore) -> Int { health.sampleAnchors[first]?.count ?? 0 }

    func testManyRefreshesDuringAPassRunExactlyOneMore_H27() async throws {
        let (health, sync, before, held, callers, release) = try await queued()

        release()
        await held.value
        for caller in callers {
            let seen = await caller.value
            XCTAssertEqual(seen, before + 2, "a caller returned only after the one extra pass")
        }

        XCTAssertEqual(Self.passes(health) - before, 2, "the held pass and exactly one more")
        XCTAssertEqual(health.reads % HealthKind.allCases.count, 0, "whole passes only")
        guard case .upToDate = sync.status else { return XCTFail("status \(sync.status)") }
    }

    func testALockedPassDropsTheQueuedRun_H27() async throws {
        let (health, sync, before, held, callers, release) = try await queued()

        health.locked = true
        release()
        await held.value
        for caller in callers {
            let seen = await caller.value
            XCTAssertEqual(seen, before + 1, "a caller returned once the locked pass ended")
        }

        XCTAssertEqual(Self.passes(health) - before, 1, "no extra pass after a locked one")
        XCTAssertEqual(sync.status, .waitingForUnlock)
    }
}
