import Foundation

/// The metric page's range picker (US-25 AC17), as Apple Health's: a week, a
/// month, six months or a year, never more (Brad 2026-10-25: no All). Days are
/// midnight UTC of the record's YYYY-MM-DD (`DayText.date`), so the maths never
/// meets a time zone.
enum ChartRange: String, CaseIterable, Identifiable {
    case week = "W", month = "M", sixMonths = "6M", year = "Y"

    var id: String { rawValue }

    /// What VoiceOver says for the picker's segment.
    var spoken: String {
        switch self {
        case .week: "Week"
        case .month: "Month"
        case .sixMonths: "Six months"
        case .year: "Year"
        }
    }

    /// The first day the range shows when it ends on `last`, the newest value.
    func start(ending last: Date) -> Date {
        let (unit, value): (Calendar.Component, Int) = switch self {
        case .week: (.day, -6) // the last day and the six before it
        case .month: (.month, -1)
        case .sixMonths: (.month, -6)
        case .year: (.year, -1)
        }
        return DayText.utc.date(byAdding: unit, value: value, to: last) ?? last
    }

    /// The range a page opens on: the narrowest that holds every value, else a year. The
    /// picker always offers all four, as Apple Health's does, and every range ends on the
    /// newest value and scrolls back across the rest (Brad 2026-10-23, 2026-10-25).
    static func opening(for days: [Date]) -> ChartRange {
        guard let first = days.min(), let last = days.max() else { return .year }
        return allCases.first { $0.start(ending: last) <= first } ?? .year
    }

    /// Whether a scrolling chart labels a tick: not within 6% of either visible edge, where
    /// the label would be cut in half ("/lay" for May; review 2026-10-25). The tick and its
    /// grid line still draw.
    static func labels(_ date: Date, from start: Date, length: TimeInterval) -> Bool {
        let margin = length * 0.06
        return date >= start.addingTimeInterval(margin) && date <= start.addingTimeInterval(length - margin)
    }

    /// The item whose date (`by`: `\.self` for days) is closest to a scrubbing finger.
    static func nearest<Item>(to date: Date, in items: [Item], by key: KeyPath<Item, Date>) -> Item? {
        items.min { abs($0[keyPath: key].timeIntervalSince(date)) < abs($1[keyPath: key].timeIntervalSince(date)) }
    }
}
