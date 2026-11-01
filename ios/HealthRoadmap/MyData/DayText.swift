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

    /// A card's day or time, as Apple Health writes it on its cards (US-25 AC17, US-56 AC6):
    /// "Today" (or, with `time`, the time of a reading today), "Yesterday", then the short date.
    static func when(_ date: Date, time: Bool = false, now: Date, calendar: Calendar) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return time ? date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, calendar: calendar, timeZone: calendar.timeZone)) : "Today"
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, calendar: calendar, timeZone: calendar.timeZone))
    }

    /// A record's YYYY-MM-DD the same way, read as noon of that day where the phone is; the
    /// text as given if it is not a day.
    static func when(day: String, now: Date, calendar: Calendar) -> String {
        noon(day, timeZone: calendar.timeZone).map { when($0, now: now, calendar: calendar) } ?? day
    }

    /// Midnight UTC of YYYY-MM-DD, for placing a value on a chart; nil if it is not a day.
    static func date(_ day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2]))
    }

    /// Noon of YYYY-MM-DD in `timeZone`, the moment of that day least likely to show on
    /// another one; nil if it is not a day.
    static func noon(_ day: String, timeZone: TimeZone = .current) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
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

    /// The latest birth month for `year`: this year's is this month (US-54 AC5b), as the zone
    /// furthest ahead (UTC+14) counts them, like the engine's own rule (merge.ts latestDayOnEarth).
    /// So the menu and the clamp never lower a month the engine accepts.
    static func latestBirthMonth(year: Int, now: Date) -> Int {
        year == furthestAhead.component(.year, from: now) ? furthestAhead.component(.month, from: now) : 12
    }

    /// Gregorian at UTC+14, where every day on Earth has already begun. Made once.
    private static let furthestAhead: Calendar = {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 14 * 3600)!
        return calendar
    }()

    /// Birth months a picker offers for `year`, and the month `keeping` when it is later,
    /// so a month stored in the future (by the web, say) still shows (review R4).
    static func birthMonths(year: Int, now: Date, keeping stored: Int? = nil) -> [Int] {
        let latest = latestBirthMonth(year: year, now: now)
        return Array(1...latest) + (stored.map { $0 > latest ? [$0] : [] } ?? [])
    }

    /// Birth years a picker offers, newest first.
    static func birthYears(now: Date) -> [Int] {
        Array((1900...gregorian.component(.year, from: now)).reversed())
    }
}
