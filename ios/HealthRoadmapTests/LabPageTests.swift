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
        XCTAssertNil(history.units)
        XCTAssertEqual(ChartPoint.points(history).map(\.limit), [true, false])
    }

    func testASeriesInMoreThanOneUnitListsEachUnitAndDrawsNoChart_US25_AC25() throws {
        let engine = try HealthEngine()
        let text = try record(engine, labs: [lab("z1", "zinc_custom", 12, "µmol/L", "2026-09-01"), lab("z2", "zinc_custom", 80, "µg/dL", "2026-10-01")])
        let now = self.now
        let history = try engine.blocking { [now] in try $0.history(recordJSON: text, metric: "zinc custom", now: now, deviceId: "test", series: "lab") }
        XCTAssertEqual(history.units, ["µg/dL", "µmol/L"])
        XCTAssertEqual(history.rows.map(\.unit), ["µg/dL", "µmol/L"])
        XCTAssertTrue(ChartPoint.points(history).isEmpty)
        XCTAssertEqual(MetricDetailView.noChart(history), "Units vary between reports (µg/dL, µmol/L), so this test is not charted.")
    }

    func testAddingAndCorrectingALabValueGoThroughTheEngine_US25_AC25() throws {
        let engine = try HealthEngine()
        let text = try record(engine, labs: [lab("f1", "ferritin", 80, "µg/L", "2026-09-01")])
        let now = self.now
        let added = try engine.blocking { [now] in try $0.apply(.labAdd(series: "ferritin", value: 110, day: "2026-10-10"), to: text, now: now, deviceId: "test") }
        XCTAssertTrue(added.ok, added.message ?? "")
        let taken = try engine.blocking { [now] in try $0.apply(.labAdd(series: "ferritin", value: 85, day: "2026-09-01"), to: text, now: now, deviceId: "test") }
        XCTAssertFalse(taken.ok)
        XCTAssertEqual(taken.reason, "slot-occupied")
        XCTAssertEqual(taken.existingId, "f1", "the row a replace corrects")
        let corrected = try engine.blocking { [now] in try $0.apply(.correct(id: "f1", value: 85), to: text, now: now, deviceId: "test") }
        let record = try XCTUnwrap(corrected.record)
        let history = try engine.blocking { [now] in try $0.history(recordJSON: record, metric: "ferritin", now: now, deviceId: "test", series: "lab") }
        XCTAssertEqual(history.rows.map(\.value), ["85", "80"])
        XCTAssertEqual(history.rows.map(\.status), ["active", "entered-in-error"])
        XCTAssertEqual(history.rows.map(\.correction), [true, false])
    }

    func testALabAddEncodesAsTheEngineReadsIt_US25_AC25() throws {
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(RecordEdit.labAdd(series: "ferritin", value: 110, day: "2026-10-10"))) as? [String: Any])
        XCTAssertEqual(json["kind"] as? String, "labAdd")
        XCTAssertEqual(json["series"] as? String, "ferritin")
        XCTAssertEqual(json["value"] as? Double, 110)
        XCTAssertEqual(json["day"] as? String, "2026-10-10")
    }
}
