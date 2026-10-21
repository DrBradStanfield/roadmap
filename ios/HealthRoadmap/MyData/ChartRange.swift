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

    /// The first day the range shows, ending today; nil for All.
    func start(today: Date) -> Date? {
        let step: (Calendar.Component, Int)? = switch self {
        case .week: (.day, -6)
        case .month: (.month, -1)
        case .sixMonths: (.month, -6)
        case .year: (.year, -1)
        case .all: nil
        }
        guard let step else { return nil }
        return Self.utc.date(byAdding: step.0, value: step.1, to: today)
    }

    /// The ranges worth offering: each that holds some values but not all, then
    /// All. A range holding every value would draw the same chart as All.
    static func offered(for days: [Date], today: Date) -> [ChartRange] {
        allCases.filter { range in
            guard let start = range.start(today: today) else { return true }
            let inside = days.filter { $0 >= start }.count
            return inside > 0 && inside < days.count
        }
    }

    /// The value day closest to a scrubbing finger.
    static func nearest(to date: Date, in days: [Date]) -> Date? {
        days.min { abs($0.timeIntervalSince(date)) < abs($1.timeIntervalSince(date)) }
    }

    private static var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }
}
