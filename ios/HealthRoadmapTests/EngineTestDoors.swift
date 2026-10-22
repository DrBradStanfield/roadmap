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
