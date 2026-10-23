import Foundation

/// The metric page's range picker (US-25 AC17), as Apple Health's: a week, a
/// month, six months, a year, or everything. Days are midnight UTC of the
/// record's YYYY-MM-DD (`DayText.date`), so the maths never meets a time zone.
enum ChartRange: String, CaseIterable, Identifiable {
    case week = "W", month = "M", sixMonths = "6M", year = "Y", all = "All"

    var id: String { rawValue }

    /// What VoiceOver says for the picker's segment.
    var spoken: String {
        switch self {
        case .week: "Week"
        case .month: "Month"
        case .sixMonths: "Six months"
        case .year: "Year"
        case .all: "All"
        }
    }

    /// A week's span in days, first to last: today and the six before it.
    static let weekDays = 6

    /// Values spanning less than a week, under All: a week around their middle. The
    /// chart's own fit would span a day or two and label the axis by the hour.
    static func atLeastAWeek(_ days: [Date]) -> ClosedRange<Date>? {
        guard let first = days.min(), let last = days.max(),
              let weekOn = DayText.utc.date(byAdding: .day, value: weekDays, to: first), last < weekOn
        else { return nil }
        let half = TimeInterval(weekDays) * 86_400 / 2
        let middle = first.addingTimeInterval(last.timeIntervalSince(first) / 2)
        return middle.addingTimeInterval(-half)...middle.addingTimeInterval(half)
    }

    /// The first day the range shows, ending on `today` (the newest value, when the chart
    /// opens there); nil for All.
    func start(today: Date) -> Date? {
        let step: (Calendar.Component, Int)? = switch self {
        case .week: (.day, -Self.weekDays)
        case .month: (.month, -1)
        case .sixMonths: (.month, -6)
        case .year: (.year, -1)
        case .all: nil
        }
        guard let step else { return nil }
        return DayText.utc.date(byAdding: step.0, value: step.1, to: today)
    }

    /// The ranges worth offering: each shorter than the values' span, then All. One
    /// spanning them all would draw the same chart as All. The chart opens a range on
    /// the newest value and scrolls back from there, as Apple Health's does (Brad 2026-10-23).
    static func offered(for days: [Date]) -> [ChartRange] {
        guard let first = days.min(), let last = days.max() else { return [.all] }
        return allCases.filter { range in
            guard let start = range.start(today: last) else { return true }
            return start > first
        }
    }

    /// The value day closest to a scrubbing finger.
    static func nearest(to date: Date, in days: [Date]) -> Date? {
        days.min { abs($0.timeIntervalSince(date)) < abs($1.timeIntervalSince(date)) }
    }
}
