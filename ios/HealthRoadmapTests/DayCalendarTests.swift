import UIKit
import XCTest
@testable import HealthRoadmap

/// PR 1908 fix round, item 6, and Codex pass on d31f5855a, item 1: a day picker opens with no day
/// selected, one tap on today picks today, and the day sent is the Gregorian day tapped whatever
/// calendar the phone uses (a Japanese calendar once sent year 0008, a Buddhist one 2569).
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

    /// The app's calendar is Gregorian; a selection in a Japanese or Buddhist calendar, with or
    /// without its calendar attached, in Auckland or Los Angeles, sends the Gregorian day tapped.
    func testTheDaySentIsTheGregorianDayInAnyPhoneCalendarAndZone() throws {
        XCTAssertEqual(DayCalendar.calendar(delegate: .init(picked: { _ in })).calendar.identifier, .gregorian)
        for zone in ["Pacific/Auckland", "America/Los_Angeles"] {
            for identifier in [Calendar.Identifier.japanese, .buddhist] {
                var phone = Calendar(identifier: identifier)
                phone.timeZone = try XCTUnwrap(TimeZone(identifier: zone))
                var gregorian = Calendar(identifier: .gregorian)
                gregorian.timeZone = phone.timeZone
                let tapped = try XCTUnwrap(gregorian.date(from: DateComponents(year: 2026, month: 11, day: 20, hour: 12)))
                var withCalendar = phone.dateComponents([.era, .year, .month, .day], from: tapped)
                withCalendar.calendar = phone
                var bare = withCalendar
                bare.calendar = nil
                for components in [withCalendar, bare] {
                    var picked: [String] = []
                    let coordinator = DayCalendar.Coordinator(picked: { picked.append($0) })
                    let view = DayCalendar.calendar(delegate: coordinator, calendar: phone)
                    let selection = try XCTUnwrap(view.selectionBehavior as? UICalendarSelectionSingleDate)
                    coordinator.dateSelection(selection, didSelectDate: components)
                    XCTAssertEqual(picked, ["2026-11-20"], "\(identifier) \(zone) calendar attached: \(components.calendar != nil)")
                }
            }
        }
    }
}
