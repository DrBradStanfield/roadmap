import XCTest
@testable import HealthRoadmap

/// US-25 AC8/AC9: the medication, screening and supplement questions and the
/// value history, run in JavaScriptCore, decode in Swift and write through
/// the web's own functions (ios/engine/my-data.test.ts holds the same cases in Node).
final class FormEditTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    /// A 60-year-old man, 180 cm, metric, with an ApoB over target: screening and the cholesterol cascade apply.
    private func man60(_ engine: HealthEngine) throws -> String {
        var record = try engine.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        for edit: RecordEdit in [.profile(sex: "male", birthYear: 1966, birthMonth: 1, height: 180), .add(metric: "apob", value: 1.3, day: "2026-10-01")] {
            record = try saved(engine, edit, record)
        }
        return record
    }

    private func saved(_ engine: HealthEngine, _ edit: RecordEdit, _ record: String) throws -> String {
        let outcome = try engine.apply(edit, to: record, now: now, deviceId: "test")
        XCTAssertTrue(outcome.ok, outcome.message ?? "")
        return try XCTUnwrap(outcome.record)
    }

    private func object(_ record: String) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any])
    }

    func testTheFormsDecodeWithTheWebsQuestions() throws {
        let engine = try HealthEngine()
        let data = try engine.myData(recordJSON: try man60(engine), now: now, deviceId: "test")
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
        let outcome = try engine.apply(.form(.medicationField(field: "statin", value: "aspirin")), to: try man60(engine), now: now, deviceId: "test")
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
        var record = try engine.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        record = try saved(engine, .form(.customSupplement(name: "Lion's Mane")), record)
        record = try saved(engine, .form(.supplement(key: "custom_lion_s_mane", name: "Lion's Mane", dose: 500, unit: "mg", stopped: true)), record)
        let data = try engine.myData(recordJSON: record, now: now, deviceId: "test")
        XCTAssertEqual(data.supplements.active, [])
        XCTAssertEqual(data.supplements.stopped.map(\.name), ["Lion's Mane"])
        XCTAssertEqual(data.supplements.stopped.first?.dose, 500)
    }

    func testHistoryKeepsTheCorrectedValueStruckNotRemoved() throws {
        let engine = try HealthEngine()
        var record = try engine.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        record = try saved(engine, .add(metric: "weight", value: 82, day: "2026-10-01"), record)
        let wrong = try XCTUnwrap(engine.myData(recordJSON: record, now: now, deviceId: "test").vitals.first?.latest?.id)
        record = try saved(engine, .correct(id: wrong, value: 81), record)
        let history = try engine.history(recordJSON: record, metric: "weight", now: now, deviceId: "test")
        XCTAssertEqual(history.rows.map(\.value), ["81.0", "82.0"])
        XCTAssertEqual(history.rows.map(\.isActive), [true, false])
        XCTAssertEqual(history.rows.map(\.current), [true, false])
    }
}
