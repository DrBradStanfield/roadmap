import SwiftUI
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
    }

    /// US-25 AC17: a range opens on the newest value, not today.
    func testARangeOpensOnTheNewestValue() {
        let newest = Date(timeIntervalSince1970: 1_792_000_000)
        XCTAssertEqual(ChartRange.month.start(ending: newest), DayText.utc.date(byAdding: .month, value: -1, to: newest))
        XCTAssertEqual(ChartRange.year.start(ending: newest), DayText.utc.date(byAdding: .year, value: -1, to: newest))
    }

    /// US-58 AC3: the engine's My data carries a guide for every metric page and every drug
    /// question, and Swift reads each one's parts and sources.
    func testMyDataCarriesAGuideForEveryMetricAndDrugQuestion_US58() throws {
        let engine = try HealthEngine()
        let empty = try record(engine)
        let shown = try engine.blocking { [now] in try $0.myData(recordJSON: empty, now: now, deviceId: "test") }
        let guides = try XCTUnwrap(shown.guides)
        for row in shown.vitals + shown.bloodTests + [shown.psa] {
            XCTAssertNotNil(guides[row.metric], row.metric)
        }
        for key in ["statin", "ezetimibe", "pcsk9i", "bempedoic_acid", "glp1", "sglt2i", "metformin"] {
            XCTAssertNotNil(guides[key], key)
        }
        XCTAssertNil(guides["statin_escalation"])
        let pressure = try XCTUnwrap(guides[MyData.bloodPressure])
        XCTAssertEqual(pressure.title, "Blood pressure")
        XCTAssertEqual(pressure.howTo.heading, "How to measure")
        XCTAssertFalse(pressure.howTo.points.isEmpty)
        XCTAssertEqual(pressure.sources.first?.url.host(), "doi.org")
    }

    /// US-58 AC4b (2026-10-26): every row opens its page; an empty metric's page has its guide
    /// and no readings ("No data yet", "Add your first value").
    func testAnEmptyMetricOpensAPageWithItsGuide_US58() throws {
        let engine = try HealthEngine()
        let empty = try record(engine)
        let history = try engine.blocking { [now] in try $0.history(recordJSON: empty, metric: "apob", now: now, deviceId: "test") }
        let shown = try engine.blocking { [now] in try $0.myData(recordJSON: empty, now: now, deviceId: "test") }
        XCTAssertTrue(history.rows.isEmpty)
        XCTAssertNotNil(shown.guides?["apob"])
    }

    /// US-58 AC3: one malformed guide is left out, and a malformed map reads as none; My data still draws.
    func testABadGuideNeverBlanksMyData_US58() throws {
        let engine = try HealthEngine()
        let empty = try record(engine)
        let raw = try engine.blocking { [now] in try $0.call("screenJson", [empty, now.formatted(HealthEngine.iso), "test", "{}"]) }
        let answer = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])
        var myData = try XCTUnwrap(answer["myData"] as? [String: Any])
        var guides = try XCTUnwrap(myData["guides"] as? [String: Any])
        guides["weight"] = ["title": "Weight"] // parts missing
        guides["waist"] = 42
        myData["guides"] = guides
        let decoded = try JSONDecoder().decode(MyData.self, from: JSONSerialization.data(withJSONObject: myData))
        XCTAssertNil(decoded.guides?["weight"])
        XCTAssertNil(decoded.guides?["waist"])
        XCTAssertNotNil(decoded.guides?["ldl"])

        myData["guides"] = "not a map"
        let none = try JSONDecoder().decode(MyData.self, from: JSONSerialization.data(withJSONObject: myData))
        XCTAssertEqual(none.guides?.keys, [])
        XCTAssertEqual(none.vitals.map(\.metric), decoded.vitals.map(\.metric))
    }

    /// US-58 AC4: only an https source is a link; any other scheme is shown as text.
    func testOnlyHttpsSourcesAreLinks_US58() throws {
        let decode = { (url: String) in try JSONDecoder().decode(Suggestion.Reference.self, from: Data(#"{"label":"A","url":"\#(url)"}"#.utf8)) }
        XCTAssertEqual(MetricGuide.link(try decode("https://doi.org/10.1/x"))?.host(), "doi.org")
        XCTAssertNil(MetricGuide.link(try decode("http://example.com")))
        XCTAssertNil(MetricGuide.link(try decode("javascript:alert(1)")))
        XCTAssertNil(MetricGuide.link(try decode("tel:123")))
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

    /// US-25 AC17 (Brad 2026-10-25): no All. The picker offers W, M, 6M and Y, a year at
    /// most, as Apple Health's; the page opens on the narrowest range holding every value,
    /// else a year, and scrolls back across the rest.
    func testThePickerStopsAtAYearAndOpensOnTheNarrowestRangeHoldingEveryValue() {
        XCTAssertEqual(ChartRange.allCases, [.week, .month, .sixMonths, .year])
        // Values across three years: a year, scrolled back for the rest.
        let spread = ["2023-10-01", "2025-06-01", "2026-06-01", "2026-09-01"].map(day)
        XCTAssertEqual(ChartRange.opening(for: spread), .year)
        // Nine months: only a year holds them.
        XCTAssertEqual(ChartRange.opening(for: ["2026-01-01", "2026-09-30", "2026-10-19"].map(day)), .year)
        // Seven weeks: six months.
        XCTAssertEqual(ChartRange.opening(for: ["2026-09-01", "2026-10-19"].map(day)), .sixMonths)
        // Two weeks: a month.
        XCTAssertEqual(ChartRange.opening(for: ["2026-10-05", "2026-10-19"].map(day)), .month)
        // Exactly a week, two days, one value, both halves of one blood pressure: a week.
        XCTAssertEqual(ChartRange.opening(for: ["2026-10-15", "2026-10-21"].map(day)), .week)
        XCTAssertEqual(ChartRange.opening(for: ["2026-10-18", "2026-10-20"].map(day)), .week)
        XCTAssertEqual(ChartRange.opening(for: [day("2026-08-18")]), .week)
        XCTAssertEqual(ChartRange.opening(for: ["2026-08-18", "2026-08-18"].map(day)), .week)
        XCTAssertEqual(ChartRange.opening(for: []), .year)
    }

    func testTheWeekStartsSixDaysBeforeItsLastDay() {
        XCTAssertEqual(ChartRange.week.start(ending: day("2026-10-21")), day("2026-10-15"))
    }

    func testScrubbingPicksTheNearestValue() {
        let dates = ["2026-10-01", "2026-10-10", "2026-10-20"].map(day)
        XCTAssertEqual(ChartRange.nearest(to: day("2026-10-14"), in: dates, by: \.self), day("2026-10-10"))
        XCTAssertEqual(ChartRange.nearest(to: day("2026-12-01"), in: dates, by: \.self), day("2026-10-20"))
        XCTAssertNil(ChartRange.nearest(to: day("2026-10-14"), in: [], by: \.self))
    }

    /// US-25 AC17 (Brad 2026-10-23): each metric has its own graph colour, readable as a
    /// line on its card (about 3:1) in light and dark, and no two metrics share one.
    func testEveryMetricHasItsOwnReadableChartColour() {
        for style in [UIUserInterfaceStyle.light, .dark] {
            let traits = UITraitCollection(userInterfaceStyle: style)
            let card = UIColor.secondarySystemGroupedBackground.resolvedColor(with: traits)
            var seen: [String: String] = [:]
            for metric in MetricChart.palette.keys.sorted() {
                for color in MetricChart.colors(for: metric) {
                    let resolved = UIColor(color).resolvedColor(with: traits)
                    XCTAssertGreaterThanOrEqual(UIColor.contrast(resolved, card), 3, "\(metric) in \(style == .dark ? "dark" : "light")")
                    var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
                    resolved.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
                    let key = [red, green, blue].map { String(format: "%.2f", $0) }.joined(separator: ",")
                    XCTAssertNil(seen[key], "\(metric) shares \(seen[key] ?? "")'s colour")
                    seen[key] = metric
                }
            }
        }
        XCTAssertEqual(MetricChart.colors(for: "unknown"), [.accentColor], "an unmapped metric takes the accent colour")
        XCTAssertEqual(MetricChart.colors(for: MyData.bloodPressure).count, 2, "systolic and diastolic")
    }
}

extension UIColor {
    /// WCAG contrast ratio of two resolved colours, 1 to 21.
    static func contrast(_ one: UIColor, _ two: UIColor) -> CGFloat {
        func luminance(_ color: UIColor) -> CGFloat {
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            let linear = { (c: CGFloat) in c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
            return 0.2126 * linear(red) + 0.7152 * linear(green) + 0.0722 * linear(blue)
        }
        let (a, b) = (luminance(one), luminance(two))
        return (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }
}
