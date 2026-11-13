import XCTest
@testable import HealthRoadmap

/// US-25 AC8/AC9: the medication, screening and supplement questions and the
/// value history, run in JavaScriptCore, decode in Swift and write through
/// the web's own functions (ios/engine/my-data.test.ts holds the same cases in Node).
final class FormEditTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    /// A 60-year-old man, 180 cm, metric, with an ApoB over target: screening and the cholesterol cascade apply.
    private func man60(_ engine: HealthEngine) throws -> String {
        var record = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        for edit: RecordEdit in [.profile(sex: "male", birthYear: 1966, birthMonth: 1, height: 180), .add(metric: "apob", value: 1.3, day: "2026-10-01")] {
            record = try saved(engine, edit, record)
        }
        return record
    }

    private func saved(_ engine: HealthEngine, _ edit: RecordEdit, _ record: String) throws -> String {
        let outcome = try engine.blocking { [now] in try $0.apply(edit, to: record, now: now, deviceId: "test") }
        XCTAssertTrue(outcome.ok, outcome.message ?? "")
        return try XCTUnwrap(outcome.record)
    }

    private func object(_ record: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any])
    }

    func testTheFormsDecodeWithTheWebsQuestions() throws {
        let engine = try HealthEngine()
        let start = try man60(engine)
        let data = try engine.blocking { [now] in try $0.myData(recordJSON: start, now: now, deviceId: "test") }
        XCTAssertEqual(data.screenings.first?.groups.map(\.id), ["colorectal", "lung", "prostate"])
        XCTAssertEqual(data.medications.map(\.title), ["Cholesterol Medications"])
        guard case .choice(let key, let label, let hint, let options, _) = data.medications[0].groups[0].fields[0] else { return XCTFail("statin is a choice") }
        XCTAssertEqual(key, "statin")
        XCTAssertEqual(label, "Statin")
        XCTAssertNotNil(hint)
        XCTAssertTrue(options.contains { $0.value == "atorvastatin" })
        XCTAssertNil(data.screeningNote)
        XCTAssertEqual(data.months.past.last, "2026-10")
        XCTAssertEqual(data.supplements.choices.first?.featured, true)
    }

    func testAMedicationAnswerWritesTheWebsRow() throws {
        let engine = try HealthEngine()
        let record = try saved(engine, .form(.medicationField(field: "statin", value: "atorvastatin")), try man60(engine))
        let meds = try XCTUnwrap(try object(record)["medications"] as? [[String: Any]])
        XCTAssertEqual(meds.first?["drugName"] as? String, "atorvastatin")
        XCTAssertEqual(meds.first?["doseValue"] as? Double, 10)
    }

    func testAnAnswerTheFormDoesNotOfferIsRefused() throws {
        let engine = try HealthEngine()
        let start = try man60(engine)
        let outcome = try engine.blocking { [now] in try $0.apply(.form(.medicationField(field: "statin", value: "aspirin")), to: start, now: now, deviceId: "test") }
        XCTAssertFalse(outcome.ok)
        XCTAssertNil(outcome.record)
    }

    func testAScreeningAnswerAndItsClearingChain() throws {
        let engine = try HealthEngine()
        var record = try man60(engine)
        record = try saved(engine, .form(.screening(key: "colorectal_method", value: "fit_annual")), record)
        record = try saved(engine, .form(.screening(key: "colorectal_last_date", value: "2025-03")), record)
        record = try saved(engine, .form(.screening(key: "colorectal_method", value: "not_yet_started")), record)
        let screenings = try XCTUnwrap(try object(record)["screenings"] as? [String: Any])
        XCTAssertEqual(screenings["colorectalMethod"] as? String, "not_yet_started")
        XCTAssertEqual((screenings["colorectalLastDate"] as? String) ?? "", "")
    }

    func testASupplementIsAddedThenSoftStopped() throws {
        let engine = try HealthEngine()
        var record = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        record = try saved(engine, .form(.customSupplement(name: "Lion's Mane")), record)
        record = try saved(engine, .form(.supplement(key: "custom_lion_s_mane", name: "Lion's Mane", dose: 500, unit: "mg", stopped: true)), record)
        let data = try engine.blocking { [now] in try $0.myData(recordJSON: record, now: now, deviceId: "test") }
        XCTAssertEqual(data.supplements.active, [])
        XCTAssertEqual(data.supplements.stopped.map(\.name), ["Lion's Mane"])
        XCTAssertEqual(data.supplements.stopped.first?.dose, 500)
    }

    /// US-73 AC10b (break-test 2026-11-06): a stopped row says the phone's day it stopped, never
    /// "Since" its start; an active one says since when, on the phone's day.
    func testAStoppedSupplementSaysTheDayItStopped_US73_AC10b() throws {
        let engine = try HealthEngine()
        var record = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        record = try saved(engine, .form(.customSupplement(name: "Lion's Mane")), record)
        let today = DayText.iso(now)
        var data = try engine.blocking { [now] in try $0.myData(recordJSON: record, now: now, deviceId: "test") }
        let active = try XCTUnwrap(data.supplements.active.first)
        XCTAssertEqual(active.dayLine(stopped: false), "Since \(DayText.short(today))")
        record = try saved(engine, .form(.supplement(key: "custom_lion_s_mane", name: "Lion's Mane", dose: nil, unit: nil, stopped: true)), record)
        data = try engine.blocking { [now] in try $0.myData(recordJSON: record, now: now, deviceId: "test") }
        let stopped = try XCTUnwrap(data.supplements.stopped.first)
        XCTAssertEqual(stopped.stoppedDay, today)
        XCTAssertEqual(stopped.dayLine(stopped: true), "Stopped \(DayText.short(today))")
        let noStopDay = SupplementsView.Row(key: "k", name: "n", dose: nil, unit: nil, startedDay: today, stoppedDay: nil)
        XCTAssertEqual(noStopDay.dayLine(stopped: true), "Stopped", "an engine before stoppedDay, or no stop recorded")
    }

    /// Adversary R1: a dose past Int's range (the schema has no upper bound) must print, not trap on every launch.
    func testAHugeDoseOrNumberPrintsWithoutTrapping() {
        XCTAssertEqual(SupplementSheet.doseText(5), "5")
        XCTAssertEqual(SupplementSheet.doseText(2.5), "2.5")
        XCTAssertEqual(SupplementSheet.doseText(1e20), "1e+20")
        XCTAssertEqual(SupplementSheet.doseText(.infinity), "inf")
    }

    /// US-58 AC4b, AC4c (S25): a failed read never says "No data yet" over values still in the
    /// record, which invited a duplicate; it says so and offers Try again. With no value drawn there
    /// is nothing to duplicate, so "No data yet" and Add sit beside Try again (Brad, 14 Nov). A read
    /// that came back empty still says it, and it never flashes on a metric with readings while read.
    func testAFailedReadNeverSaysNoDataYet_US58() throws {
        let page = { (read: MetricRead.Read, hasReadings: Bool) in
            MetricReadTests.named(MetricRead.page(read, revision: 1, problem: nil, kept: nil, hasReadings: hasReadings, screenHasReading: hasReadings))
        }
        let failed = MetricRead.transition(.reading(revision: 1), .landed(revision: 1, nil))
        XCTAssertEqual(page(failed, true), "failed: still in record", "the engine threw on a metric with values")
        XCTAssertEqual(page(failed, false), "failed: No data yet", "no value drawn: Add beside Try again")
        let empty = MetricRead.transition(.reading(revision: 1), .landed(revision: 1, try MetricReadTests.chart([])))
        XCTAssertEqual(page(empty, true), "No data yet", "the read came back empty")
        XCTAssertEqual(page(.reading(revision: 1), true), "guide only", "reading: the guide only")
        XCTAssertEqual(page(.reading(revision: 1), false), "No data yet", "nothing to read")
    }

    func testHistoryKeepsTheCorrectedValueStruckNotRemoved() throws {
        let engine = try HealthEngine()
        var record = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        record = try saved(engine, .add(metric: "weight", value: 82, day: "2026-10-01"), record)
        let wrong = try XCTUnwrap(engine.blocking { [now] in try $0.myData(recordJSON: record, now: now, deviceId: "test") }.vitals.first?.latest?.id)
        record = try saved(engine, .correct(id: wrong, value: 81), record)
        let history = try engine.blocking { [now] in try $0.history(recordJSON: record, metric: "weight", now: now, deviceId: "test") }
        XCTAssertEqual(history.rows.map(\.value), ["81.0", "82.0"])
        XCTAssertEqual(history.rows.map(\.isActive), [true, false])
        XCTAssertEqual(history.rows.map(\.current), [true, false])
    }

    /// US-25 AC9b (Brad 2026-10-30): a statin start marks the LDL page as the web's chart does, on
    /// its day, and widens the chart to it; a page no medication affects gets none.
    func testAStatinStartMarksTheCholesterolPagesOnly_US25AC9b() throws {
        let engine = try HealthEngine()
        var record = try saved(engine, .add(metric: "ldl", value: 3.4, day: "2026-09-01"), try man60(engine))
        record = try saved(engine, .add(metric: "weight", value: 80, day: "2026-09-01"), record)
        record = try saved(engine, .form(.medicationField(field: "statin", value: "atorvastatin")), record)
        let ldl = try engine.blocking { [now] in try $0.history(recordJSON: record, metric: "ldl", now: now, deviceId: "test") }
        XCTAssertEqual(ldl.medicationMarkers.map(\.label), ["Recorded start: Atorvastatin 10mg"])
        // The change's day is this Mac's own day of `now`, in any zone (adversary R4).
        let day = DayText.iso(now)
        XCTAssertEqual(ldl.medicationMarkers.map(\.day), [day])
        let chart = ChartData(ldl)
        XCTAssertEqual(chart.markers.map(\.date), [DayText.date(day)])
        XCTAssertEqual(chart.last, DayText.date(day), "the range reaches the change, as the web's does")
        XCTAssertEqual(chart.days, [DayText.date("2026-09-01")], "a scrub still picks only values")
        for metric in ["weight", "hdl", MyData.bloodPressure] {
            let other = try engine.blocking { [now] in try $0.history(recordJSON: record, metric: metric, now: now, deviceId: "test") }
            XCTAssertEqual(other.medicationMarkers, [], metric)
        }
    }

    /// US-25 AC9b: markers are read leniently. An older engine sends none; a bad marker is left out;
    /// a list that is not a list reads as none; the values still draw.
    func testMarkersDecodeLeniently_US25AC9b() throws {
        let base = #""metric":"ldl","label":"LDL","unit":"mmol/L","excluded":false,"rows":[{"id":"r","value":"3.4","day":"2026-09-01","status":"active","current":true,"correction":false}]"#
        let decode = { (extra: String) in try JSONDecoder().decode(MetricHistory.self, from: Data("{\(base)\(extra)}".utf8)) }
        XCTAssertEqual(try decode("").medicationMarkers, [])
        let mixed = try decode(#","markers":[{"id":"a","day":"2026-10-01","label":"Recorded start: Statin"},{"id":"b","day":3},"x"]"#)
        XCTAssertEqual(mixed.medicationMarkers.map(\.id), ["a"])
        let bad = try decode(#","markers":"not a list""#)
        XCTAssertEqual(bad.medicationMarkers, [])
        XCTAssertEqual(bad.rows.map(\.value), ["3.4"])
        // A day the app cannot read draws no rule.
        XCTAssertEqual(ChartData(try decode(#","markers":[{"id":"a","day":"soon","label":"L"}]"#)).markers, [])
    }

    /// US-12 AC20: an LDL printed "< 2" on a lab report is saved as a limit. My data and the
    /// history say it with its symbol, the card's trend leaves it out, and the chart plots it at
    /// its bound, hollow, out of the line. The plan cannot grade "< 2" against 1.4, so it says so.
    func testALabLimitReadsAsPrintedAndPlotsHollowAtItsBound_US12AC20() throws {
        let engine = try HealthEngine()
        var record = try saved(engine, .add(metric: "ldl", value: 3.1, day: "2026-09-01"), try man60(engine))
        record = try saved(engine, .add(metric: "ldl", value: 2.9, day: "2026-09-15"), record)
        let extraction = #"{"classification":"lab_report","reportDate":"2026-10-01","values":[{"metric":"ldl","valueSI":2,"displayValue":2,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high","comparator":"<"}]}"#
        record = try saved(engine, .labImport(extractionJSON: extraction, refs: ["v0"], reportDay: "2026-10-01"), record)

        let ldl = try XCTUnwrap(engine.blocking { [now] in try $0.myData(recordJSON: record, now: now, deviceId: "test") }.bloodTests.first { $0.metric == "ldl" })
        XCTAssertEqual(ldl.latest?.value, "< 2.0")
        XCTAssertEqual(ldl.trend, [3.1, 2.9], "a limit is no point on the card's trend")

        let history = try engine.blocking { [now] in try $0.history(recordJSON: record, metric: "ldl", now: now, deviceId: "test") }
        XCTAssertEqual(history.rows.map(\.value), ["< 2.0", "2.9", "3.1"])
        XCTAssertEqual(history.rows.map(\.bound), [2, nil, nil])
        XCTAssertEqual(history.rows.first?.note, "Printed as a limit, so the plan cannot grade it against its cutoff.")

        let points = ChartData(history).points
        XCTAssertEqual(points.map(\.value), [2, 2.9, 3.1], "the limit is plotted at its bound")
        XCTAssertEqual(points.map(\.limit), [true, false, false])
        XCTAssertEqual(points.first?.label, "< 2.0", "VoiceOver reads it as printed")
    }

    /// US-12 AC20: an older engine sends no bound, so a limit's text is no number: the point is
    /// left off the chart, never plotted as an exact value, and the page still draws.
    func testALimitFromAnOlderEngineIsLeftOffTheChart_US12AC20() throws {
        let json = #"{"metric":"ldl","label":"LDL","unit":"mmol/L","excluded":false,"rows":[{"id":"l","value":"< 2.0","day":"2026-10-01","status":"active","current":true,"correction":false},{"id":"e","value":"2.9","day":"2026-09-15","status":"active","current":false,"correction":false}]}"#
        let history = try JSONDecoder().decode(MetricHistory.self, from: Data(json.utf8))
        XCTAssertEqual(ChartData(history).points.map(\.id), ["e"])
        XCTAssertNil(history.rows.first?.note)
    }

    /// US-07 AC1j: a month field carries the engine's `min` (colorectal's follow-up date: the last screening's
    /// month); an older engine sends none. The picker's filter on it sits in FormFieldRow's view body, out of a test's reach.
    func testAMonthFieldDecodesItsMin_US07AC1j() throws {
        let decode = { (extra: String) in try JSONDecoder().decode(FormField.self, from: Data(#"{"kind":"month","key":"colorectal_followup_date","label":"Date","value":"","when":"past"\#(extra)}"#.utf8)) }
        XCTAssertEqual(try decode(#","min":"2025-11""#), .month(key: "colorectal_followup_date", label: "Date", value: "", future: false, min: "2025-11"))
        XCTAssertEqual(try decode(""), .month(key: "colorectal_followup_date", label: "Date", value: "", future: false, min: nil))
    }
}
