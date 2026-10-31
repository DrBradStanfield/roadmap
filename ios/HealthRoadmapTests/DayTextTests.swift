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

    func testTheDayIsGregorianWhateverCalendarThePhoneUses() throws {
        // Adversary R1: a Japanese-calendar phone saved year 0008, a Buddhist one 2569.
        let morningInAuckland = try Date("2026-10-20T20:30:00Z", strategy: .iso8601)
        for identifier in [Calendar.Identifier.japanese, .buddhist, .islamicUmmAlQura, .persian, .hebrew] {
            var phone = Calendar(identifier: identifier)
            phone.timeZone = try XCTUnwrap(TimeZone(identifier: "Pacific/Auckland"))
            XCTAssertEqual(DayText.iso(morningInAuckland, calendar: phone), "2026-10-21", "\(identifier)")
        }
    }

    /// US-25 AC8/AC9: a screening month and a chart day are calendar dates, never shifted by the zone.
    func testAScreeningMonthAndAChartDayAreNotShifted() throws {
        XCTAssertTrue(DayText.month("2025-03").contains("2025"))
        XCTAssertEqual(DayText.month("not a month"), "not a month")
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        let date = try XCTUnwrap(DayText.date("2026-10-01"))
        XCTAssertEqual(utc.dateComponents([.year, .month, .day], from: date), DateComponents(year: 2026, month: 10, day: 1))
        XCTAssertNil(DayText.date("2026-10"))
    }

    func testBirthYearsAreGregorian() throws {
        let now = try Date("2026-10-21T00:00:00Z", strategy: .iso8601)
        let years = DayText.birthYears(now: now)
        XCTAssertEqual(years.first, 2026)
        XCTAssertEqual(years.last, 1900)
    }

    /// US-54 AC5b: no birth month after this one is offered. Every month of an earlier
    /// year is; this year's stop at this month.
    func testBirthMonthsStopAtThisMonthThisYear_US54_AC5b() throws {
        let now = try Date("2026-10-21T00:00:00Z", strategy: .iso8601)
        XCTAssertEqual(DayText.birthMonths(year: 2026, now: now), Array(1...10))
        XCTAssertEqual(DayText.birthMonths(year: 2025, now: now), Array(1...12))
        XCTAssertEqual(DayText.latestBirthMonth(year: 2026, now: now), 10, "onboarding moves a later month back to this one")
        XCTAssertEqual(DayText.latestBirthMonth(year: 2025, now: now), 12)
    }

    /// Review R4: a month stored in the future (the web saved December this year) still
    /// shows in the menu, never a blank one; a month in range is not offered twice.
    func testAStoredFutureMonthStaysInTheMenu_US54_AC5b() throws {
        let now = try Date("2026-10-21T00:00:00Z", strategy: .iso8601)
        XCTAssertEqual(DayText.birthMonths(year: 2026, now: now, keeping: 12), Array(1...10) + [12])
        XCTAssertEqual(DayText.birthMonths(year: 2026, now: now, keeping: 3), Array(1...10))
        XCTAssertEqual(DayText.birthMonths(year: 2026, now: now, keeping: nil), Array(1...10))
    }

    /// Review R4: changing only the year, as onboarding's wheel does, moves a stored month
    /// that would then be in the future back to the latest one, in the same edit.
    func testANewBirthYearMovesAFutureMonthBack_US54_AC5b() throws {
        let now = try Date("2026-10-21T00:00:00Z", strategy: .iso8601)
        XCTAssertEqual(RecordEdit.birthYear(2026, storedMonth: 12, now: now), .profile(birthYear: 2026, birthMonth: 10))
        XCTAssertEqual(RecordEdit.birthYear(2026, storedMonth: 4, now: now), .profile(birthYear: 2026))
        XCTAssertEqual(RecordEdit.birthYear(2025, storedMonth: 12, now: now), .profile(birthYear: 2025))
        XCTAssertEqual(RecordEdit.birthYear(2026, storedMonth: nil, now: now), .profile(birthYear: 2026))
    }

    /// Review round 2 N1: "this month" is the engine's, judged at UTC+14, in any phone zone.
    /// On 30 Sep at 10:30 UTC it is already October there (not yet in New Zealand); on 31 Dec it is already next year.
    func testTheLatestBirthMonthIsJudgedWhereTheDayBeginsFirst_US54_AC5b() throws {
        let october = try Date("2026-09-30T10:30:00Z", strategy: .iso8601)
        XCTAssertEqual(DayText.latestBirthMonth(year: 2026, now: october), 10)
        XCTAssertEqual(RecordEdit.birthYear(2026, storedMonth: 10, now: october), .profile(birthYear: 2026))
        let newYear = try Date("2026-12-31T10:30:00Z", strategy: .iso8601)
        XCTAssertEqual(DayText.latestBirthMonth(year: 2026, now: newYear), 12)
        XCTAssertEqual(DayText.latestBirthMonth(year: 2027, now: newYear), 1)
        XCTAssertEqual(RecordEdit.birthYear(2026, storedMonth: 12, now: newYear), .profile(birthYear: 2026))
    }

    func testAStoredDayPrintsAsItself() {
        XCTAssertTrue(DayText.short("2026-10-20").contains("20"), DayText.short("2026-10-20"))
        XCTAssertEqual(DayText.short("not a day"), "not a day")
    }

    /// Noon of a stored day in a given zone: a lab review's date picker and a typed value
    /// sent to Apple Health use it, so the day never shifts.
    func testNoonIsTwelveOnThatDayInTheZone() throws {
        let auckland = try XCTUnwrap(TimeZone(identifier: "Pacific/Auckland"))
        XCTAssertEqual(DayText.noon("2026-10-21", timeZone: auckland), try Date("2026-10-20T23:00:00Z", strategy: .iso8601))
        XCTAssertEqual(DayText.noon("2026-10-21", timeZone: .gmt), try Date("2026-10-21T12:00:00Z", strategy: .iso8601))
        XCTAssertNil(DayText.noon("not a day"))
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = auckland
        XCTAssertEqual(DayText.iso(try XCTUnwrap(DayText.noon("2026-04-05", timeZone: auckland)), calendar: calendar), "2026-04-05", "the day the clocks go back")
    }
}
