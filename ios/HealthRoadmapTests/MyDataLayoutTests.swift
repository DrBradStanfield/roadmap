import XCTest
@testable import HealthRoadmap

/// US-25 AC17: blood pressure as one reading, height in feet and inches, and the
/// metric page's range picker. The engine's rules run in JavaScriptCore here and
/// in Node in ios/engine/blood-pressure.test.ts.
final class MyDataLayoutTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    private func record(_ engine: HealthEngine, locale: String = "en-NZ", zone: String = "Pacific/Auckland") throws -> String {
        try engine.newRecord(now: now, deviceId: "test", locale: Locale(identifier: locale), timeZone: TimeZone(identifier: zone)!)
    }

    private func rows(_ record: String) throws -> [[String: Any]] {
        try XCTUnwrap((JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any])?["measurements"] as? [[String: Any]])
    }

    func testABloodPressureSavesBothHalvesOrNeither() throws {
        let engine = try HealthEngine()
        let empty = try record(engine)
        let refused = try engine.apply(.bloodPressure(systolic: 120, diastolic: 300, day: "2026-10-20", replace: false), to: empty, now: now, deviceId: "test")
        XCTAssertFalse(refused.ok)
        XCTAssertNil(refused.record)

        let saved = try XCTUnwrap(engine.apply(.bloodPressure(systolic: 120, diastolic: 80, day: "2026-10-20", replace: false), to: empty, now: now, deviceId: "test").record)
        XCTAssertEqual(try rows(saved).map { $0["metricType"] as? String }, ["systolic_bp", "diastolic_bp"])
        let shown = try engine.myData(recordJSON: saved, now: now, deviceId: "test")
        XCTAssertEqual(shown.vitals.map(\.metric), ["weight", "waist", MyData.bloodPressure])
        XCTAssertEqual(shown.vitals.last?.latest?.value, "120/80")
    }

    func testReplacingABloodPressureAsksFirstThenCorrectsTheChangedHalf() throws {
        let engine = try HealthEngine()
        let first = try XCTUnwrap(engine.apply(.bloodPressure(systolic: 120, diastolic: 80, day: "2026-10-20", replace: false), to: try record(engine), now: now, deviceId: "test").record)
        let held = try engine.apply(.bloodPressure(systolic: 125, diastolic: 80, day: "2026-10-20", replace: false), to: first, now: now, deviceId: "test")
        XCTAssertEqual(held.reason, "slot-occupied")
        XCTAssertNotNil(held.existingId)

        let fixed = try XCTUnwrap(engine.apply(.bloodPressure(systolic: 125, diastolic: 80, day: "2026-10-20", replace: true), to: first, now: now, deviceId: "test").record)
        let after = try rows(fixed)
        XCTAssertEqual(after.count, 3)
        XCTAssertEqual(after[0]["status"] as? String, "entered-in-error")
        XCTAssertEqual(after[2]["correctsId"] as? String, after[0]["id"] as? String)

        let history = try engine.history(recordJSON: fixed, metric: MyData.bloodPressure, now: now, deviceId: "test")
        XCTAssertEqual(history.rows.map(\.value), ["125/80", "120/–"])
        XCTAssertEqual(history.rows.first?.systolic, "125")
        XCTAssertEqual(history.rows.first?.diastolic, "80")
    }

    func testAUSHeightIsFeetAndInches() throws {
        let engine = try HealthEngine()
        let empty = try record(engine, locale: "en-US", zone: "America/New_York")
        let saved = try XCTUnwrap(engine.apply(.feetInches(feet: 5, inches: 10), to: empty, now: now, deviceId: "test").record)
        let profile = try engine.myData(recordJSON: saved, now: now, deviceId: "test").profile
        XCTAssertEqual(profile.feetInches, MyData.FeetInches(feet: 5, inches: 10))
        XCTAssertEqual(profile.feetInches?.text, "5 ft 10 in")

        let refused = try engine.apply(.feetInches(feet: 5, inches: 12), to: empty, now: now, deviceId: "test")
        XCTAssertFalse(refused.ok)
    }

    // MARK: The range picker

    private func day(_ text: String) -> Date { DayText.date(text)! }

    func testOnlyRangesThatHoldSomeButNotAllValuesAreOffered() {
        let today = day("2026-10-21")
        // Values across three years: the week and month hold none.
        let spread = ["2023-10-01", "2025-06-01", "2026-06-01", "2026-09-01"].map(day)
        XCTAssertEqual(ChartRange.offered(for: spread, today: today), [.sixMonths, .year, .all])
        // All within the last week: every range shows the same, so only All.
        let recent = ["2026-10-18", "2026-10-20"].map(day)
        XCTAssertEqual(ChartRange.offered(for: recent, today: today), [.all])
        XCTAssertEqual(ChartRange.offered(for: [], today: today), [.all])
        // A week and a month that each leave some out.
        let dense = ["2026-01-01", "2026-09-30", "2026-10-19"].map(day)
        XCTAssertEqual(ChartRange.offered(for: dense, today: today), [.week, .month, .sixMonths, .all])
    }

    func testTheWeekStartsSixDaysBeforeToday() {
        XCTAssertEqual(ChartRange.week.start(today: day("2026-10-21")), day("2026-10-15"))
        XCTAssertNil(ChartRange.all.start(today: day("2026-10-21")))
    }

    func testScrubbingPicksTheNearestValue() {
        let dates = ["2026-10-01", "2026-10-10", "2026-10-20"].map(day)
        XCTAssertEqual(ChartRange.nearest(to: day("2026-10-14"), in: dates), day("2026-10-10"))
        XCTAssertEqual(ChartRange.nearest(to: day("2026-12-01"), in: dates), day("2026-10-20"))
        XCTAssertNil(ChartRange.nearest(to: day("2026-10-14"), in: []))
    }
}
