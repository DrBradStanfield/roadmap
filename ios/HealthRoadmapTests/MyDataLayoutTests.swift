import XCTest
@testable import HealthRoadmap

/// US-25 AC17: blood pressure as one reading, height in feet and inches, and the
/// metric page's range picker. The engine's rules run in JavaScriptCore here and
/// in Node in ios/engine/blood-pressure.test.ts.
final class MyDataLayoutTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    private func record(_ engine: HealthEngine, locale: String = "en-NZ", zone: String = "Pacific/Auckland") throws -> String {
        try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: locale), timeZone: TimeZone(identifier: zone)!) }
    }

    private func rows(_ record: String) throws -> [[String: Any]] {
        try XCTUnwrap((JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any])?["measurements"] as? [[String: Any]])
    }

    /// US-25 AC17: the right-most strip of the chart is visible, so it is pickable.
    func testScrubbingPicksEveryDayInViewIncludingTheRightMostStrip() {
        let days = (0...10).map { Date(timeIntervalSince1970: 1_792_000_000 + Double($0) * 86_400) }
        let week: TimeInterval = 7 * 86_400
        // Daily readings, a week window scrolled to the middle of day 0 (Codex's case): day 7 and
        // day 8 (inside the margin) are pickable, day 0 (before the left edge) is not.
        let scrolled = days[0].addingTimeInterval(43_200)
        let picked = MetricChart.inView(days, scrolledTo: scrolled, window: week)
        XCTAssertTrue(picked.contains(days[7]))
        XCTAssertTrue(picked.contains(days[8]))
        XCTAssertFalse(picked.contains(days[9]))
        XCTAssertFalse(picked.contains(days[0]))
        XCTAssertEqual(MetricChart.inView(days, scrolledTo: scrolled, window: nil), days)
    }

    /// US-25 AC17: a range opens on the newest value, not today.
    func testARangeOpensOnTheNewestValue() {
        let newest = Date(timeIntervalSince1970: 1_792_000_000)
        XCTAssertEqual(ChartRange.month.start(ending: newest), DayText.utc.date(byAdding: .month, value: -1, to: newest))
        XCTAssertEqual(ChartRange.year.start(ending: newest), DayText.utc.date(byAdding: .year, value: -1, to: newest))
    }

    func testABloodPressureSavesBothHalvesOrNeither() throws {
        let engine = try HealthEngine()
        let empty = try record(engine)
        let refused = try engine.blocking { [now] in try $0.apply(.bloodPressure(systolic: 120, diastolic: 300, day: "2026-10-20", replace: false), to: empty, now: now, deviceId: "test") }
        XCTAssertFalse(refused.ok)
        XCTAssertNil(refused.record)

        let saved = try XCTUnwrap(engine.blocking { [now] in try $0.apply(.bloodPressure(systolic: 120, diastolic: 80, day: "2026-10-20", replace: false), to: empty, now: now, deviceId: "test") }.record)
        XCTAssertEqual(try rows(saved).map { $0["metricType"] as? String }, ["systolic_bp", "diastolic_bp"])
        let shown = try engine.blocking { [now] in try $0.myData(recordJSON: saved, now: now, deviceId: "test") }
        XCTAssertEqual(shown.vitals.map(\.metric), ["weight", "waist", MyData.bloodPressure])
        XCTAssertEqual(shown.vitals.last?.latest?.value, "120/80")
    }

    func testReplacingABloodPressureAsksFirstThenCorrectsTheChangedHalf() throws {
        let engine = try HealthEngine()
        let start = try record(engine)
        let first = try XCTUnwrap(engine.blocking { [now] in try $0.apply(.bloodPressure(systolic: 120, diastolic: 80, day: "2026-10-20", replace: false), to: start, now: now, deviceId: "test") }.record)
        let held = try engine.blocking { [now] in try $0.apply(.bloodPressure(systolic: 125, diastolic: 80, day: "2026-10-20", replace: false), to: first, now: now, deviceId: "test") }
        XCTAssertEqual(held.reason, "slot-occupied")
        XCTAssertNotNil(held.existingId)

        let shown = try XCTUnwrap(engine.blocking { [now] in try $0.history(recordJSON: first, metric: MyData.bloodPressure, now: now, deviceId: "test") }.rows.first?.pairIds)
        XCTAssertEqual(shown.count, 2)
        // A replace that names other rows than the day holds is refused (Codex R1).
        let stale = try engine.blocking { [now] in try $0.apply(.bloodPressure(systolic: 125, diastolic: 80, day: "2026-10-20", replace: true, seenIds: [shown[0]]), to: first, now: now, deviceId: "test") }
        XCTAssertEqual(stale.reason, "record-changed")

        let fixed = try XCTUnwrap(engine.blocking { [now] in try $0.apply(.bloodPressure(systolic: 125, diastolic: 80, day: "2026-10-20", replace: true, seenIds: shown), to: first, now: now, deviceId: "test") }.record)
        let after = try rows(fixed)
        XCTAssertEqual(after.count, 3)
        XCTAssertEqual(after[0]["status"] as? String, "entered-in-error")
        XCTAssertEqual(after[1]["status"] as? String, "active")
        XCTAssertEqual(after[2]["correctsId"] as? String, after[0]["id"] as? String)

        let history = try engine.blocking { [now] in try $0.history(recordJSON: fixed, metric: MyData.bloodPressure, now: now, deviceId: "test") }
        XCTAssertEqual(history.rows.map(\.value), ["125/80", "120/80"])
        XCTAssertEqual(history.rows.first?.systolic, "125")
        XCTAssertEqual(history.rows.first?.diastolic, "80")
    }

    func testAUSHeightIsFeetAndInches() throws {
        let engine = try HealthEngine()
        let empty = try record(engine, locale: "en-US", zone: "America/New_York")
        let saved = try XCTUnwrap(engine.blocking { [now] in try $0.apply(.feetInches(feet: 5, inches: 10), to: empty, now: now, deviceId: "test") }.record)
        let profile = try engine.blocking { [now] in try $0.myData(recordJSON: saved, now: now, deviceId: "test") }.profile
        XCTAssertEqual(profile.feetInches, MyData.FeetInches(feet: 5, inches: 10))
        XCTAssertEqual(profile.feetInches?.text, "5 ft 10 in")

        let refused = try engine.blocking { [now] in try $0.apply(.feetInches(feet: 5, inches: 12), to: empty, now: now, deviceId: "test") }
        XCTAssertFalse(refused.ok)
    }

    // MARK: The range picker

    private func day(_ text: String) -> Date { DayText.date(text)! }

    func testOnlyRangesShorterThanTheValuesSpanAreOffered() {
        // Values across three years, the newest months ago: every range fits inside the span.
        let spread = ["2023-10-01", "2025-06-01", "2026-06-01", "2026-09-01"].map(day)
        XCTAssertEqual(ChartRange.offered(for: spread), [.week, .month, .sixMonths, .year, .all])
        // Two days apart: every range would show the same as All.
        let recent = ["2026-10-18", "2026-10-20"].map(day)
        XCTAssertEqual(ChartRange.offered(for: recent), [.all])
        XCTAssertEqual(ChartRange.offered(for: []), [.all])
        // Nine months: a year would hold them all.
        let dense = ["2026-01-01", "2026-09-30", "2026-10-19"].map(day)
        XCTAssertEqual(ChartRange.offered(for: dense), [.week, .month, .sixMonths, .all])
    }

    func testTheWeekStartsSixDaysBeforeItsLastDay() {
        XCTAssertEqual(ChartRange.week.start(ending: day("2026-10-21")), day("2026-10-15"))
        XCTAssertNil(ChartRange.all.start(ending: day("2026-10-21")))
    }

    func testScrubbingPicksTheNearestValue() {
        let dates = ["2026-10-01", "2026-10-10", "2026-10-20"].map(day)
        XCTAssertEqual(ChartRange.nearest(to: day("2026-10-14"), in: dates), day("2026-10-10"))
        XCTAssertEqual(ChartRange.nearest(to: day("2026-12-01"), in: dates), day("2026-10-20"))
        XCTAssertNil(ChartRange.nearest(to: day("2026-10-14"), in: []))
    }

    /// Values spanning less than a week get a week around their middle, not an axis
    /// labelled by the hour (AC17).
    func testValuesWithinAWeekGetAWeekAroundThem() {
        let week = day("2026-08-15")...day("2026-08-21")
        XCTAssertEqual(ChartRange.atLeastAWeek([day("2026-08-18")]), week)
        XCTAssertEqual(ChartRange.atLeastAWeek(["2026-08-18", "2026-08-18"].map(day)), week, "both halves of one blood pressure")
        XCTAssertEqual(ChartRange.atLeastAWeek(["2026-08-18", "2026-08-20"].map(day)), day("2026-08-16")...day("2026-08-22"), "two days apart: a week around their middle")
        XCTAssertNil(ChartRange.atLeastAWeek(["2026-08-18", "2026-09-01"].map(day)), "two weeks apart: the chart's own fit")
        XCTAssertNil(ChartRange.atLeastAWeek([]))
    }
}
