import XCTest
@testable import HealthRoadmap

/// US-25 AC25: a lab test's page. Its history comes through the history door with series "lab", and
/// a value is added (`labAdd`) and corrected (`correct`) by the engine's writes, the web's own. The
/// engine runs in JavaScriptCore here, as on the phone; the rules are tested in Node in
/// ios/engine/lab-page.test.ts. Synthetic values.
final class LabPageTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    /// A new record with lab rows added to its JSON.
    private func record(_ engine: HealthEngine, labs: [[String: Any]]) throws -> String {
        let fresh = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        var file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(fresh.utf8)) as? [String: Any])
        file["labValues"] = labs
        return String(decoding: try JSONSerialization.data(withJSONObject: file), as: UTF8.self)
    }

    private func lab(_ id: String, _ name: String, _ value: Double, _ unit: String, _ day: String, extra: [String: Any] = [:]) -> [String: Any] {
        ["id": id, "metricName": name, "value": value, "unit": unit, "referenceLow": NSNull(), "referenceHigh": NSNull(),
         "recordedAt": "\(day)T00:00:00.000Z", "createdAt": "\(day)T09:00:00.000Z", "source": "lab_import", "status": "active", "correctsId": NSNull()]
            .merging(extra) { $1 }
    }

    func testALabTestsHistoryComesThroughTheHistoryDoor_US25_AC25() throws {
        let engine = try HealthEngine()
        let text = try record(engine, labs: [lab("f1", "ferritin", 80, "µg/L", "2026-09-01"), lab("f2", "ferritin", 20, "µg/L", "2026-10-01", extra: ["comparator": "<"])])
        let now = self.now
        let history = try engine.blocking { [now] in try $0.history(recordJSON: text, metric: "ferritin", now: now, deviceId: "test", series: "lab") }
        XCTAssertEqual(history.label, "Ferritin")
        XCTAssertEqual(history.unit, "µg/L")
        XCTAssertEqual(history.rows.map(\.value), ["< 20", "80"])
        XCTAssertEqual(history.rows.first?.bound, 20, "a limit carries its bound, drawn hollow")
        XCTAssertNil(history.unitsNote)
        XCTAssertEqual(ChartPoint.points(history).map(\.limit), [true, false])
    }

    func testASeriesInMoreThanOneUnitListsEachUnitAndDrawsNoChart_US25_AC25() throws {
        let engine = try HealthEngine()
        let text = try record(engine, labs: [lab("z1", "zinc_custom", 12, "µmol/L", "2026-09-01"), lab("z2", "zinc_custom", 80, "µg/dL", "2026-10-01")])
        let now = self.now
        let history = try engine.blocking { [now] in try $0.history(recordJSON: text, metric: "zinc custom", now: now, deviceId: "test", series: "lab") }
        XCTAssertEqual(history.rows.map(\.unit), ["µg/dL", "µmol/L"])
        XCTAssertTrue(ChartPoint.points(history).isEmpty)
        XCTAssertEqual(MetricDetailView.noChart(history), "Units vary between reports (µmol/L, µg/dL), so this test is not charted.")
    }

    func testAddingAndCorrectingALabValueGoThroughTheEngine_US25_AC25() throws {
        let engine = try HealthEngine()
        let text = try record(engine, labs: [lab("f1", "ferritin", 80, "µg/L", "2026-09-01")])
        let now = self.now
        let added = try engine.blocking { [now] in try $0.apply(.labAdd(series: "ferritin", value: 110, day: "2026-10-10", unit: "µg/L"), to: text, now: now, deviceId: "test") }
        XCTAssertTrue(added.ok, added.message ?? "")
        let taken = try engine.blocking { [now] in try $0.apply(.labAdd(series: "ferritin", value: 85, day: "2026-09-01", unit: "µg/L"), to: text, now: now, deviceId: "test") }
        XCTAssertFalse(taken.ok)
        XCTAssertEqual(taken.reason, "slot-occupied")
        XCTAssertEqual(taken.existingId, "f1", "the row a replace corrects")
        let corrected = try engine.blocking { [now] in try $0.apply(.labCorrect(id: "f1", value: 85), to: text, now: now, deviceId: "test") }
        let record = try XCTUnwrap(corrected.record)
        let history = try engine.blocking { [now] in try $0.history(recordJSON: record, metric: "ferritin", now: now, deviceId: "test", series: "lab") }
        XCTAssertEqual(history.rows.map(\.value), ["85", "80"])
        XCTAssertEqual(history.rows.map(\.status), ["active", "entered-in-error"])
        XCTAssertEqual(history.rows.map(\.correction), [true, false])
    }

    func testALabAddEncodesAsTheEngineReadsIt_US25_AC25() throws {
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(RecordEdit.labAdd(series: "ferritin", value: 110, day: "2026-10-10", unit: "µg/L"))) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "labAdd")
        XCTAssertEqual(json["series"] as? String, "ferritin")
        XCTAssertEqual(json["value"] as? Double, 110)
        XCTAssertEqual(json["day"] as? String, "2026-10-10")
        XCTAssertEqual(json["unit"] as? String, "µg/L", "the unit the sheet showed (review R3)")
        let correction = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(RecordEdit.labCorrect(id: "f1", value: 85))) as? [String: Any])
        XCTAssertEqual(correction["kind"] as? String, "correct", "the engine's own correction")
    }

    /// Review R1: a lab test named like a core metric is its own row, page and history, never the
    /// core metric's: by origin (`series`), never by name.
    func testALabTestNamedWeightIsNotTheCoreWeight_US25_AC25() throws {
        let engine = try HealthEngine()
        let now = self.now
        var text = try record(engine, labs: [lab("w1", "Weight", 70, "kg", "2026-09-01")])
        let core = try engine.blocking { [now] in try $0.apply(.add(metric: "weight", value: 80, day: "2026-09-01"), to: text, now: now, deviceId: "test") }
        text = try XCTUnwrap(core.record)
        let saved = text
        let raw = try engine.blocking { [now] in try $0.call("screenJson", [saved, now.formatted(HealthEngine.iso), "test", "{}"]) }
        let myData = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])?["myData"] as? [String: Any])
        let decoded = try JSONDecoder().decode(MyData.self, from: JSONSerialization.data(withJSONObject: myData))
        let labRow = try XCTUnwrap(decoded.labTests?.first { $0.metric == "weight" })
        let coreRow = try XCTUnwrap(decoded.vitals.first { $0.metric == "weight" })
        XCTAssertEqual(labRow.series, "lab")
        XCTAssertNil(coreRow.series)
        XCTAssertNotEqual(labRow.id, coreRow.id, "distinct SwiftUI ids")
        XCTAssertNotEqual(RecordStore.historyKey(labRow.metric, labRow.series), RecordStore.historyKey(coreRow.metric, coreRow.series), "distinct kept histories")
        let labHistory = try engine.blocking { [now] in try $0.history(recordJSON: saved, metric: "weight", now: now, deviceId: "test", series: labRow.series) }
        let coreHistory = try engine.blocking { [now] in try $0.history(recordJSON: saved, metric: "weight", now: now, deviceId: "test", series: coreRow.series) }
        XCTAssertEqual(labHistory.rows.map(\.id), ["w1"])
        XCTAssertNotEqual(coreHistory.rows.map(\.id), ["w1"])
        // Each page's "+" writes its own table.
        let added = try engine.blocking { [now] in try $0.apply(.labAdd(series: labRow.metric, value: 71, day: "2026-10-01", unit: labRow.unit), to: saved, now: now, deviceId: "test") }
        let after = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(added.record).utf8)) as? [String: Any])
        XCTAssertEqual((after["labValues"] as? [Any])?.count, 2)
        XCTAssertEqual((after["measurements"] as? [Any])?.count, 1)
    }

    /// Review R2: a correction is labelled, hinted and saved in the tapped row's own unit.
    func testACorrectionUsesTheTappedRowsOwnUnit_US25_AC25() throws {
        let engine = try HealthEngine()
        let now = self.now
        let text = try record(engine, labs: [lab("z1", "zinc_custom", 12, "µmol/L", "2026-08-01"), lab("z2", "zinc_custom", 80, "µg/dL", "2026-09-01")])
        let history = try engine.blocking { [now] in try $0.history(recordJSON: text, metric: "zinc custom", now: now, deviceId: "test", series: "lab") }
        let older = try XCTUnwrap(history.rows.first { $0.id == "z1" })
        let shown = MyData.Row(metric: "zinc custom", label: "Zinc Custom", unit: "µg/dL", latest: nil, trend: nil, switchable: false, series: "lab")
        XCTAssertEqual(MetricDetailView.correctionUnit(older, shown: shown, lpaUnit: nil), "µmol/L")
        let corrected = try engine.blocking { [now] in try $0.apply(.labCorrect(id: "z1", value: 13), to: text, now: now, deviceId: "test") }
        let record = try XCTUnwrap(corrected.record)
        let after = try engine.blocking { [now] in try $0.history(recordJSON: record, metric: "zinc custom", now: now, deviceId: "test", series: "lab") }
        XCTAssertEqual(after.rows.first { $0.value == "13" }?.unit, "µmol/L", "saved in µmol/L")
    }

    /// Review R5: exact lab values chart at their own numbers, not their rounded text.
    func testSmallLabValuesPlotApart_US25_AC25() throws {
        let engine = try HealthEngine()
        let now = self.now
        let text = try record(engine, labs: [lab("t1", "tsh", 0.001, "mIU/L", "2026-08-01"), lab("t2", "tsh", 0.004, "mIU/L", "2026-09-01")])
        let history = try engine.blocking { [now] in try $0.history(recordJSON: text, metric: "tsh", now: now, deviceId: "test", series: "lab") }
        XCTAssertEqual(ChartPoint.points(history).map(\.value).sorted(), [0.001, 0.004])
    }

    /// Review R7: a lab correction does not hang on the record's units.
    func testALabCorrectionDoesNotDependOnTheRecordsUnits_US25_AC25() {
        XCTAssertFalse(RecordStore.dependsOnUnits(.labCorrect(id: "f1", value: 1)))
        XCTAssertFalse(RecordStore.dependsOnUnits(.labAdd(series: "ferritin", value: 1, day: "2026-10-01", unit: "µg/L")))
        XCTAssertTrue(RecordStore.dependsOnUnits(.correct(id: "w1", value: 1)))
    }

    /// Review N1: a lab test filed as "lpa" (mg/dL) is read in its own unit, never the record's
    /// Lp(a) unit (nmol/L): its add and correction show and save mg/dL, and its page has no Lp(a)
    /// picker. A lab test filed as "HDL" shows no core HDL guide.
    func testALabTestNamedLikeACoreMetricUsesNoneOfItsUnitsGuideOrRange_US25_AC25() throws {
        let engine = try HealthEngine()
        let now = self.now
        var text = try record(engine, labs: [lab("a1", "lpa", 40, "mg/dL", "2026-09-01"), lab("h1", "HDL", 1.3, "mmol/L", "2026-09-01")])
        let unit = try engine.blocking { [now] in try $0.apply(.lpaUnit("nmol/L"), to: text, now: now, deviceId: "test") }
        text = try XCTUnwrap(unit.record)
        let saved = text
        let raw = try engine.blocking { [now] in try $0.call("screenJson", [saved, now.formatted(HealthEngine.iso), "test", "{}"]) }
        let myData = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(raw.utf8)) as? [String: Any])?["myData"] as? [String: Any])
        let decoded = try JSONDecoder().decode(MyData.self, from: JSONSerialization.data(withJSONObject: myData))
        XCTAssertEqual(decoded.lpaUnit, "nmol/L")
        let labLpa = try XCTUnwrap(decoded.labTests?.first { $0.metric == "lpa" })
        let coreLpa = try XCTUnwrap(decoded.bloodTests.first { $0.metric == "lpa" })
        XCTAssertEqual(labLpa.unit, "mg/dL")
        // No Lp(a) unit, so no picker and no Lp(a) reading of the number: the add sheet shows mg/dL.
        XCTAssertNil(RecordStore.lpaUnit(for: labLpa, recordUnit: decoded.lpaUnit))
        XCTAssertEqual(RecordStore.lpaUnit(for: coreLpa, recordUnit: decoded.lpaUnit), "nmol/L")
        let added = try engine.blocking { [now] in try $0.apply(.labAdd(series: labLpa.metric, value: 42, day: "2026-10-01", unit: labLpa.unit), to: saved, now: now, deviceId: "test") }
        let afterAdd = try engine.blocking { [now] in try $0.history(recordJSON: try XCTUnwrap(added.record), metric: "lpa", now: now, deviceId: "test", series: "lab") }
        XCTAssertEqual(afterAdd.rows.first?.value, "42")
        XCTAssertEqual(afterAdd.rows.first?.unit, "mg/dL", "the add saves mg/dL")
        // The correction shows mg/dL whatever Lp(a)'s unit, and saves in it.
        let older = try XCTUnwrap(afterAdd.rows.first { $0.id == "a1" })
        XCTAssertEqual(MetricDetailView.correctionUnit(older, shown: labLpa, lpaUnit: "nmol/L"), "mg/dL")
        let corrected = try engine.blocking { [now] in try $0.apply(.labCorrect(id: "a1", value: 45), to: saved, now: now, deviceId: "test") }
        let afterCorrect = try engine.blocking { [now] in try $0.history(recordJSON: try XCTUnwrap(corrected.record), metric: "lpa", now: now, deviceId: "test", series: "lab") }
        XCTAssertEqual(afterCorrect.rows.first { $0.value == "45" }?.unit, "mg/dL", "the correction saves mg/dL")
        // A lab "HDL" has no core HDL guide; the core HDL row does.
        let labHdl = try XCTUnwrap(decoded.labTests?.first { $0.metric == "hdl" })
        let coreHdl = try XCTUnwrap(decoded.bloodTests.first { $0.metric == "hdl" })
        XCTAssertNil(MetricDetailView.guide(for: labHdl, in: decoded.guides))
        XCTAssertNotNil(MetricDetailView.guide(for: coreHdl, in: decoded.guides))
    }
}

