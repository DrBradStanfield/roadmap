import XCTest
@testable import HealthRoadmap

/// US-25 AC2: the app lays the plan out exactly as the web does, because both
/// call health-core's `planSections`, and every card keeps its evidence.
final class PlanLayoutTests: XCTestCase {
    // Pinned, like EngineParityTests: due dates and ages depend on the day.
    private let now = Date(timeIntervalSince1970: 1_792_585_800) // 2026-10-21T12:30:00Z

    private func sample() throws -> String {
        let fixtures = Bundle(for: Self.self)
        return try String(contentsOf: XCTUnwrap(fixtures.url(forResource: "sample.record", withExtension: "json")), encoding: .utf8)
    }

    /// The Plan tab's sections and tiles, through the door the app uses.
    private func view(units: String = "{}") throws -> (sections: [PlanSection], tiles: [StatTile]) {
        let record = try sample()
        return try HealthEngine(bundle: .main).blocking { [now] in try $0.planView(record: record, units: units, now: now, deviceId: "layout-test") }
    }

    /// Adversary R4: the engine's clock counts whole milliseconds, so a fast plan reads 0.
    func testTheFooterSaysUnderOneMillisecondForZero() {
        XCTAssertEqual(PlanView.workedOut(ms: 0), "Worked out on this iPhone in under 1 ms.")
        XCTAssertEqual(PlanView.workedOut(ms: 3), "Worked out on this iPhone in 3 ms.")
    }

    func testSampleRecordMatchesTheWebLayout() throws {
        let sections = try view().sections
        let layout = sections.map { section in (section.title, section.cards.map { $0.suggestions.map(\.id) }) }

        XCTAssertEqual(layout.map(\.0), ["Next Steps", "Foundation", "Skin Health", "Supplements"])
        XCTAssertEqual(layout[0].1, [
            ["screening-colorectal", "screening-cervical"],
            ["weight-med-glp1", "med-ezetimibe"],
            ["bp-stage1"],
            ["measure-waist"],
        ])
        XCTAssertEqual(layout[1].1, [
            ["protein-target", "low-salt", "lipid-diet"],
            ["exercise"],
            ["sleep"],
            ["screening-breast"],
            ["hba1c-normal"],
        ])
    }

    func testEveryCardKeepsItsEvidenceAndIngredients() throws {
        let record = try sample()
        let planJSON = try HealthEngine(bundle: .main).blocking { [now] in try $0.plan(recordJSON: record, now: now, deviceId: "layout-test") }
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(planJSON.utf8)) as? [String: Any])
        let rawSuggestions = try XCTUnwrap((raw["results"] as? [String: Any])?["suggestions"] as? [[String: Any]])

        let shown = try view().sections.flatMap(\.cards).flatMap(\.suggestions)

        for rawSuggestion in rawSuggestions {
            let id = try XCTUnwrap(rawSuggestion["id"] as? String)
            let suggestion = try XCTUnwrap(shown.first { $0.id == id }, "\(id) is not on screen")
            XCTAssertEqual(suggestion.reason, rawSuggestion["reason"] as? String, id)
            XCTAssertEqual(suggestion.link?.absoluteString, rawSuggestion["link"] as? String, id)
            XCTAssertEqual(suggestion.guidelines ?? [], rawSuggestion["guidelines"] as? [String] ?? [], id)
            XCTAssertEqual(suggestion.ingredients ?? [], rawSuggestion["ingredients"] as? [String] ?? [], id)
            let rawReferences = rawSuggestion["references"] as? [[String: String]] ?? []
            XCTAssertEqual(suggestion.references?.map(\.label) ?? [], rawReferences.compactMap { $0["label"] }, id)
            XCTAssertEqual(suggestion.references?.map(\.url.absoluteString) ?? [], rawReferences.compactMap { $0["url"] }, id)
        }
    }

    /// US-25 AC22: the summary tiles reach the screen as the engine wrote them, the web's
    /// Quick Stats, each with its why. Their wording is pinned in ios/engine/stat-tiles.test.ts.
    func testSampleSummaryTilesAreTheEngines() throws {
        let tiles = try view(units: #"{"hba1c":"conventional"}"#).tiles

        XCTAssertEqual(tiles.map(\.key), ["bmi", "ibw", "protein", "ldl", "hba1c"])
        XCTAssertEqual(tiles.map(\.label), ["BMI", "Ideal Body Weight", "Protein Target", "LDL Cholesterol", "HbA1c"])
        XCTAssertNil(tiles[0].status, "BMI 25-29.9 with no waist has no label, as on the web")
        XCTAssertEqual(tiles[3].status?.label, "Borderline")
        XCTAssertEqual(tiles[3].status?.tone, "info")
        XCTAssertEqual("\(tiles[4].value) \(tiles[4].unit)", "5.6 %", "the phone's own units (AC17e)")
        for tile in tiles { XCTAssertFalse(tile.evidence?.reason.isEmpty ?? true, tile.key) }
        // US-57 AC5: and what it is, so every tile opens.
        for tile in tiles {
            XCTAssertFalse(tile.about?.isEmpty ?? true, tile.key)
            XCTAssertTrue(tile.opens, tile.key)
        }
    }

    /// Re-check F1: a tile Swift cannot decode leaves no tiles, never a blank plan.
    func testAMalformedTileStillGivesTheSections() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let source = try String(contentsOf: url, encoding: .utf8) + """

        const realScreen = HealthEngine.screenJson;
        HealthEngine = Object.assign({}, HealthEngine, { screenJson: function (r, n, d, u) {
          const screen = JSON.parse(realScreen(r, n, d, u)); screen.plan.tiles = [{ key: 7 }]; return JSON.stringify(screen);
        } });

        """
        let record = try sample()
        let broken = try HealthEngine(source: source, sourceURL: url).blocking { [now] in
            try $0.planView(record: record, units: "{}", now: now, deviceId: "layout-test")
        }
        XCTAssertEqual(broken.tiles.count, 0)
        XCTAssertEqual(broken.sections.map(\.key), try view().sections.map(\.key))
        XCTAssertFalse(broken.sections.isEmpty)
    }
}
