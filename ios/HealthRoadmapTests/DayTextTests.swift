import XCTest
@testable import HealthRoadmap

/// US-25 AC5 with US-31 AC11: a value's day is the phone's local day, and a
/// stored day prints as itself in any zone.
final class DayTextTests: XCTestCase {
    func testTheDayIsThePhonesLocalDay() throws {
        let morningInAuckland = try Date("2026-10-20T20:30:00Z", strategy: .iso8601)
        var auckland = Calendar(identifier: .gregorian)
        auckland.timeZone = try XCTUnwrap(TimeZone(identifier: "Pacific/Auckland"))
        XCTAssertEqual(DayText.iso(morningInAuckland, calendar: auckland), "2026-10-21")
    }

    func testAStoredDayPrintsAsItself() {
        XCTAssertTrue(DayText.short("2026-10-20").contains("20"), DayText.short("2026-10-20"))
        XCTAssertEqual(DayText.short("not a day"), "not a day")
    }
}
