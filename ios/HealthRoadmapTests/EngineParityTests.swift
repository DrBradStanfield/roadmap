import XCTest
@testable import HealthRoadmap

/// US-25 AC1: the app's engine gives what the engine's source gives in Node,
/// byte for byte: the plan (or the refusal), and the layout. One golden per
/// record per zone, from ios/scripts/build-engine.mjs; the records are in
/// ios/engine/fixtures.mjs (urgent via a correction, a minor, an excluded value,
/// no height). The pinned instant is a different calendar day in UTC and Auckland.
///
/// The time zone must be set when the test process starts: JavaScriptCore reads it
/// once, so changing it mid-run (setenv) does not reach the engine. `ios/scripts/test.sh`
/// runs the suite once per zone with `TEST_RUNNER_TZ`, and fails if this test skips.
final class EngineParityTests: XCTestCase {
    /// Equals PINNED_NOW and PINNED_DEVICE in ios/scripts/build-engine.mjs.
    private static let pinnedNow = "2026-10-21T12:30:00.000Z"
    private static let pinnedDevice = "ios-parity"
    /// The golden suffix for the zone the process runs in.
    private static let zoneSuffixes = ["UTC": "utc", "GMT": "utc", "Pacific/Auckland": "auckland"]

    private struct Golden: Decodable {
        let plan: String?
        let error: String?
        let sections: String?
    }

    func testEveryFixtureMatchesTheSourceInThisZone() throws {
        let zone = TimeZone.current.identifier
        guard let suffix = Self.zoneSuffixes[zone] else {
            throw XCTSkip("No goldens for \(zone); run ios/scripts/test.sh, which pins UTC and Pacific/Auckland")
        }
        let fixtures = Bundle(for: Self.self)
        let records = try XCTUnwrap(fixtures.urls(forResourcesWithExtension: "json", subdirectory: nil))
            .filter { $0.lastPathComponent.hasSuffix(".record.json") }
        XCTAssertGreaterThanOrEqual(records.count, 5, "the parity fixtures are missing; run ios/scripts/build-engine.mjs")

        let engine = try HealthEngine(bundle: .main)
        let now = try Date(Self.pinnedNow, strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        for recordURL in records {
            let name = recordURL.lastPathComponent.replacingOccurrences(of: ".record.json", with: "")
            let goldenURL = try XCTUnwrap(fixtures.url(forResource: "\(name).\(suffix).golden", withExtension: "json"), name)
            let golden = try JSONDecoder().decode(Golden.self, from: Data(contentsOf: goldenURL))
            let record = try String(contentsOf: recordURL, encoding: .utf8)

            do {
                let plan = try engine.plan(recordJSON: record, now: now, deviceId: Self.pinnedDevice)
                XCTAssertNil(golden.error, "\(name): the source refused to plan, the app did not")
                XCTAssertEqual(plan, golden.plan, "\(name): the plan differs in \(zone)")
                XCTAssertEqual(try engine.sectionsJSON(planJSON: plan), golden.sections, "\(name): the layout differs in \(zone)")
            } catch HealthEngine.EngineError.callFailed(let message) {
                XCTAssertEqual(message, golden.error, "\(name): the refusal differs in \(zone)")
            }
        }
    }

    /// US-25 AC2's limits (ios/architecture.md D2). On a simulator this is a
    /// sanity bound only; the real number comes from a phone.
    func testEngineLoadsAndPlansWithinLimits() throws {
        let fixtures = Bundle(for: Self.self)
        let record = try String(contentsOf: XCTUnwrap(fixtures.url(forResource: "sample.record", withExtension: "json")), encoding: .utf8)
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
