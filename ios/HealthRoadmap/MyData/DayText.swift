import Foundation

/// Calendar days as the record stores them, YYYY-MM-DD. A clinical day is a
/// date, not a moment, so it is never shifted by a time zone (US-31 AC11).
/// Always Gregorian: a phone set to the Japanese or Buddhist calendar would
/// otherwise save year 0008 or 2569.
enum DayText {
    /// The Gregorian calendar in the phone's zone and language.
    static var gregorian: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .current
        calendar.locale = .current
        return calendar
    }

    /// Gregorian in UTC, where the record's days live as dates (charts place them at midnight UTC). Made once.
    static let utc: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }()

    /// The local day for a moment, as YYYY-MM-DD, in `calendar`'s time zone.
    static func iso(_ date: Date, calendar: Calendar = .current) -> String {
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = calendar.timeZone
        let parts = gregorian.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// "20 Oct 2026" from YYYY-MM-DD, in the phone's language; the text as given if it is not a day.
    static func short(_ day: String) -> String {
        date(day)?.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: .gmt)) ?? day
    }

    /// Midnight UTC of YYYY-MM-DD, for placing a value on a chart; nil if it is not a day.
    static func date(_ day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// "March 2025" from YYYY-MM (a screening date), in the phone's language; the text as given if it is not a month.
    static func month(_ month: String) -> String {
        guard let date = date("\(month)-01") else { return month }
        return date.formatted(Date.FormatStyle(timeZone: .gmt).month(.wide).year())
    }

    /// "January" for 1, in the phone's language.
    static func monthName(_ month: Int) -> String {
        gregorian.monthSymbols[month - 1]
    }

    /// Birth years a picker offers, newest first.
    static func birthYears(now: Date) -> [Int] {
        Array((1900...gregorian.component(.year, from: now)).reversed())
    }
}
