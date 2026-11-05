import SwiftUI
import XCTest
@testable import HealthRoadmap

/// US-73: the My health tab draws the engine's topic layout. Swift places nothing, so these
/// check that what the engine placed lands where the tab draws it, for a broad set of records.
@MainActor
final class MyHealthTests: XCTestCase {
    private var folder: URL!
    private let today = DayText.iso(.now)

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "My Health \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        UnitChoices().save()
    }

    // MARK: Records

    private func sample() throws -> [String: Any] {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "sample.record", withExtension: "json"))
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    }

    private func text(_ record: [String: Any]) throws -> String {
        String(decoding: try JSONSerialization.data(withJSONObject: record), as: UTF8.self)
    }

    private static func measurement(_ id: String, _ metric: String, _ value: Double, _ day: String) -> [String: Any] {
        ["id": id, "metricType": metric, "value": value, "recordedAt": day, "createdAt": "\(day)T08:00:00Z",
         "source": "manual", "status": "active", "correctsId": NSNull(), "externalId": NSNull()]
    }

    private static func lab(_ id: String, _ name: String, _ value: Double, _ unit: String, _ day: String, core: Bool = false) -> [String: Any] {
        var row: [String: Any] = ["id": id, "metricName": name, "value": value, "unit": unit, "referenceLow": NSNull(), "referenceHigh": NSNull(),
                                  "recordedAt": day, "createdAt": "\(day)T08:00:00Z", "source": "manual", "status": "active", "correctsId": NSNull()]
        if core { row["core"] = true }
        return row
    }

    /// The sample with more added: `measurements` and `labValues` rows, and profile changes.
    private func record(measurements: [[String: Any]] = [], labs: [[String: Any]] = [], profile: (inout [String: Any]) -> Void = { _ in }) throws -> String {
        var record = try sample()
        record["measurements"] = (record["measurements"] as? [[String: Any]] ?? []) + measurements
        record["labValues"] = (record["labValues"] as? [[String: Any]] ?? []) + labs
        var person = record["profile"] as? [String: Any] ?? [:]
        profile(&person)
        record["profile"] = person
        return try text(record)
    }

    /// A crisis blood pressure today: an urgent card (US-73 AC5).
    private func urgent() throws -> String {
        try record(measurements: [Self.measurement("u1", "systolic_bp", 185, today), Self.measurement("u2", "diastolic_bp", 125, today)])
    }

    /// Waist twice, core creatinine twice and a newer lab eGFR (US-73 AC7).
    private func kidneysAndWaist() throws -> String {
        try record(measurements: [Self.measurement("w1", "waist", 88, "2026-03-01"), Self.measurement("w2", "waist", 84, "2026-06-01")],
                   labs: [Self.lab("c1", "creatinine", 80, "µmol/L", "2026-03-01", core: true), Self.lab("c2", "creatinine", 85, "µmol/L", "2026-06-01", core: true),
                          Self.lab("e1", "egfr", 72, "mL/min/1.73m²", "2026-07-01")])
    }

    private func records() throws -> [(name: String, json: String)] {
        let year = Calendar.current.component(.year, from: .now)
        let engine = try HealthEngine()
        let empty = try engine.blocking { try $0.newRecord(now: .now, deviceId: "test") }
        return [
            ("sample", try text(sample())), ("urgent", try urgent()), ("kidneys", try kidneysAndWaist()), ("empty", empty),
            ("no sex", try record { $0.removeValue(forKey: "sex") }),
            ("minor", try record { $0["birthYear"] = year - 15 }),
            ("male", try record { $0["sex"] = "male" }),
        ]
    }

    private func drawn(_ json: String) throws -> HealthEngine.Drawn {
        try HealthEngine().blocking { try $0.screen(recordJSON: json, now: .now, deviceId: "test") }
    }

    private func ids(_ cards: [PlanCard]) -> [String] { cards.flatMap(\.suggestions).map(\.id) }

    // MARK: AC2, AC4, AC5

    func testTheSectionsAreInBradsOrder_US73_AC2() throws {
        let order = ["weight", "sleep", "fitness", "bloodPressure", "cholesterol", "screening", "skin", "bloodTests", "supplements", "other"]
        XCTAssertEqual(HealthTopic.allCases.map(\.rawValue), order)
        XCTAssertEqual(HealthTopic.pills, [.bloodTests, .cholesterol, .supplements])
        for (name, json) in try records() {
            let topics = try drawn(json).topics?.sections.map(\.topic) ?? []
            XCTAssertEqual(topics, order.filter(topics.contains), "\(name): the engine's sections follow the tab's order")
        }
    }

    func testWithinASectionUrgentLeadsAndAResultLeadsAdvice_US73_AC4() throws {
        let rank = ["urgent": 0, "attention": 1, "info": 2]
        for (name, json) in try records() {
            let shown = try drawn(json)
            let plan = TopicPlan(shown.topics, plan: shown.plan)
            for topic in HealthTopic.allCases {
                let order = plan[topic].map { (rank[$0.priority] ?? 3) * 2 + ($0.suggestions.contains { ["bloodwork", "blood_pressure"].contains($0.category) } ? 0 : 1) }
                XCTAssertEqual(order, order.sorted(), "\(name) \(topic): urgent, attention, info; results first within each")
            }
        }
        let shown = try drawn(try urgent())
        XCTAssertEqual(TopicPlan(shown.topics, plan: shown.plan)[.bloodPressure].first?.priority, "urgent", "the crisis card leads Blood pressure")
    }

    func testTheBannerScrollsToTheUrgentCard_US73_AC5() throws {
        let shown = try drawn(try urgent())
        let plan = TopicPlan(shown.topics, plan: shown.plan)
        let card = try XCTUnwrap(plan[.bloodPressure].first)
        let banner = try XCTUnwrap(plan.urgent)
        XCTAssertEqual(banner.anchor, card.anchor)
        XCTAssertEqual(banner.title, card.suggestions.first { $0.priority == "urgent" }?.title)
        let calm = try drawn(try text(sample()))
        XCTAssertNil(TopicPlan(calm.topics, plan: calm.plan).urgent, "no urgent card, no banner")
    }

    // MARK: AC3

    /// Every suggestion the plan holds lands where the tab draws it: a card in a topic (each
    /// topic with a card is drawn), on a medicine question the tab's two medicine sections ask,
    /// or in a screening group with questions; an urgent one also as a card.
    func testEverySuggestionLandsWhereTheTabDrawsIt_US73_AC3() throws {
        for (name, json) in try records() {
            let shown = try drawn(json)
            guard case .planned(_, let sections, _) = shown.plan else { continue }
            let plan = TopicPlan(shown.topics, plan: shown.plan)
            let cards = Set(HealthTopic.allCases.flatMap { ids(plan[$0]) })
            let medicines = shown.myData.medications.filter { ["weight-medications", "lipid-medications"].contains($0.id) }
            let questions = Set(medicines.flatMap(\.groups).flatMap(\.fields).map(Self.key))
            let groups = shown.myData.screeningNote == nil ? Set(shown.myData.screenings.flatMap(\.groups).filter { !$0.fields.isEmpty }.map(\.id)) : []
            let onRows = Set(plan.medicines.filter { questions.contains($0.key) }.flatMap(\.value).map(\.id)
                + plan.screenings.filter { groups.contains($0.key) }.flatMap(\.value).map(\.id))
            for suggestion in sections.flatMap(\.cards).flatMap(\.suggestions) {
                XCTAssertTrue(cards.contains(suggestion.id) || onRows.contains(suggestion.id), "\(name): \(suggestion.id) is drawn nowhere")
                if suggestion.priority == "urgent" { XCTAssertTrue(cards.contains(suggestion.id), "\(name): urgent \(suggestion.id) is a card too") }
            }
            XCTAssertNotNil(shown.topics, "\(name): the bundled engine lays the plan out by topic")
        }
    }

    private static func key(_ field: FormField) -> String {
        switch field {
        case .choice(let key, _, _, _, _), .month(let key, _, _, _), .number(let key, _, _, _): key
        case .measurement(let metric, _, _): metric
        }
    }

    func testATopicTheAppDoesNotKnowAndAMissingLayoutGoUnderOther_US73_AC3() throws {
        let card = #"{"category":"general","priority":"info","suggestions":[{"id":"new-thing","category":"general","priority":"info","title":"New","description":"A newer engine's"}]}"#
        let layout = try JSONDecoder().decode(TopicLayout.self, from: Data(#"{"sections":[{"topic":"hearing","cards":[\#(card)]}],"medicines":[],"screenings":[]}"#.utf8))
        let section = try JSONDecoder().decode(PlanSection.self, from: Data(#"{"key":"info","title":"Foundation","cards":[\#(card)]}"#.utf8))
        let planned = PlanState.planned(tiles: [], sections: [section], ms: 1)
        XCTAssertEqual(ids(TopicPlan(layout, plan: planned)[.other]), ["new-thing"])
        XCTAssertEqual(ids(TopicPlan(nil, plan: planned)[.other]), ["new-thing"], "no layout: every card under Other, none dropped")
        XCTAssertTrue(HealthTopic.allCases.allSatisfy { TopicPlan(nil, plan: .needsDetails)[$0].isEmpty }, "no plan, no cards")
    }

    /// AC6: a medicine suggestion sits on its question, never as a card (unless urgent).
    func testMedicineSuggestionsSitOnTheirQuestions_US73_AC6() throws {
        let shown = try drawn(try text(sample()))
        let plan = TopicPlan(shown.topics, plan: shown.plan)
        XCTAssertEqual(plan.medicines["glp1"]?.map(\.id), ["weight-med-glp1"])
        XCTAssertEqual(plan.medicines["ezetimibe"]?.map(\.id), ["med-ezetimibe"])
        XCTAssertFalse(HealthTopic.allCases.flatMap { ids(plan[$0]) }.contains("med-ezetimibe"))
        XCTAssertEqual(plan.screenings["colorectal"]?.map(\.id), ["screening-colorectal"])
    }

    // MARK: AC7

    func testTheWaistToHeightAndEgfrRowsAreTheEnginesSeries_US73_AC7() throws {
        let json = try kidneysAndWaist()
        let engine = try HealthEngine()
        let whtr = try XCTUnwrap(DerivedRow(try engine.blocking { try $0.history(recordJSON: json, metric: "whtr", now: .now, deviceId: "test", series: "whtr") }))
        let egfr = try XCTUnwrap(DerivedRow(try engine.blocking { try $0.history(recordJSON: json, metric: "egfr", now: .now, deviceId: "test", series: "egfr") }))
        let tiles = PlanTiles(try drawn(json).plan)

        XCTAssertEqual(whtr.history.target, "Normal <0.5")
        XCTAssertEqual(whtr.history.rows.count, 2, "one ratio a waist day")
        XCTAssertEqual(whtr.latest.value, tiles["whtr"]?.value, "the row's value is the tile's")
        XCTAssertNotNil(whtr.previous)
        XCTAssertEqual(whtr.trend.count, 2)

        XCTAssertEqual(egfr.latest.day, "2026-07-01", "the newer lab eGFR leads")
        XCTAssertEqual(egfr.source, "Lab result")
        XCTAssertEqual(egfr.history.rows.dropFirst().first?.source, "calculated")
        XCTAssertNotNil(egfr.previous)

        // One eGFR row: the lab's own row is the one the tab folds into it.
        let labs = try drawn(json).myData.labTests ?? []
        XCTAssertEqual(labs.filter(MyDataView.Derived.isLabEgfr).count, 1)
        XCTAssertEqual(labs.filter { !MyDataView.Derived.isLabEgfr($0) }.map(\.metric), ["ferritin"])
    }

    // MARK: AC9

    /// Every tile the engine draws has a home on a row's page (US-57 AC5's explainers live on).
    func testEveryTileExplainerHasARowPage_US73_AC9() throws {
        let homed = Set(PlanTiles.pages.values.joined())
        var lipids = try sample()
        lipids["labValues"] = (lipids["labValues"] as? [[String: Any]] ?? []).filter { !["apob", "ldl"].contains($0["metricName"] as? String) }
        for (name, json) in try records() + [("non-HDL", try text(lipids))] {
            guard case .planned(let tiles, _, _) = try drawn(json).plan else { continue }
            for tile in tiles { XCTAssertTrue(homed.contains(tile.key), "\(name): \(tile.key) has no page") }
        }
        // The keys health-core's statTiles can give (stat-tiles.ts StatTileKey).
        XCTAssertEqual(homed, ["whtr", "bmi", "ibw", "protein", "apoB", "nonHdl", "ldl", "egfr", "lpa", "hba1c"])
    }

    // MARK: AC8

    private func store(_ json: String) throws -> RecordStore {
        try Data(json.utf8).write(to: folder.appending(path: "health-roadmap.json"))
        return try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "test")
    }

    func testTheAddSheetsOutcomes_US73_AC8() async throws {
        let store = try store(try text(sample()))
        // A core test by name writes its core row.
        await XCTAssertSaved(await store.apply(.labAddName(name: "LDL", value: 3.1, day: today, unit: "mmol/L")))
        XCTAssertEqual(store.myData?.bloodTests.first { $0.metric == "ldl" }?.latest?.day, today)
        // A catalogue test keeps its key and unit.
        await XCTAssertSaved(await store.apply(.labAddName(name: "Testosterone (total)", value: 15, day: today, unit: "nmol/L")))
        XCTAssertEqual(store.myData?.labTests?.first { $0.metric == "testosterone_total" }?.latest?.value, "15")
        // A name nothing knows is a new test in the unit typed.
        await XCTAssertSaved(await store.apply(.labAddName(name: "Zeta marker", value: 5, day: today, unit: "zu/L")))
        XCTAssertEqual(store.myData?.labTests?.first { $0.metric == "zeta marker" }?.unit, "zu/L")

        // A unit the catalogue does not take, and an out-of-range value, are refused in the engine's words.
        guard case .refused(let unit, nil) = await store.apply(.labAddName(name: "Free testosterone", value: 15, day: today, unit: "furlongs")) else { return XCTFail("a bad unit saves nothing") }
        XCTAssertFalse(unit.isEmpty)
        guard case .refused(let range, _) = await store.apply(.labAddName(name: "LDL", value: 500, day: "2026-01-02", unit: "mmol/L")) else { return XCTFail("out of range saves nothing") }
        XCTAssertFalse(range.isEmpty)
        // The range is in the unit typed: mg/dL typed, mg/dL in the words.
        guard case .refused(let usRange, _) = await store.apply(.labAddName(name: "LDL", value: 5000, day: "2026-01-02", unit: "mg/dL")) else { return XCTFail("out of range saves nothing") }
        XCTAssertTrue(usRange.contains("mg/dL"), usRange)
        // A vital by name is no blood test, and a new test needs its unit: the engine's words, nothing saved.
        guard case .refused(let vital, nil) = await store.apply(.labAddName(name: "Weight", value: 80, day: today, unit: "kg")) else { return XCTFail("a vital by name saves nothing") }
        XCTAssertTrue(vital.contains("not a lab test"), vital)
        guard case .refused(let unitless, nil) = await store.apply(.labAddName(name: "Omega marker", value: 5, day: today, unit: "")) else { return XCTFail("a new test with no unit saves nothing") }
        XCTAssertTrue(unitless.contains("unit"), unitless)
        XCTAssertNil(store.myData?.labTests?.first { $0.metric == "omega marker" })
        // A series' own add to a series the record does not hold: not found, never a new test.
        guard case .refused(let missing, nil) = await store.apply(.labAdd(series: "no such test", value: 5, day: today, unit: "zu/L")) else { return XCTFail("no series saves nothing") }
        XCTAssertTrue(missing.contains("no such lab test"), missing)

        // A held day, another value in the same unit: refused with the row to correct, never a second row.
        guard case .refused(_, let held?) = await store.apply(.labAddName(name: "Testosterone (total)", value: 16, day: today, unit: "nmol/L")) else {
            return XCTFail("a held day offers its correction")
        }
        await XCTAssertSaved(await store.apply(.labCorrect(id: held, value: 16)))
        XCTAssertEqual(store.myData?.labTests?.first { $0.metric == "testosterone_total" }?.latest?.value, "16")
    }

    // MARK: Render

    /// The tab draws every kind of record without a fault: the sample, an urgent one, waist and
    /// kidneys, an empty record, no sex, a minor.
    func testTheTabDrawsEveryKindOfRecord_US73() async throws {
        for (name, json) in try records() {
            try? FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
            let store = try store(json)
            XCTAssertNotNil(store.myData, name)
            let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
            window.rootViewController = UIHostingController(rootView: MyHealthHost.view(store: store, engine: try HealthEngine()))
            window.makeKeyAndVisible()
            try await Task.sleep(for: .milliseconds(400))
            window.isHidden = true
        }
    }

    func testOnlyTheReduceAlcoholCardAsks_US60() throws {
        let shown = try drawn(try text(sample()))
        let plan = TopicPlan(shown.topics, plan: shown.plan)
        let question = AlcoholQuestion(answered: nil) { { _ in } }
        for card in HealthTopic.allCases.flatMap({ plan[$0] }) {
            XCTAssertEqual(card.asking(question) != nil, card.suggestions.contains { $0.id == Suggestion.reduceAlcohol }, card.id)
        }
    }
}

/// My health as RootView hosts it, for tests that draw it.
@MainActor
enum MyHealthHost {
    static func view(store: RecordStore, engine: HealthEngine) -> some View {
        let tokens = TokenStore(service: "test.\(UUID().uuidString)")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        return NavigationStack { MyDataView(engine: engine, store: store, sync: sync) }.environment(store)
    }
}
