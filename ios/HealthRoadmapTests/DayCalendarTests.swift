import UIKit
import XCTest
@testable import HealthRoadmap

/// PR 1908 fix round, item 6: a day picker opens with no day selected, and one tap on today picks
/// today (a calendar that pre-selects today could not pick it with one tap).
@MainActor
final class DayCalendarTests: XCTestCase {
    func testTheCalendarOpensWithNoDaySelectedAndOneTapOnTodayPicksIt() throws {
        var picked: [String] = []
        let coordinator = DayCalendar.Coordinator(picked: { picked.append($0) })
        let now = try XCTUnwrap(Calendar(identifier: .gregorian).date(from: DateComponents(year: 2026, month: 11, day: 20, hour: 12)))
        let view = DayCalendar.calendar(delegate: coordinator, now: now, calendar: Calendar(identifier: .gregorian))
        let selection = try XCTUnwrap(view.selectionBehavior as? UICalendarSelectionSingleDate)
        XCTAssertNil(selection.selectedDate, "no day is assumed")
        XCTAssertEqual(view.availableDateRange.end, now, "no day after today")
        coordinator.dateSelection(selection, didSelectDate: DateComponents(year: 2026, month: 11, day: 20))
        XCTAssertEqual(picked, ["2026-11-20"], "one tap on today picks today")
        coordinator.dateSelection(selection, didSelectDate: nil)
        XCTAssertEqual(picked, ["2026-11-20"], "clearing picks nothing")
    }
}
