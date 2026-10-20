import XCTest
@testable import HealthRoadmap

/// US-25 AC1: the app's engine gives the plan Node gives, byte for byte.
/// Goldens come from the same bundle run in Node (ios/scripts/build-engine.mjs),
/// at a pinned instant that is a different calendar day in UTC and in Auckland.
final class EngineParityTests: XCTestCase {
    /// Equals PINNED_NOW and PINNED_DEVICE in ios/scripts/build-engine.mjs.
    private static let pinnedNow = "2026-10-21T12:30:00.000Z"
    private static let pinnedDevice = "ios-parity"

    func testPlanMatchesNodeInUTC() throws {
        try assertParity(zone: "UTC", golden: "plan-utc")
    }

    func testPlanMatchesNodeInAuckland() throws {
        try assertParity(zone: "Pacific/Auckland", golden: "plan-auckland")
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

    private func assertParity(zone: String, golden: String) throws {
        setenv("TZ", zone, 1)
        tzset()
        defer {
            unsetenv("TZ")
            tzset()
        }
        let fixtures = Bundle(for: Self.self)
        let record = try String(contentsOf: XCTUnwrap(fixtures.url(forResource: "sample-record", withExtension: "json")), encoding: .utf8)
        let expected = try String(contentsOf: XCTUnwrap(fixtures.url(forResource: golden, withExtension: "json")), encoding: .utf8)
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let now = try XCTUnwrap(formatter.date(from: Self.pinnedNow))

        let actual = try HealthEngine(bundle: .main).plan(recordJSON: record, now: now, deviceId: Self.pinnedDevice)

        XCTAssertEqual(actual, expected, "the app's plan differs from Node's in \(zone)")
    }
}
