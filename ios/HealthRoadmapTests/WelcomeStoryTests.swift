import XCTest
@testable import HealthRoadmap

/// US-25 AC10: the welcome story's spoken summary keeps the data promise and names
/// the sources (App Review 1.4.1).
final class WelcomeStoryTests: XCTestCase {
    func testTheSummaryNamesWhereTheDataLivesAndWhatFillsIt() {
        XCTAssertTrue(WelcomeStory.summary.contains("never on our servers"))
        XCTAssertTrue(WelcomeStory.summary.contains("Dropbox or Google Drive"))
        XCTAssertTrue(WelcomeStory.summary.contains("Apple Health"))
    }
}
