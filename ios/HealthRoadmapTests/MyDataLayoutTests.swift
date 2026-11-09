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

    /// US-58 AC7 (Brad 2026-10-31): each Apple Health page (resting heart rate, sleep,
    /// VO2 max, steps) finds its guide in the engine's My data by its snake-case `guideKey`, the
    /// guide `MyDataView` hands `LiveHealthPage` for the foot of the page.
    func testEveryAppleHealthPageFindsItsGuide_US58_AC7() throws {
        let engine = try HealthEngine()
        let empty = try record(engine)
        let shown = try engine.blocking { [now] in try $0.myData(recordJSON: empty, now: now, deviceId: "test") }
        let guides = try XCTUnwrap(shown.guides)
        XCTAssertEqual(LiveMetric.allCases.map(\.guideKey), ["resting_heart_rate", "sleep", "vo2_max", "steps"])
        let titles: [LiveMetric: String] = [.restingHeartRate: "Resting heart rate", .sleep: "Sleep", .vo2Max: "VO2 max", .steps: "Steps"]
        let headings: [LiveMetric: String] = [.restingHeartRate: "How to read it", .sleep: "How to sleep well",
                                              .vo2Max: "How to get a good estimate", .steps: "How to add steps"]
        for metric in LiveMetric.allCases {
            let guide = try XCTUnwrap(guides[metric.guideKey], metric.rawValue)
            XCTAssertEqual(guide.title, titles[metric], metric.rawValue)
            XCTAssertEqual(guide.howTo.heading, headings[metric], metric.rawValue)
            XCTAssertFalse(guide.howTo.points.isEmpty, metric.rawValue)
            XCTAssertFalse(guide.sources.isEmpty, metric.rawValue)
            XCTAssertTrue(guide.sources.allSatisfy { MetricGuide.link($0) != nil }, metric.rawValue)
        }
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

    /// US-62 AC8/AC9: a row reads its target and previous value from the engine (health-core's
    /// rowTarget, never worked out here), and a row from an engine before them reads none.
    func testARowReadsItsTargetAndPreviousValueFromTheEngine_US62() throws {
        let engine = try HealthEngine()
        let now = self.now
        let apply = { (edit: RecordEdit, record: String) throws -> String in
            let outcome = try engine.blocking { [now] in try $0.apply(edit, to: record, now: now, deviceId: "test") }
            XCTAssertTrue(outcome.ok, outcome.message ?? "")
            return try XCTUnwrap(outcome.record)
        }
        var shown = try record(engine)
        shown = try apply(.profile(sex: "male", birthYear: 1970, height: 180), shown)
        shown = try apply(.add(metric: "ldl", value: 2.9, day: "2026-09-01"), shown)
        shown = try apply(.add(metric: "ldl", value: 3.4, day: "2026-10-01"), shown)
        shown = try apply(.add(metric: "hba1c", value: 38, day: "2026-10-01"), shown)
        let saved = shown
        let raw = try engine.blocking { [now] in try $0.call("screenJson", [saved, now.formatted(HealthEngine.iso), "test", "{}"]) }
        var myData = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])?["myData"] as? [String: Any])
        let decoded = try JSONDecoder().decode(MyData.self, from: JSONSerialization.data(withJSONObject: myData))
        let ldl = try XCTUnwrap(decoded.bloodTests.first { $0.metric == "ldl" })
        XCTAssertEqual(ldl.latest?.value, "3.4")
        XCTAssertEqual(ldl.previous, "2.9")
        XCTAssertEqual(ldl.target, "Optimal <1.4")
        XCTAssertNil(decoded.bloodTests.first { $0.metric == "hba1c" }?.previous, "one reading has no previous")

        // An engine before US-62's rows sends neither field: the row draws its date alone.
        let strip = { (rows: Any?) in (rows as? [[String: Any]] ?? []).map { $0.filter { $0.key != "target" && $0.key != "previous" } } }
        myData["bloodTests"] = strip(myData["bloodTests"])
        myData["vitals"] = strip(myData["vitals"])
        let older = try JSONDecoder().decode(MyData.self, from: JSONSerialization.data(withJSONObject: myData))
        let olderLdl = try XCTUnwrap(older.bloodTests.first { $0.metric == "ldl" })
        XCTAssertEqual(olderLdl.latest?.value, "3.4")
        XCTAssertNil(olderLdl.previous)
        XCTAssertNil(olderLdl.target)
    }

    /// US-62 AC8: the section's value column makes room for the widest previous value too, so
    /// a row's bracketed "(74)" never pushes its value out of line.
    func testTheValueColumnHoldsTheWidestPreviousValue_US62() {
        let column = ValueRow.Column([("3.4", "2.9", "mmol/L", nil), ("38", nil, "mmol/mol", nil), (nil, nil, "mmol/L", nil), ("120", "1000", "nmol/L", nil)])
        XCTAssertEqual(column.value, "000")
        XCTAssertEqual(column.previous, "0000")
        XCTAssertEqual(column.unit, "mmol/mol")
        XCTAssertTrue(column.add)
        XCTAssertNil(ValueRow.Column([("3.4", nil, "mmol/L", nil)]).previous)
    }

    /// My data as the engine's one door draws it.
    private func screenMyData(_ engine: HealthEngine, _ record: String) throws -> [String: Any] {
        let now = self.now
        let raw = try engine.blocking { [now] in try $0.call("screenJson", [record, now.formatted(HealthEngine.iso), "test", "{}"]) }
        return try XCTUnwrap((JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])?["myData"] as? [String: Any])
    }

    /// US-62 AC8, US-25 AC17: a row reads its grade and spoken grade from the engine (health-core's
    /// valueStatus and gradeWords, never worked out here); a row from an engine before them reads none.
    func testARowReadsItsGradeFromTheEngine_US62() throws {
        let engine = try HealthEngine()
        let now = self.now
        let apply = { (edit: RecordEdit, record: String) throws -> String in
            let outcome = try engine.blocking { [now] in try $0.apply(edit, to: record, now: now, deviceId: "test") }
            XCTAssertTrue(outcome.ok, outcome.message ?? "")
            return try XCTUnwrap(outcome.record)
        }
        var shown = try record(engine)
        shown = try apply(.profile(sex: "male", birthYear: 1970, height: 180), shown)
        shown = try apply(.add(metric: "ldl", value: 3.4, day: "2026-10-01"), shown)
        shown = try apply(.add(metric: "hba1c", value: 50, day: "2026-10-01"), shown)
        shown = try apply(.add(metric: "hdl", value: 1.3, day: "2026-10-01"), shown)
        var myData = try screenMyData(engine, shown)
        let decoded = try JSONDecoder().decode(MyData.self, from: JSONSerialization.data(withJSONObject: myData))
        let row = { (metric: String) in decoded.bloodTests.first { $0.metric == metric } }
        XCTAssertEqual(row("ldl")?.status, "warn")
        XCTAssertEqual(row("ldl")?.gradeWords, "above optimal")
        XCTAssertEqual(row("hba1c")?.status, "bad")
        XCTAssertEqual(row("hba1c")?.gradeWords, "high")
        XCTAssertEqual(row("hdl")?.status, "ok")
        XCTAssertEqual(row("ldl")?.grade, .warn)
        // A word a newer engine might add reads as no grade, never a decoding failure.
        XCTAssertNil(MyData.Row(metric: "x", label: "X", unit: "", latest: nil, trend: nil, switchable: nil, status: "borderline").grade)
        XCTAssertNil(row("hdl")?.gradeWords, "on target, no words")

        // An engine before the grades sends neither field nor labTests: values draw plain, speak no grade.
        let strip = { (rows: Any?) in (rows as? [[String: Any]] ?? []).map { $0.filter { $0.key != "status" && $0.key != "gradeWords" } } }
        myData["bloodTests"] = strip(myData["bloodTests"])
        myData.removeValue(forKey: "labTests")
        let older = try JSONDecoder().decode(MyData.self, from: JSONSerialization.data(withJSONObject: myData))
        XCTAssertNil(older.bloodTests.first { $0.metric == "ldl" }?.status)
        XCTAssertNil(older.bloodTests.first { $0.metric == "ldl" }?.gradeWords)
        XCTAssertNil(older.labTests, "no lab test rows from an older engine")
    }

    /// US-62 AC8: the web's colours in the app's tones (amber `info`, red `urgent`, the web's
    /// #b91c1c), and VoiceOver's words in the web's order.
    func testAGradeColoursAndSpeaksTheValueAsTheWebDoes_US62() {
        // Each tone resolved to 0xRRGGBB in light and dark: dynamic colours do not compare by value.
        let hex = { (color: Color?) -> [Int] in
            guard let color else { return [] }
            return [UIUserInterfaceStyle.light, .dark].map { style in
                var (r, g, b, a): (CGFloat, CGFloat, CGFloat, CGFloat) = (0, 0, 0, 0)
                UIColor(color).resolvedColor(with: UITraitCollection(userInterfaceStyle: style)).getRed(&r, green: &g, blue: &b, alpha: &a)
                return [r, g, b].reduce(0) { $0 << 8 | Int(($1 * 255).rounded()) }
            }
        }
        XCTAssertEqual(hex(ValueRow.gradeColor(.warn)), hex(Color.status("info")))
        XCTAssertEqual(hex(ValueRow.gradeColor(.bad)), hex(Color.status("urgent")))
        XCTAssertEqual(hex(ValueRow.gradeColor(.bad)).first, 0xB91C1C, "the web's red")
        XCTAssertNil(ValueRow.gradeColor(.ok))
        XCTAssertNil(ValueRow.gradeColor(nil))
        XCTAssertEqual(ValueRow.spoken("3.4", grade: "above optimal", previous: "2.9"), "3.4, above optimal, previous 2.9")
        XCTAssertEqual(ValueRow.spoken("81", grade: nil, previous: "74"), "81, previous 74")
        XCTAssertEqual(ValueRow.spoken("5.2", grade: nil), "5.2")
    }

    /// US-62 AC8 (adversary R2): My data hands a row's grade to the row it draws, and the row draws
    /// its value, as a compact row and as a vital's card, in the grade's colour and says the grade.
    /// SwiftUI builds no accessibility tree for a unit test's window, so the words are checked on
    /// the row's own label function, the one its value's `accessibilityLabel` calls.
    @MainActor
    func testMyDataDrawsAGradedRowInItsColourAndSaysItsGrade_US62() async throws {
        let graded = MyData.Row(metric: "ldl", label: "LDL Cholesterol", unit: "mmol/L", latest: .init(id: "a", value: "4.2", day: "2026-10-01"),
                                trend: nil, switchable: true, previous: "2.9", status: "bad", gradeWords: "high")
        var plain = graded
        plain.status = nil
        plain.gradeWords = nil
        let row = MyDataView.valueRow(graded, tint: .blue)
        XCTAssertEqual(row.grade, .bad)
        XCTAssertEqual(row.spokenLabel("4.2", previous: "2.9"), "4.2, high, previous 2.9")
        XCTAssertEqual(MyDataView.valueRow(plain, tint: .blue).spokenLabel("4.2", previous: "2.9"), "4.2, previous 2.9")
        for card in [false, true] {
            let red = try await drawsRed(MyDataView.valueRow(graded, tint: .blue, card: card))
            XCTAssertTrue(red, "the graded value is drawn red (card: \(card))")
            let none = try await drawsRed(MyDataView.valueRow(plain, tint: .blue, card: card))
            XCTAssertFalse(none, "an ungraded value is drawn plain (card: \(card))")
        }
    }

    /// US-62 AC8a (Brad 2026-11-09): a trend's vertical range is at least ±5% of the latest value,
    /// so 0.57 to 0.58 draws nearly flat while a real change fills the line. The same cases as
    /// health-core's trend-range.test.ts, which tests the web's `trendRange`.
    func testATrendsRangeIsAtLeastFivePercentEachWay_US62_AC8a() {
        let fill = { (points: [Double]) in
            let (low, high) = Sparkline.range(points)
            return (points.max()! - points.min()!) / (high - low)
        }
        let waist = Sparkline.range([0.57, 0.58])
        XCTAssertEqual(waist.high - waist.low, 0.058, accuracy: 1e-9, "±5% of 0.58")
        XCTAssertEqual((waist.low + waist.high) / 2, 0.575, accuracy: 1e-9, "about the points' middle")
        XCTAssertLessThan(fill([0.57, 0.58]), 0.2, "a tiny change draws nearly flat")
        XCTAssertTrue(Sparkline.range([100, 92, 85]) == (85, 100), "a real change keeps its full height")
        XCTAssertEqual(fill([100, 92, 85]), 1)
        let a1c = Sparkline.range([42, 41]), rising = Sparkline.range([41, 42])
        XCTAssertEqual(a1c.high - a1c.low, 4.1, accuracy: 1e-9, "read from the latest point")
        XCTAssertEqual(rising.high - rising.low, 4.2, accuracy: 1e-9)
        XCTAssertTrue(Sparkline.range([5, 5, 5]) == (4.75, 5.25), "equal points across the middle")
        XCTAssertTrue(Sparkline.range([0, 0]) == (-0.5, 0.5), "all zeros over a span of one")
    }

    /// US-62 AC8a: the band a row's trend is drawn over is its ink, capped at 0.8 x its width and
    /// centred, the web's `trendBand`. While the baselines arrive one at a time it can be no band
    /// at all (the last above the first), and then there is none: a backwards range would trap.
    func testARowsTrendBandIsCappedAndCentred_US62_AC8a() throws {
        XCTAssertEqual(ValueRow.trendBand(capTop: 5, baseline: 32, width: 56), 5...32)
        let capped = try XCTUnwrap(ValueRow.trendBand(capTop: 5, baseline: 85, width: 56))
        XCTAssertEqual(capped.upperBound - capped.lowerBound, 44.8, accuracy: 1e-9)
        XCTAssertEqual((capped.lowerBound + capped.upperBound) / 2, 45, accuracy: 1e-9, "centred on the ink")
        XCTAssertNil(ValueRow.trendBand(capTop: 30, baseline: 10, width: 56), "the last baseline not yet read")
        XCTAssertNil(ValueRow.trendBand(capTop: 17 - 12, baseline: 0, width: 56), "only the first baseline read")
        XCTAssertNil(ValueRow.trendBand(capTop: 5, baseline: 9, width: 56), "no room inside the padding")
        XCTAssertNil(ValueRow.trendBand(capTop: 5, baseline: .nan, width: 56))
    }

    /// US-62 AC8a, #1002 R1: under Bold Text the label draws bold, so the room its longest word asks
    /// for (which decides whether the trend keeps its place) is measured bold. Measured regular, a
    /// word that only just fit could break mid-word at XL to XXXL. (The cap height comes from the same
    /// font, but San Francisco's is the same in both weights, so there is nothing to assert there.)
    func testARowMeasuresItsLabelBoldUnderBoldText_US62_AC8a() {
        for size in [DynamicTypeSize.xLarge, .xxLarge, .xxxLarge] {
            let regular = ValueRow.bodyFont(size, .regular), bold = ValueRow.bodyFont(size, .bold)
            XCTAssertEqual(ValueRow.bodyFont(size, nil).fontName, regular.fontName, "no setting measures regular")
            XCTAssertGreaterThan(ValueRow.longestWord("Triglycerides", font: bold), ValueRow.longestWord("Triglycerides", font: regular), "\(size)")
        }
        let font = ValueRow.bodyFont(.xxxLarge, .bold)
        XCTAssertEqual(ValueRow.longestWord("Apolipoprotein-B level", font: font),
                       ceil(("Apolipoprotein-" as NSString).size(withAttributes: [.font: font]).width), "a hyphen ends a word")
    }

    /// US-12 AC21: a value printed as a limit the rule leaves ungraded says the web's note where its
    /// grade would be; an older engine sends none.
    @MainActor
    func testAnUngradedLimitSaysTheNoteInTheGradesPlace_US12() throws {
        let note = "Printed as a limit, so the plan cannot grade it against its cutoff."
        let row = MyData.Row(metric: "weight", label: "Weight", unit: "kg", latest: .init(id: "a", value: "> 78.0", day: "2026-10-15"),
                             trend: nil, switchable: true, previous: "80.0", note: note)
        XCTAssertEqual(MyDataView.valueRow(row, tint: .blue).spokenLabel("> 78.0", previous: "80.0"), "> 78.0, \(note), previous 80.0")
        let older = try JSONDecoder().decode(MyData.Row.self, from: Data(#"{"metric":"weight","label":"Weight","unit":"kg","latest":null,"trend":null,"switchable":true}"#.utf8))
        XCTAssertNil(older.note)
    }

    /// Whether `view`, drawn in light mode, has a red pixel: the red channel well above the
    /// other two. (The drawn bytes are colour-managed, so an exact hex never matches.)
    @MainActor
    private func drawsRed(_ view: some View) async throws -> Bool {
        let scene = try XCTUnwrap(UIApplication.shared.connectedScenes.first as? UIWindowScene)
        let window = UIWindow(windowScene: scene)
        window.frame = CGRect(x: 0, y: 0, width: 402, height: 200)
        window.overrideUserInterfaceStyle = .light
        window.rootViewController = UIHostingController(rootView: view.padding())
        window.makeKeyAndVisible()
        defer { window.isHidden = true }
        try await Task.sleep(for: .seconds(1))
        let image = UIGraphicsImageRenderer(bounds: window.bounds).image { _ in
            window.drawHierarchy(in: window.bounds, afterScreenUpdates: true)
        }
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return false }
        let (row, step) = (cg.bytesPerRow, cg.bitsPerPixel / 8)
        let red = cg.bitmapInfo.contains(.byteOrder32Little) ? 2 : 0 // BGRA or RGBA
        for y in 0..<cg.height {
            for x in 0..<cg.width {
                let pixel = (0..<3).map { Int(bytes[y * row + x * step + $0]) }
                if pixel[red] - max(pixel[1], pixel[2 - red]) > 80 { return true }
            }
        }
        return false
    }

    /// US-62 AC8, US-25 AC17: the lab tests beyond the core ones come from the engine as rows, with
    /// the web's label, "Ref" target, newest and previous value and unit.
    func testLabTestRowsComeFromTheEngine_US62() throws {
        let engine = try HealthEngine()
        var file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try record(engine).utf8)) as? [String: Any])
        let lab = { (id: String, name: String, value: Double, unit: String, day: String, low: Double?, high: Double?) -> [String: Any] in
            ["id": id, "metricName": name, "value": value, "unit": unit,
             "referenceLow": low.map { $0 as Any } ?? NSNull(), "referenceHigh": high.map { $0 as Any } ?? NSNull(),
             "recordedAt": "\(day)T00:00:00.000Z", "createdAt": "\(day)T00:00:00.000Z", "source": "manual", "status": "active", "correctsId": NSNull()]
        }
        file["labValues"] = [lab("f1", "ferritin", 80, "µg/L", "2026-09-01", 30, 400), lab("f2", "ferritin", 112, "µg/L", "2026-10-01", 30, 500),
                             lab("s1", "sodium", 140, "mmol/L", "2026-10-01", nil, 145)]
        let text = String(decoding: try JSONSerialization.data(withJSONObject: file), as: UTF8.self)
        let decoded = try JSONDecoder().decode(MyData.self, from: JSONSerialization.data(withJSONObject: try screenMyData(engine, text)))
        let labs = try XCTUnwrap(decoded.labTests)
        XCTAssertEqual(labs.map(\.label), ["Sodium", "Ferritin"])
        XCTAssertEqual(labs[1].target, "Ref 30–500")
        XCTAssertEqual(labs[1].latest?.value, "112")
        XCTAssertEqual(labs[1].previous, "80")
        XCTAssertEqual(labs[1].unit, "µg/L")
        XCTAssertEqual(labs[0].target, "Ref <145")
        XCTAssertNil(labs[0].previous)
        XCTAssertNil(labs[0].status, "a lab test is never graded")
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
