import XCTest
@testable import HealthRoadmap

/// US-25 AC4/AC5: the app's edits run health-core's own write functions in
/// JavaScriptCore, and give what the same functions give in Node
/// (ios/engine/my-data.test.ts).
final class RecordEditTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    private func emptyRecord(_ engine: HealthEngine) throws -> String {
        try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
    }

    func testAnAddedValueBecomesARowWithAFreshId() throws {
        let engine = try HealthEngine()
        var record = try emptyRecord(engine)
        for day in ["2026-10-19", "2026-10-20"] {
            let outcome = try engine.blocking { [now] in try $0.apply(.add(metric: "weight", value: 80, day: day), to: record, now: now, deviceId: "test") }
            XCTAssertTrue(outcome.ok, outcome.message ?? "")
            record = try XCTUnwrap(outcome.record)
        }
        let rows = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(record.utf8)) as? [String: Any])["measurements"] as? [[String: Any]]
        let ids = Set(try XCTUnwrap(rows).compactMap { $0["id"] as? String })
        XCTAssertEqual(ids.count, 2, "each row needs its own id")

        let data = try engine.blocking { [now] in try $0.myData(recordJSON: record, now: now, deviceId: "test") }
        XCTAssertEqual(data.vitals.first?.latest?.value, "80.0")
        XCTAssertEqual(data.vitals.first?.latest?.day, "2026-10-20")
    }

    func testTheEngineRefusesInItsOwnWords() throws {
        let engine = try HealthEngine()
        let start = try emptyRecord(engine)
        let outcome = try engine.blocking { [now] in try $0.apply(.add(metric: "systolic_bp", value: 400, day: "2026-10-20"), to: start, now: now, deviceId: "test") }
        XCTAssertFalse(outcome.ok)
        XCTAssertEqual(outcome.reason, "out-of-range")
        XCTAssertNotNil(outcome.message)
        XCTAssertNil(outcome.record)
    }

    func testReplacingADayIsACorrection() throws {
        let engine = try HealthEngine()
        let start = try emptyRecord(engine)
        let first = try XCTUnwrap(engine.blocking { [now] in try $0.apply(.add(metric: "weight", value: 80, day: "2026-10-20"), to: start, now: now, deviceId: "test") }.record)

        let held = try engine.blocking { [now] in try $0.apply(.add(metric: "weight", value: 82, day: "2026-10-20"), to: first, now: now, deviceId: "test") }
        XCTAssertEqual(held.reason, "slot-occupied")
        let oldId = try XCTUnwrap(held.existingId)

        let corrected = try XCTUnwrap(engine.blocking { [now] in try $0.apply(.correct(id: oldId, value: 82), to: first, now: now, deviceId: "test") }.record)
        let rows = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(corrected.utf8)) as? [String: Any])?["measurements"] as? [[String: Any]])
        XCTAssertEqual(rows.count, 2)
        XCTAssertEqual(rows[0]["status"] as? String, "entered-in-error")
        XCTAssertEqual(rows[1]["correctsId"] as? String, oldId)
        XCTAssertEqual(rows[1]["status"] as? String, "active")
    }

    func testAUSPhoneGetsUSUnitsWhateverItsClockSettings() throws {
        // Adversary R3: 24-hour time or a Monday week adds keywords to the locale,
        // and the region was then read from the keyword, so the record started metric.
        let engine = try HealthEngine()
        let newYork = try XCTUnwrap(TimeZone(identifier: "America/New_York"))
        for identifier in ["en_US", "en_US@hours=h23", "en_US@fw=mon"] {
            let record = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: identifier), timeZone: newYork) }
            XCTAssertEqual(try engine.blocking { [now] in try $0.myData(recordJSON: record, now: now, deviceId: "test") }.unitSystem, "conventional", identifier)
        }
    }

    func testTheEngineReadsNumbersAsTheWebDoes() throws {
        // Adversary R2: a German phone read "3.4" as 3.
        let engine = try HealthEngine()
        XCTAssertEqual(try engine.blocking { try $0.number(from: "3.4") }, 3.4)
        XCTAssertEqual(try engine.blocking { try $0.number(from: "3,4") }, 3.4)
        XCTAssertNil(try engine.blocking { try $0.number(from: "3.4.5") })
    }

    func testTheEditEncodesAsTheEngineReadsIt() throws {
        let json = String(decoding: try JSONEncoder().encode(RecordEdit.profile(sex: "female", height: 165)), as: UTF8.self)
        let object = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(object["kind"] as? String, "profile")
        XCTAssertEqual(object["sex"] as? String, "female")
        XCTAssertEqual(object["height"] as? Double, 165)
        XCTAssertNil(object["birthYear"], "an unset field is left out, not sent as null")
    }

    /// I-2 step 3 (US-25 AC18c): every RecordEdit case encodes to the JSON the engine reads, from the
    /// one fixture contract.test.ts parses (ios/engine/__fixtures__/record-edits.json). A key the
    /// engine does not know would be dropped silently, so the shapes must match exactly.
    func testEveryEditEncodesAsTheSharedFixture() throws {
        let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "engine/__fixtures__/record-edits.json")
        let fixture = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
        let expected = try XCTUnwrap(fixture["edits"] as? [String: Any])
        let opaque = { (name: String, key: String) throws -> OpaqueJSON in
            let value = try XCTUnwrap((expected[name] as? [String: Any])?[key])
            return try JSONDecoder().decode(OpaqueJSON.self, from: JSONSerialization.data(withJSONObject: value, options: .fragmentsAllowed))
        }
        let edits: [String: RecordEdit] = [
            "profile": .profile(sex: "female", birthYear: 1970, birthMonth: 6, height: 178),
            "feetInches": .feetInches(feet: 5, inches: 10),
            "bloodPressure": .bloodPressure(systolic: 120, diastolic: 80, day: "2026-10-20", replace: false, seenIds: ["ignored"]),
            "bloodPressureReplace": .bloodPressure(systolic: 120, diastolic: 80, day: "2026-10-20", replace: true, seenIds: ["a", "b"]),
            "units": .units("conventional"),
            "alcoholCleared": .alcohol(nil),
            "alcohol": .alcohol(.drinks),
            "lpaUnit": .lpaUnit("mg/dL"),
            "add": .add(metric: "weight", value: 80.5, day: "2026-10-20"),
            "correct": .correct(id: "row-1", value: 81),
            "labCorrect": .labCorrect(id: "lab-1", value: 85),
            "labAdd": .labAdd(series: "ferritin", value: 85, day: "2026-10-20", unit: "µg/L"),
            "labAddName": .labAddName(name: "Ferritin", value: 85, day: "2026-10-20", unit: "µg/L"),
            "appleHealth": .appleHealth([
                HealthSample(externalId: "u-1", metricType: "weight", value: 80, measuredAt: "2026-10-21T08:30:00+13:00", pairId: nil),
                HealthSample(externalId: "u-2", metricType: "systolic_bp", value: 120, measuredAt: "2026-10-21T08:30:00+13:00", pairId: "p-1"),
            ]),
            "healthRecords": .healthRecords([HealthRecord(sourceId: "s", resourceType: "Observation", fhirVersion: "4.0.1", json: "{}")]),
            "medicationField": .form(.medicationField(field: "statin", value: "none")),
            "screening": .form(.screening(key: "colorectalMethod", value: "")),
            "supplement": .form(.supplement(key: "creatine", name: "Creatine", dose: nil, unit: nil, stopped: false)),
            "supplementStopped": .form(.supplement(key: "creatine", name: "Creatine", dose: 5, unit: "g", stopped: true)),
            "customSupplement": .form(.customSupplement(name: "Magnesium")),
            "labImport": .labImport(extractionJSON: "{}", refs: ["v0"], reportDay: "2026-10-20"),
            "chatEdits": .chatEdits(part: .review, edits: try opaque("chatEdits", "edits"), today: "2026-10-21"),
            "chatEditsSeen": .chatEdits(part: .review, edits: try opaque("chatEditsSeen", "edits"), today: "2026-10-21", seen: try opaque("chatEditsSeen", "seen")),
            "chatUndo": .engineEdit(try JSONDecoder().decode(OpaqueJSON.self, from: JSONSerialization.data(withJSONObject: try XCTUnwrap(expected["chatUndo"])))),
        ]
        let engineOnly = Set(try XCTUnwrap(fixture["engineOnly"] as? [String]))
        XCTAssertEqual(Set(edits.keys), Set(expected.keys).subtracting(engineOnly), "one RecordEdit per fixture entry")
        for (name, edit) in edits {
            let encoded = try JSONSerialization.jsonObject(with: JSONEncoder().encode(edit)) as? NSDictionary
            XCTAssertEqual(encoded, expected[name] as? NSDictionary, name)
        }
    }
}
