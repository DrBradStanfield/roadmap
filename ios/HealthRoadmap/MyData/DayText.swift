import Foundation

/// Calendar days as the record stores them, YYYY-MM-DD. A clinical day is a
/// date, not a moment, so it is never shifted by a time zone (US-31 AC11).
enum DayText {
    /// The phone's local day for a moment, as YYYY-MM-DD.
    static func iso(_ date: Date, calendar: Calendar = .current) -> String {
        let parts = calendar.dateComponents([.year, .month, .day], from: date)
        return String(format: "%04d-%02d-%02d", parts.year ?? 0, parts.month ?? 0, parts.day ?? 0)
    }

    /// "20 Oct 2026" from YYYY-MM-DD, in the phone's language; the text as given if it is not a day.
    static func short(_ day: String) -> String {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return day }
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        guard let date = utc.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2])) else { return day }
        return date.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: .gmt))
    }
}
