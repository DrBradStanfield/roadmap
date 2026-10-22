import XCTest
@testable import HealthRoadmap

/// US-25 AC17e: per-test units are the phone's own preference, sent to the engine as JSON.
final class UnitChoicesTests: XCTestCase {
    func testAChoiceIsSetDroppedAndSentSorted() {
        let choices = UnitChoices().setting("ldl", to: "conventional").setting("apob", to: "conventional")
        XCTAssertEqual(choices.json, #"{"apob":"conventional","ldl":"conventional"}"#)
        XCTAssertEqual(choices.setting("ldl", to: nil).json, #"{"apob":"conventional"}"#)
        XCTAssertTrue(UnitChoices().isEmpty)
        XCTAssertEqual(UnitChoices().json, "{}")
    }

    func testChoicesSurviveARelaunchAndAnEmptySetIsRemoved() throws {
        let defaults = try XCTUnwrap(UserDefaults(suiteName: "UnitChoicesTests-\(UUID().uuidString)"))
        UnitChoices().setting("weight", to: "conventional").save(defaults)
        XCTAssertEqual(UnitChoices.saved(defaults).json, #"{"weight":"conventional"}"#)
        UnitChoices().save(defaults)
        XCTAssertTrue(UnitChoices.saved(defaults).isEmpty)
    }
}
