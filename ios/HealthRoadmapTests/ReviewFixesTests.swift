import XCTest
@testable import HealthRoadmap

/// Review fixes on PR 865 (US-73, US-56, US-58): each written to fail on 785c1928 first.
@MainActor
final class ReviewFixesTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Review Fixes \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        UnitChoices().save()
    }

    private func sample() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "sample.record", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func store(_ record: [String: Any]) throws -> RecordStore {
        try JSONSerialization.data(withJSONObject: record).write(to: folder.appending(path: "health-roadmap.json"))
        return try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "test")
    }

    static func lab(_ id: String, _ name: String, _ value: Double, _ unit: String, _ day: String, core: Bool = false, comparator: String? = nil) -> [String: Any] {
        var row: [String: Any] = ["id": id, "metricName": name, "value": value, "unit": unit, "referenceLow": NSNull(), "referenceHigh": NSNull(),
                                  "recordedAt": day, "createdAt": "\(day)T08:00:00Z", "source": "manual", "status": "active", "correctsId": NSNull()]
        if core { row["core"] = true }
        if let comparator { row["comparator"] = comparator }
        return row
    }

    /// US-73 AC8 (Codex R2): a test picked in Add blood test opens on the screen it was picked
    /// on; a unit switch landing before the entry sheet shows reads the row again in the new units.
    func testAPickedTestsRowAndScreenAgree_US73_AC8() async throws {
        let store = try store(try sample())
        let ldl = try XCTUnwrap(store.myData?.bloodTests.first { $0.metric == "ldl" })
        let picked = MyDataView.PickedTest(pick: .row(ldl), seen: store.screen)
        guard case .test(let same, let seen)? = MyDataView.entry(for: picked, now: store.screen, data: store.myData) else { return XCTFail("a pick opens its entry") }
        XCTAssertEqual(same.unit, ldl.unit)
        XCTAssertEqual(seen, picked.seen)

        await XCTAssertSaved(await store.apply(.units("conventional")))
        let now = try XCTUnwrap(store.myData?.bloodTests.first { $0.metric == "ldl" })
        XCTAssertNotEqual(now.unit, ldl.unit, "the switch changed LDL's unit")
        guard case .test(let row, let screen)? = MyDataView.entry(for: picked, now: store.screen, data: store.myData) else { return XCTFail("a pick opens its entry") }
        XCTAssertEqual(screen, store.screen, "the screen now")
        XCTAssertEqual(row.unit, now.unit, "the row as it reads on that screen, never the old unit's")
    }

    /// US-58 (review R7): "Guide opened" only when the info sheet shows a guide.
    func testGuideOpenedOnlyForASheetWithAGuide_US58() throws {
        let engine = try HealthEngine()
        let empty = try engine.blocking { try $0.newRecord(now: .now, deviceId: "test") }
        let guides = try XCTUnwrap(try engine.blocking { try $0.myData(recordJSON: empty, now: .now, deviceId: "test") }.guides)
        let guide = try XCTUnwrap(guides["weight"])
        XCTAssertEqual(FormFieldRow.opened(guide: guide), .guideOpened)
        XCTAssertNil(FormFieldRow.opened(guide: nil), "a sheet of suggestions alone opens no guide")
    }

    /// US-73 AC8 (review R9): PSA is offered in Add blood test only to a record with a PSA value
    /// or with the prostate screening group on screen.
    func testPSAIsOfferedOnlyWhereThePlanAsksForIt_US73_AC8() throws {
        let female = try XCTUnwrap(try store(try sample()).myData)
        XCTAssertFalse(AddBloodTestSheet.held(female).contains { $0.id == female.psa.id }, "no prostate group, no PSA value: no PSA")

        var man = try sample()
        man["profile"] = (man["profile"] as? [String: Any] ?? [:]).merging(["sex": "male", "birthYear": 1960]) { $1 }
        let screened = try XCTUnwrap(try store(man).myData)
        XCTAssertTrue(screened.screenings.flatMap(\.groups).contains { $0.id == "prostate" })
        XCTAssertTrue(AddBloodTestSheet.held(screened).contains { $0.id == screened.psa.id }, "the prostate group: PSA")

        var held = try sample()
        held["labValues"] = (held["labValues"] as? [[String: Any]] ?? []) + [Self.lab("p1", "psa", 1.2, "ng/mL", "2026-05-01", core: true)]
        let valued = try XCTUnwrap(try store(held).myData)
        XCTAssertNotNil(valued.psa.latest)
        XCTAssertTrue(AddBloodTestSheet.held(valued).contains { $0.id == valued.psa.id }, "a PSA value: PSA")
    }

    /// US-73 AC2 (both reviews): Fitness keeps the reconnect row, but with only a sleep card held
    /// and no reconnect row due it shows nothing, so its heading hides.
    func testFitnessWithOnlySleepShowsNothing_US73_AC2() {
        let card = LiveCard(value: 60, date: .now, trend: [])
        let fitness: [LiveMetric] = [.vo2Max, .restingHeartRate, .steps]
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, needsAccess: false, hasRead: true, cards: [.sleep: card], keepsReconnect: true), .nothing)
        XCTAssertEqual(LiveShown.shown([.sleep], connected: true, needsAccess: false, hasRead: true, cards: [.sleep: card], keepsReconnect: false), .cards([.sleep]))
    }
}
