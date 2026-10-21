import XCTest
@testable import HealthRoadmap

/// US-25 AC1: the app's engine gives the plan Node gives, byte for byte.
/// Goldens come from the same bundle run in Node (ios/scripts/build-engine.mjs),
/// at a pinned instant that is a different calendar day in UTC and in Auckland.
///
/// The time zone must be set when the test process starts: JavaScriptCore reads it
/// once, so changing it mid-run (setenv) does not reach the engine. `ios/scripts/test.sh`
/// runs the suite once per zone with `TEST_RUNNER_TZ`.
final class EngineParityTests: XCTestCase {
    /// Equals PINNED_NOW and PINNED_DEVICE in ios/scripts/build-engine.mjs.
    private static let pinnedNow = "2026-10-21T12:30:00.000Z"
    private static let pinnedDevice = "ios-parity"
    /// The zones with a golden, keyed by the zone the process runs in.
    private static let goldens = ["UTC": "plan-utc", "GMT": "plan-utc", "Pacific/Auckland": "plan-auckland"]

    func testPlanMatchesNodeInThisZone() throws {
        let zone = TimeZone.current.identifier
        guard let golden = Self.goldens[zone] else {
            throw XCTSkip("No golden for \(zone); run ios/scripts/test.sh, which pins UTC and Pacific/Auckland")
        }
        let fixtures = Bundle(for: Self.self)
        let record = try String(contentsOf: XCTUnwrap(fixtures.url(forResource: "sample-record", withExtension: "json")), encoding: .utf8)
        let expected = try String(contentsOf: XCTUnwrap(fixtures.url(forResource: golden, withExtension: "json")), encoding: .utf8)
        let now = try Date(Self.pinnedNow, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

        let actual = try HealthEngine(bundle: .main).plan(recordJSON: record, now: now, deviceId: Self.pinnedDevice)

        XCTAssertEqual(actual, expected, "the app's plan differs from Node's in \(zone)")
    }

    /// US-25 AC2's limits (ios/architecture.md D2). On a simulator this is a
    /// sanity bound only; the real number comes from a phone.
    func testEngineLoadsAndPlansWithinLimits() throws {
        let fixtures = Bundle(for: Self.self)
        let record = try String(contentsOf: XCTUnwrap(fixtures.url(forResource: "sample-record", withExtension: "json")), encoding: .utf8)
        let clock = ContinuousClock()
        let start = clock.now
        let engine = try HealthEngine(bundle: .main)
        let loaded = clock.now
        _ = try engine.plan(recordJSON: record, now: .now, deviceId: Self.pinnedDevice)
        let planned = clock.now

        XCTAssertLessThan(loaded - start, .milliseconds(300), "cold engine load")
        XCTAssertLessThan(planned - loaded, .milliseconds(100), "plan")
    }
}
