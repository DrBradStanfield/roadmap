import XCTest
@testable import HealthRoadmap

/// How long each engine call holds the main thread (ios/architecture.md D2's limits),
/// on a record the size a long-time user reaches. Opt-in, because it runs for seconds:
///   TEST_RUNNER_ENGINE_SPEED=1 xcodebuild test ... -only-testing:HealthRoadmapTests/EngineSpeedTests
/// Prints one line per call: the median of five runs, in milliseconds; `plan cold` re-reads the record every run.
final class EngineSpeedTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    @MainActor
    func testEngineCallTimes() throws {
        guard ProcessInfo.processInfo.environment["ENGINE_SPEED"] == "1" else {
            throw XCTSkip("Opt-in: set TEST_RUNNER_ENGINE_SPEED=1.")
        }
        print("ENGINE-SPEED cold load \(try median { _ = try HealthEngine() }) ms")
        let engine = try HealthEngine()
        for years in [1, 3, 10] {
            let record = try padded(engine, years: years)
            let rows = (try JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any])?["measurements"] as? [Any]
            let label = "\(years)y \(rows?.count ?? 0) rows \(record.utf8.count / 1024) KB"
            var plan = ""
            // A new device id each run misses the engine's parsed-record slot (my-data.ts keepRecord):
            // the cold read. The lines below repeat one text, so all but the first run are served from it.
            var run = 0
            print("ENGINE-SPEED \(label) plan cold \(try median { run += 1; _ = try engine.blocking { [now] in try $0.plan(recordJSON: record, now: now, deviceId: "cold\(run)") } }) ms")
            print("ENGINE-SPEED \(label) plan \(try median { plan = try engine.blocking { [now] in try $0.plan(recordJSON: record, now: now, deviceId: "t") } }) ms")
            print("ENGINE-SPEED \(label) sections \(try median { _ = try engine.blocking { try $0.sections(planJSON: plan) } }) ms")
            print("ENGINE-SPEED \(label) myData \(try median { _ = try engine.blocking { [now] in try $0.myData(recordJSON: record, now: now, deviceId: "t") } }) ms")
            print("ENGINE-SPEED \(label) history \(try median { _ = try engine.blocking { [now] in try $0.history(recordJSON: record, metric: "weight", now: now, deviceId: "t") } }) ms")
            print("ENGINE-SPEED \(label) apply \(try median { XCTAssertTrue(try engine.blocking { [now] in try $0.apply(.add(metric: "weight", value: 70, day: DayText.iso(now)), to: record, now: now, deviceId: "t") }.ok) }) ms")
            print("ENGINE-SPEED \(label) merge \(try median { _ = try engine.blocking { [now] in try $0.call("mergeJson", [record, record, now.formatted(HealthEngine.iso), "t"]) } }) ms")
            print("ENGINE-SPEED \(label) reminders \(try median { _ = try engine.blocking { [now] in try $0.reminders(recordJSON: record, now: now, deviceId: "t") } }) ms")
        }
    }

    /// A daily weight and blood pressure, and a lipid panel and HbA1c every quarter, for `years`.
    private func padded(_ engine: HealthEngine, years: Int) throws -> String {
        var record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "t") }.utf8)) as? [String: Any])
        var rows: [[String: Any]] = []
        for back in 1...(365 * years) {
            let day = DayText.iso(Calendar.current.date(byAdding: .day, value: -back, to: now)!)
            func row(_ metric: String, _ value: Double) {
                rows.append(["id": "\(metric)-\(day)", "metricType": metric, "value": value, "recordedAt": day, "createdAt": "\(day)T08:00:00Z",
                             "source": "manual", "status": "active", "correctsId": NSNull(), "externalId": NSNull()])
            }
            row("weight", 70 + Double(back % 30) / 10)
            row("systolic_bp", 120 + Double(back % 15))
            row("diastolic_bp", 75 + Double(back % 10))
            if back % 90 == 0 { row("ldl", 2.5); row("hba1c", 36) }
        }
        record["measurements"] = rows
        var profile = record["profile"] as? [String: Any] ?? [:]
        profile.merge(["sex": "female", "birthYear": 1984, "birthMonth": 6, "heightCm": 165]) { $1 }
        record["profile"] = profile
        return String(decoding: try JSONSerialization.data(withJSONObject: record), as: UTF8.self)
    }

    @MainActor
    private func median(_ work: () throws -> Void) rethrows -> String {
        var times: [Double] = []
        for _ in 0..<5 {
            let start = ContinuousClock.now
            try work()
            let elapsed = ContinuousClock.now - start
            times.append(Double(elapsed.components.attoseconds) / 1e15 + Double(elapsed.components.seconds) * 1000)
        }
        return String(format: "%.1f", times.sorted()[2])
    }
}
