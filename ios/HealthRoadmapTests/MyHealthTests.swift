import SwiftUI
import XCTest
@testable import HealthRoadmap

/// US-73: the My health tab draws `HealthPage`, built from the engine's screen and series.
/// MyDataView maps the page to views and reads nothing else for its cards and rows, so these
/// checks on the page are checks on what the tab draws, for a broad set of records.
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

    private static func lab(_ id: String, _ name: String, _ value: Double, _ unit: String, _ day: String, core: Bool = false, comparator: String? = nil) -> [String: Any] {
        ReviewFixesTests.lab(id, name, value, unit, day, core: core, comparator: comparator)
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

    private static let egfrUnit = "mL/min/1.73m²"

    private func records() throws -> [(name: String, json: String)] {
        let year = Calendar.current.component(.year, from: .now)
        let engine = try HealthEngine()
        let empty = try engine.blocking { try $0.newRecord(now: .now, deviceId: "test") }
        return [
            ("sample", try text(sample())), ("urgent", try urgent()), ("kidneys", try kidneysAndWaist()), ("empty", empty),
            ("no sex", try record { $0.removeValue(forKey: "sex") }),
            ("minor", try record { $0["birthYear"] = year - 15 }),
            ("male", try record { $0["sex"] = "male" }),
            ("older man", try record { $0["sex"] = "male"; $0["birthYear"] = year - 62 }),
            ("no height", try record { $0.removeValue(forKey: "heightCm") }),
            ("urgent man", try record(measurements: [Self.measurement("u1", "systolic_bp", 185, today), Self.measurement("u2", "diastolic_bp", 125, today)]) { $0["sex"] = "male"; $0["birthYear"] = year - 62 }),
        ]
    }

    private func drawn(_ json: String) throws -> HealthEngine.Drawn {
        try HealthEngine().blocking { try $0.screen(recordJSON: json, now: .now, deviceId: "test") }
    }

    /// The page My health draws for `json`, its series read as the tab reads them.
    private func page(_ json: String) throws -> HealthPage {
        let engine = try HealthEngine()
        let shown = try drawn(json)
        let series = { (name: String) in try? engine.blocking { try $0.history(recordJSON: json, metric: name, now: .now, deviceId: "test", series: name) } }
        return HealthPage(data: shown.myData, plan: shown.plan, layout: shown.topics, whtr: series("whtr"), egfr: series("egfr"))
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
            let page = try page(json)
            for topic in HealthTopic.allCases {
                let order = (page[topic].urgent + page[topic].cards).map { (rank[$0.priority] ?? 3) * 2 + ($0.suggestions.contains { ["bloodwork", "blood_pressure"].contains($0.category) } ? 0 : 1) }
                XCTAssertEqual(order, order.sorted(), "\(name) \(topic): urgent, attention, info; results first within each")
            }
        }
        XCTAssertEqual(try page(try urgent())[.bloodPressure].urgent.first?.priority, "urgent", "the crisis card leads Blood pressure")
    }

    func testTheBannerScrollsToTheUrgentCard_US73_AC5() throws {
        let page = try page(try urgent())
        let card = try XCTUnwrap(page[.bloodPressure].urgent.first)
        let banner = try XCTUnwrap(page.urgent)
        XCTAssertEqual(banner.anchor, card.anchor)
        XCTAssertEqual(banner.title, card.suggestions.first { $0.priority == "urgent" }?.title)
        XCTAssertNil(try self.page(try text(sample())).urgent, "no urgent card, no banner")
    }

    // MARK: AC3

    /// Every suggestion the plan holds is drawn exactly once (Codex R4, adversary R8): in one card,
    /// or on one row (a medicine question the two medicine sections ask, a screening group with a
    /// question); an urgent one in exactly one card, and on its row too when it sits on one. The
    /// page holds nothing the plan does not.
    func testEverySuggestionIsDrawnExactlyOnce_US73_AC3() throws {
        var checked = 0
        for (name, json) in try records() {
            let shown = try drawn(json)
            guard case .planned(_, let sections, _) = shown.plan else { continue }
            let drawn = try page(json).drawn
            let planned = sections.flatMap(\.cards).flatMap(\.suggestions)
            for suggestion in planned {
                let cards = drawn.cards.filter { $0.id == suggestion.id }.count
                let rows = drawn.rows.filter { $0.id == suggestion.id }.count
                if suggestion.priority == "urgent" {
                    XCTAssertEqual(cards, 1, "\(name): urgent \(suggestion.id) is one card")
                    XCTAssertLessThanOrEqual(rows, 1, "\(name): urgent \(suggestion.id) on one row at most")
                } else {
                    XCTAssertEqual(cards + rows, 1, "\(name): \(suggestion.id) is drawn \(cards) times as a card and \(rows) on a row")
                }
                checked += 1
            }
            let ids = Set(planned.map(\.id))
            XCTAssertTrue((drawn.cards + drawn.rows).allSatisfy { ids.contains($0.id) }, "\(name): the page draws only the plan's suggestions")
            XCTAssertNotNil(shown.topics, "\(name): the bundled engine lays the plan out by topic")
        }
        XCTAssertGreaterThan(checked, 20, "the records hold enough suggestions to mean something")
    }

    func testATopicTheAppDoesNotKnowAndAMissingLayoutGoUnderOther_US73_AC3() throws {
        let card = #"{"category":"general","priority":"info","suggestions":[{"id":"new-thing","category":"general","priority":"info","title":"New","description":"A newer engine's"}]}"#
        let layout = try JSONDecoder().decode(TopicLayout.self, from: Data(#"{"sections":[{"topic":"hearing","cards":[\#(card)]}],"medicines":[],"screenings":[]}"#.utf8))
        let section = try JSONDecoder().decode(PlanSection.self, from: Data(#"{"key":"info","title":"Foundation","cards":[\#(card)]}"#.utf8))
        let planned = PlanState.planned(tiles: [], sections: [section], ms: 1)
        let page = { (layout: TopicLayout?, plan: PlanState) in HealthPage(data: nil, plan: plan, layout: layout, whtr: nil, egfr: nil) }
        XCTAssertEqual(ids(page(layout, planned)[.other].cards), ["new-thing"])
        XCTAssertEqual(ids(page(nil, planned)[.other].cards), ["new-thing"], "no layout: every card under Other, none dropped")
        XCTAssertTrue(HealthTopic.allCases.allSatisfy { page(nil, .needsDetails)[$0].isEmpty }, "no plan, no cards")
    }

    /// AC6: a medicine suggestion sits on its question, never as a card (unless urgent).
    func testMedicineSuggestionsSitOnTheirQuestions_US73_AC6() throws {
        let page = try page(try text(sample()))
        XCTAssertEqual(page.medicines["glp1"]?.map(\.id), ["weight-med-glp1"])
        XCTAssertEqual(page.medicines["ezetimibe"]?.map(\.id), ["med-ezetimibe"])
        XCTAssertFalse(page.drawn.cards.map(\.id).contains("med-ezetimibe"))
        XCTAssertEqual(page.screenings["colorectal"]?.map(\.id), ["screening-colorectal"])
    }

    // MARK: AC7

    func testTheWaistToHeightRowIsTheEnginesSeries_US73_AC7() throws {
        let json = try kidneysAndWaist()
        let page = try page(json)
        let whtr = try XCTUnwrap(page.whtr)
        XCTAssertEqual(whtr.history.target, "Normal <0.5")
        XCTAssertEqual(whtr.history.rows.count, 2, "one ratio a waist day")
        XCTAssertEqual(whtr.latest.value, page.tiles["whtr"]?.value, "the row's value is the tile's")
        XCTAssertNotNil(whtr.previous)
        XCTAssertEqual(whtr.trend.count, 2)
    }

    /// The eGFR row is the plan's current eGFR: the tile's value and status on the day and from
    /// the source the engine names; the series gives only the bracketed value and the trend
    /// (Codex R1, R3; adversary R2). Its tap opens that source's page; the lab's own row leaves
    /// Blood tests only while the eGFR row stands for it.
    func testTheEgfrRowIsThePlansCurrentEgfr_US73_AC7() throws {
        let creatinine = { (id: String, value: Double, day: String) in Self.lab(id, "creatinine", value, "µmol/L", day, core: true) }
        let cases: [(name: String, labs: [[String: Any]], day: String, source: String, opens: String, previous: Bool)] = [
            ("a lab >90 newer than a calculated value", [creatinine("c1", 80, "2026-03-01"), Self.lab("e1", "egfr", 90, Self.egfrUnit, "2026-07-01", comparator: ">")],
             "2026-07-01", "Lab result", "lab:egfr", true),
            ("a calculated value newer than a lab one", [Self.lab("e1", "egfr", 72, Self.egfrUnit, "2026-03-01"), creatinine("c1", 85, "2026-06-01")],
             "2026-06-01", "Calculated", "creatinine", true),
            ("a lab value only", [Self.lab("e1", "egfr", 72, Self.egfrUnit, "2026-07-01")], "2026-07-01", "Lab result", "lab:egfr", false),
            ("a calculated value only", [creatinine("c1", 85, "2026-06-01")], "2026-06-01", "Calculated", "creatinine", false),
        ]
        for item in cases {
            let page = try page(try record(labs: item.labs))
            let tile = try XCTUnwrap(page.tiles["egfr"], item.name)
            let egfr = try XCTUnwrap(page.egfr, item.name)
            XCTAssertEqual(egfr.value, tile.value, "\(item.name): the plan's value, its comparator included")
            XCTAssertEqual(egfr.day, item.day, item.name)
            XCTAssertTrue(egfr.target.hasSuffix(item.source), "\(item.name): \(egfr.target)")
            if let status = tile.status?.label { XCTAssertTrue(egfr.target.hasPrefix(status), item.name) }
            XCTAssertEqual(egfr.grade, PlanTiles.grade(tile), item.name)
            XCTAssertEqual(egfr.page.id, item.opens, "\(item.name): opens its source's page")
            XCTAssertEqual(egfr.previous != nil, item.previous, item.name)
            XCTAssertFalse(page.labs.contains(where: HealthPage.isLabEgfr), "\(item.name): one eGFR row")
        }
        XCTAssertEqual(try page(try record(labs: cases[0].labs)).egfr?.value.first, ">", "the limit shows as printed")

        // No plan eGFR (a known minor): no eGFR row, so the lab's own row stays in Blood tests.
        let year = Calendar.current.component(.year, from: .now)
        let minor = try page(try record(labs: [Self.lab("e1", "egfr", 72, Self.egfrUnit, "2026-07-01")]) { $0["birthYear"] = year - 15 })
        XCTAssertNil(minor.egfr)
        XCTAssertTrue(minor.labs.contains(where: HealthPage.isLabEgfr))
    }

    /// Each eGFR history's page links to the other, so a lab eGFR can always be reached for
    /// correction (US-25 AC9).
    func testEachEgfrPageLinksToTheOther_US73_AC7() throws {
        let data = try drawn(try kidneysAndWaist()).myData
        let creatinine = try XCTUnwrap(data.bloodTests.first { $0.metric == "creatinine" })
        let lab = try XCTUnwrap(data.labTests?.first(where: HealthPage.isLabEgfr))
        XCTAssertEqual(MetricDetailView.otherEgfr(creatinine, in: data)?.row.id, lab.id)
        XCTAssertEqual(MetricDetailView.otherEgfr(creatinine, in: data)?.title, "Lab eGFR results")
        XCTAssertEqual(MetricDetailView.otherEgfr(lab, in: data)?.row.id, creatinine.id)
        XCTAssertEqual(MetricDetailView.otherEgfr(lab, in: data)?.title, "Creatinine")
        let plain = try drawn(try text(sample())).myData
        XCTAssertNil(MetricDetailView.otherEgfr(try XCTUnwrap(plain.bloodTests.first { $0.metric == "creatinine" }), in: plain), "no lab eGFR, no link")
    }

    /// Waist's own value sets the column when there is no ratio (no height).
    func testTheWaistRowSetsTheColumnWithoutARatio_US73_AC7() throws {
        // No height, so no ratio; no weight or HbA1c, so only waist can set the column.
        var plain = try sample()
        plain["measurements"] = (plain["measurements"] as? [[String: Any]] ?? []).filter { !["weight", "hba1c"].contains($0["metricType"] as? String) }
            + [Self.measurement("w1", "waist", 102, "2026-06-01")]
        plain["labValues"] = (plain["labValues"] as? [[String: Any]] ?? []).filter { ($0["metricName"] as? String) != "hba1c" }
        var person = plain["profile"] as? [String: Any] ?? [:]
        person.removeValue(forKey: "heightCm")
        plain["profile"] = person
        let page = try page(try text(plain))
        XCTAssertNil(page.whtr)
        XCTAssertNil(page.weight?.latest)
        XCTAssertNil(page.hba1c?.latest)
        XCTAssertEqual(page.waist?.latest?.value, "102")
        XCTAssertEqual(page.weightColumn.value, "000", "the column holds waist's own value")
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

    func testOnlyTheReduceAlcoholCardAsks_US60() throws {
        let page = try page(try text(sample()))
        let question = AlcoholQuestion(answered: nil) { { _ in } }
        for card in HealthTopic.allCases.flatMap({ page[$0].urgent + page[$0].cards }) {
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
