import XCTest
@testable import HealthRoadmap

/// US-25 AC2: the plan screen groups suggestions the way the web's results panel does.
final class PlanSectionTests: XCTestCase {
    private func suggestion(_ id: String, _ priority: String, _ category: String) -> Plan.Suggestion {
        Plan.Suggestion(id: id, category: category, priority: priority, title: id, description: "")
    }

    func testGroupsMatchTheWebInOrder() {
        let sections = PlanSection.sections(for: [
            suggestion("sun", "info", "skin"),
            suggestion("protein", "info", "nutrition"),
            suggestion("creatine", "info", "supplements"),
            suggestion("bp", "attention", "blood_pressure"),
            suggestion("lpa", "urgent", "bloodwork"),
        ])

        XCTAssertEqual(sections.map(\.title), ["Requires Attention", "Next Steps", "Foundation", "Skin Health", "Supplements"])
        XCTAssertEqual(sections.map { $0.suggestions.map(\.id) }, [["lpa"], ["bp"], ["protein"], ["sun"], ["creatine"]])
    }

    func testEmptyGroupsAreLeftOut() {
        let sections = PlanSection.sections(for: [suggestion("protein", "info", "nutrition")])

        XCTAssertEqual(sections.map(\.title), ["Foundation"])
    }
}
