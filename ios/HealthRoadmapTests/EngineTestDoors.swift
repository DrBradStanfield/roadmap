import Foundation
import XCTest
@testable import HealthRoadmap

/// Test-only doors into the engine's context. A JSValue never leaves the engine's
/// queue, so a script runs and is read there in one call.
extension HealthEngine {
    /// Runs a script and waits for its Promise (or plain value), as text.
    func settleScript(_ script: String) async throws -> String {
        try await settle(evaluate(script))
    }

    /// A typed number as the engine reads it (`numberJson`, the web's rule): the oracle
    /// `TypedNumber.read` is held to (NumberReadingTests). The app reads numbers in Swift.
    func number(from text: String) throws -> Double? {
        try JSONDecoder().decode(Double?.self, from: Data(call("numberJson", [text]).utf8))
    }

    /// Runs `body` on the engine's queue and waits for it: tests only, so the app cannot
    /// wait on the engine (US-25 AC21b); it awaits `perform` or a door instead. The body
    /// runs on the queue's own thread, not the waiting one (as `queue.sync` would), so the
    /// engine's no-JS-on-main precondition holds for a test that waits from main. The
    /// engine queue never waits on main, so this cannot deadlock.
    nonisolated func blocking<T>(_ body: (isolated HealthEngine) throws -> T) throws -> T {
        try withoutActuallyEscaping(body) { body in
            // Run on the engine's executor, so the isolation `body` asks for holds.
            try hop(unsafeBitCast(body, to: ((HealthEngine) throws -> T).self))
        }
    }

    /// `blocking` for a body that cannot throw.
    nonisolated func blocking<T>(_ body: (isolated HealthEngine) -> T) -> T {
        withoutActuallyEscaping(body) { body in
            try! hop(unsafeBitCast(body, to: ((HealthEngine) -> T).self))
        }
    }

    private nonisolated func hop<T>(_ body: @escaping (HealthEngine) throws -> T) throws -> T {
        let work = BlockingWork(body)
        let done = DispatchSemaphore(value: 0)
        queue.async { work.run(self); done.signal() }
        done.wait()
        return try work.result!.get()
    }

    /// My data for a record: the screen door's half the tests read.
    func myData(recordJSON: String, now: Date, deviceId: String, units: String = "{}") throws -> MyData {
        try screen(recordJSON: recordJSON, now: now, deviceId: deviceId, units: units).myData
    }

    /// The Plan tab's sections and tiles for a record: the screen door's other half.
    /// Throws unless the engine planned it.
    func planView(record: String, units: String, now: Date, deviceId: String) throws -> (sections: [PlanSection], tiles: [StatTile]) {
        let plan = try screen(recordJSON: record, now: now, deviceId: deviceId, units: units).plan
        guard case .planned(let tiles, let sections, _) = plan else { throw EngineError.callFailed("not planned: \(plan)") }
        return (sections, tiles)
    }

    /// Whether the engine's own work runs on the main thread (it must not).
    func onMainThread() -> Bool {
        dispatchPrecondition(condition: .onQueue(queue))
        return Thread.isMainThread
    }
}

/// `XCTAssertEqual(result, .saved)` for an edit that is awaited first: an
/// assertion's own autoclosure cannot wait.
@MainActor
func XCTAssertSaved(_ result: @autoclosure () async -> RecordStore.ApplyResult, _ message: String = "", file: StaticString = #filePath, line: UInt = #line) async {
    let result = await result()
    XCTAssertEqual(result, .saved, message, file: file, line: line)
}

extension RecordStore {
    /// The store with the phone's file read at once, as tests want it: the app awaits
    /// `RecordStore.open` instead, off the main thread (US-25 AC21).
    convenience init(folder: URL, engine: HealthEngine, deviceId: String) throws {
        let (file, units) = (RecordStore.file(in: folder), UnitChoices.saved().json)
        let loaded = try engine.blocking { try $0.loadPhone(file, deviceId: deviceId, units: units) }
        self.init(folder: folder, engine: engine, deviceId: deviceId, loaded: loaded)
    }
}

/// One `blocking` call's body and answer, handed to the engine's queue. The body is
/// dropped once run, so `withoutActuallyEscaping` sees it released before it returns.
private final class BlockingWork<T>: @unchecked Sendable {
    private var body: ((HealthEngine) throws -> T)?
    private(set) var result: Result<T, Error>?

    init(_ body: @escaping (HealthEngine) throws -> T) { self.body = body }

    func run(_ engine: HealthEngine) {
        result = Result { try body!(engine) }
        body = nil
    }
}
