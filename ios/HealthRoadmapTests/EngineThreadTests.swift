import XCTest
@testable import HealthRoadmap

/// Engine work runs on the engine's own queue, never the main thread (Brad 2026-10-22,
/// ios/architecture.md D2 stage 2). The plan, an edit and My data wait on nothing from
/// the main thread, and the engine's queue never waits on the main thread.
@MainActor
final class EngineThreadTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Engine Thread \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        UnitChoices().save()
    }

    private var mainThreadBlocks: Int { HealthEngine.mainThreadBlocks.withLock { $0 } }

    func testThePlanAnEditAndMyDataNeverBlockTheMainThread() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        let other = store.myData?.unitSystem == "si" ? "conventional" : "si"
        let before = mainThreadBlocks

        await XCTAssertSaved(await store.apply(.profile(sex: "male", birthYear: 1970, birthMonth: 6, height: 178)))
        await XCTAssertSaved(await store.applyNow(.add(metric: "weight", value: 80, day: "2026-10-20")))
        await store.switchUnits(for: weight, to: other).value // My data, drawn again
        await store.showPhone().value // the phone's file, read and drawn
        let plan = try await engine.planSections(record: store.recordJSON, units: store.unitChoices.json, now: .now, deviceId: "test")
        XCTAssertFalse(plan.sections.isEmpty)

        XCTAssertEqual(mainThreadBlocks, before, "the main thread waited on the engine")
    }

    func testAPlanNoLongerWantedIsNotStarted() async throws {
        let engine = try HealthEngine()
        let record = try engine.blocking { try $0.newRecord(now: .now, deviceId: "test") }
        let task = Task { try await engine.planSections(record: record, units: "{}", now: .now, deviceId: "test") }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled plan ran")
        } catch is CancellationError {}
    }

    func testTheEngineRunsOnItsOwnQueue() async throws {
        let engine = try HealthEngine()
        let onMain = await engine.onMainThread()
        XCTAssertFalse(onMain, "an awaited engine call runs off the main thread")
        // `blocking` runs on the engine's queue too (on the waiting thread, as queue.sync does).
        engine.blocking { engine in dispatchPrecondition(condition: .onQueue(engine.queue)) }
    }

    /// The engine's queue never waits on the main thread: nothing in the natives waits for
    /// it (`main.sync`) or assumes it is already there (`assumeIsolated`), either of which
    /// would deadlock while the main thread waits in `blocking`.
    func testTheNativesNeverWaitOnTheMainThread() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "HealthRoadmap/Engine/EngineNatives.swift")
        guard FileManager.default.fileExists(atPath: source.path(percentEncoded: false)) else {
            throw XCTSkip("The app's sources are not on this device (a real iPhone); the simulator run checks them.")
        }
        let text = try String(contentsOf: source, encoding: .utf8)
        XCTAssertFalse(text.contains("main.sync"))
        XCTAssertFalse(text.contains("assumeIsolated"))
        XCTAssertTrue(text.contains("DispatchQueue.main.async"), "news goes to the main thread without waiting")
    }
}
