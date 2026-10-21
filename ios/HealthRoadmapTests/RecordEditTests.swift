import XCTest
@testable import HealthRoadmap

/// US-25 AC4/AC5: the app's edits run health-core's own write functions in
/// JavaScriptCore, and give what the same functions give in Node
/// (ios/engine/my-data.test.ts).
final class RecordEditTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    private func emptyRecord(_ engine: HealthEngine) throws -> String {
        try engine.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!)
    }

    func testAnAddedValueBecomesARowWithAFreshId() throws {
        let engine = try HealthEngine()
        var record = try emptyRecord(engine)
        for day in ["2026-10-19", "2026-10-20"] {
            let outcome = try engine.apply(.add(metric: "weight", value: 80, day: day), to: record, now: now, deviceId: "test")
            XCTAssertTrue(outcome.ok, outcome.message ?? "")
            record = try XCTUnwrap(outcome.record)
        }
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any])["measurements"] as? [[String: Any]]
        let ids = Set(try XCTUnwrap(rows).compactMap { $0["id"] as? String })
        XCTAssertEqual(ids.count, 2, "each row needs its own id")

        let data = try engine.myData(recordJSON: record, now: now, deviceId: "test")
        XCTAssertEqual(data.vitals.first?.latest?.value, "80.0")
        XCTAssertEqual(data.vitals.first?.latest?.day, "2026-10-20")
    }

    func testTheEngineRefusesInItsOwnWords() throws {
        let engine = try HealthEngine()
        let outcome = try engine.apply(.add(metric: "systolic_bp", value: 400, day: "2026-10-20"), to: try emptyRecord(engine), now: now, deviceId: "test")
        XCTAssertFalse(outcome.ok)
        XCTAssertEqual(outcome.reason, "out-of-range")
        XCTAssertNotNil(outcome.message)
        XCTAssertNil(outcome.record)
    }

    func testReplacingADayIsACorrection() throws {
        let engine = try HealthEngine()
        let first = try XCTUnwrap(engine.apply(.add(metric: "weight", value: 80, day: "2026-10-20"), to: try emptyRecord(engine), now: now, deviceId: "test").record)

        let held = try engine.apply(.add(metric: "weight", value: 82, day: "2026-10-20"), to: first, now: now, deviceId: "test")
        XCTAssertEqual(held.reason, "slot-occupied")
        let oldId = try XCTUnwrap(held.existingId)

        let corrected = try XCTUnwrap(engine.apply(.correct(id: oldId, value: 82), to: first, now: now, deviceId: "test").record)
        let rows = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(corrected.utf8)) as? [String: Any])?["measurements"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0]["status"] as? String, "entered-in-error")
        XCTAssertEqual(rows[1]["correctsId"] as? String, oldId)
        XCTAssertEqual(rows[1]["status"] as? String, "active")
    }

    func testTheEditEncodesAsTheEngineReadsIt() throws {
        let json = String(decoding: try JSONEncoder().encode(RecordEdit.profile(sex: "female", height: 165)), as: UTF8.self)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(object["kind"] as? String, "profile")
        XCTAssertEqual(object["sex"] as? String, "female")
        XCTAssertEqual(object["height"] as? Double, 165)
        XCTAssertNil(object["birthYear"], "an unset field is left out, not sent as null")
    }
}
