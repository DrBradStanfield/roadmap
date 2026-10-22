import XCTest
@testable import HealthRoadmap

/// US-25 AC2: the app lays the plan out exactly as the web does, because both
/// call health-core's `planSections`, and every card keeps its evidence.
final class PlanLayoutTests: XCTestCase {
    private func samplePlan() throws -> (engine: HealthEngine, planJSON: String) {
        let fixtures = Bundle(for: Self.self)
        let record = try String(contentsOf: XCTUnwrap(fixtures.url(forResource: "sample.record", withExtension: "json")), encoding: .utf8)
        let engine = try HealthEngine(bundle: .main)
        // Pinned, like EngineParityTests: due dates and ages depend on the day.
        let now = try Date("2026-10-21T12:30:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        return (engine, try engine.blocking { [now] in try $0.plan(recordJSON: record, now: now, deviceId: "layout-test") })
    }

    func testSampleRecordMatchesTheWebLayout() throws {
        let (engine, planJSON) = try samplePlan()

        let sections = try engine.blocking { try $0.sections(planJSON: planJSON) }
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
        let (engine, planJSON) = try samplePlan()
        let raw = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(planJSON.utf8)) as? [String: Any])
        let rawSuggestions = try XCTUnwrap((raw["results"] as? [String: Any])?["suggestions"] as? [[String: Any]])

        let shown = try engine.blocking { try $0.sections(planJSON: planJSON) }.flatMap(\.cards).flatMap(\.suggestions)

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
}
