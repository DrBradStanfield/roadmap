import Foundation

/// The five Apple Health metrics the app shows and never keeps (US-56): read live from
/// HealthKit each time they show, held in memory only while the app is open, never in
/// the record, a cache file or UserDefaults, and never sent to telemetry or a log.
/// Display only (AC1): nothing here feeds the plan, the engine or the chat.
enum LiveMetric: String, CaseIterable, Identifiable, Hashable, Sendable {
    case heartRate, restingHeartRate, sleep, vo2Max, steps

    var id: String { rawValue }

    /// Heart rate, resting heart rate and sleep sit in Vitals; VO2 max and steps under Fitness (AC6).
    static let vitals: [LiveMetric] = [.heartRate, .restingHeartRate, .sleep]
    static let fitness: [LiveMetric] = [.vo2Max, .steps]

    /// Apple Health's names, VO2 max as the story names it.
    var label: String {
        switch self {
        case .heartRate: "Heart Rate"
        case .restingHeartRate: "Resting Heart Rate"
        case .sleep: "Sleep"
        case .vo2Max: "VO2 max"
        case .steps: "Steps"
        }
    }

    /// One unit each (AC6): the unit switch never changes them.
    var unit: String {
        switch self {
        case .heartRate, .restingHeartRate: "bpm"
        case .sleep: ""
        case .vo2Max: "mL/kg/min"
        case .steps: "steps"
        }
    }

    /// What VoiceOver says for the unit (AC12).
    var spokenUnit: String {
        switch self {
        case .heartRate, .restingHeartRate: "beats per minute"
        case .sleep: ""
        case .vo2Max: "millilitres per kilogram per minute"
        case .steps: "steps"
        }
    }

    /// The key of its graph colour in `MetricChart.palette`.
    var paletteKey: String {
        switch self {
        case .heartRate: "heart_rate"
        case .restingHeartRate: "resting_heart_rate"
        case .sleep: "sleep"
        case .vo2Max: "vo2_max"
        case .steps: "steps"
        }
    }

    /// The value as Apple Health writes it: whole beats and steps (steps grouped), VO2 max to one place.
    func text(_ value: Double) -> String {
        switch self {
        case .heartRate, .restingHeartRate: String(Int(value.rounded()))
        case .steps: Int(value.rounded()).formatted(.number.grouping(.automatic))
        case .vo2Max: value.formatted(.number.precision(.fractionLength(1)))
        case .sleep: LiveMaths.duration(value).map { "\($0.0) \($0.1)" }.joined(separator: " ")
        }
    }
}

/// One bar or point: an hour, a day, a week or a month, starting at `start`. Steps carry
/// `value` (the sum, or a daily average for a week or month); heart rate `low` and `high`
/// (and `value`, the average, for its trend); resting heart rate and VO2 max `value`.
struct LivePoint: Equatable, Sendable, Identifiable {
    let start: Date
    var value: Double?
    var low: Double?
    var high: Double?

    var id: Date { start }
}

/// The latest reading of one metric, for its card.
struct LiveCard: Equatable, Sendable {
    let value: Double
    /// When it was taken (heart rate) or the day or night it belongs to.
    let date: Date
    /// Heart rate's card shows the reading's time today, as Apple Health's does.
    let showsTime: Bool
    /// The recent days or nights, oldest first, for the card's trend line.
    let trend: [Double]
    /// Sleep from a writer that records only "In Bed": the value is time in bed (AC9, Codex R3).
    var inBed = false
}

/// A range of a metric page (AC7): a day by hour, a week or month by day, six months
/// by week, a year by month, as Apple Health buckets them. Sleep offers D, W, M, 6M.
enum LiveRange: String, CaseIterable, Identifiable, Sendable {
    case day = "D", week = "W", month = "M", sixMonths = "6M", year = "Y"

    var id: String { rawValue }

    static let sleep: [LiveRange] = [.day, .week, .month, .sixMonths]

    var spoken: String {
        switch self {
        case .day: "Day"
        case .week: "Week"
        case .month: "Month"
        case .sixMonths: "Six months"
        case .year: "Year"
        }
    }

    /// What one bar or point covers.
    var bucket: Calendar.Component {
        switch self {
        case .day: .hour
        case .week, .month: .day
        case .sixMonths: .weekOfYear
        case .year: .month
        }
    }

    /// The first instant the range shows when it ends at `end`.
    func start(ending end: Date, calendar: Calendar) -> Date {
        let (unit, value): (Calendar.Component, Int) = switch self {
        case .day: (.day, -1)
        case .week: (.day, -7)
        case .month: (.month, -1)
        case .sixMonths: (.month, -6)
        case .year: (.year, -1)
        }
        return calendar.date(byAdding: unit, value: value, to: end) ?? end
    }
}

/// Apple's sleep stages (AC9). A source with no stages records only asleep or in bed.
enum SleepStage: String, CaseIterable, Sendable, Comparable {
    case awake, rem, core, deep, asleep, inBed

    /// Drawn top to bottom in this order, as Apple Health's hypnogram.
    static let drawn: [SleepStage] = [.awake, .rem, .core, .deep]

    var label: String {
        switch self {
        case .awake: "Awake"
        case .rem: "REM"
        case .core: "Core"
        case .deep: "Deep"
        case .asleep: "Asleep"
        case .inBed: "In Bed"
        }
    }

    var isAsleep: Bool { self == .rem || self == .core || self == .deep || self == .asleep }
    var isStage: Bool { self == .rem || self == .core || self == .deep }

    static func < (a: Self, b: Self) -> Bool {
        allCases.firstIndex(of: a)! < allCases.firstIndex(of: b)!
    }
}

/// One sleep sample: a stage from `start` to `end`, written by `source` (a bundle id,
/// used only to pick one writer per night; never shown or logged).
struct SleepSegment: Equatable, Sendable {
    let stage: SleepStage
    let start: Date
    let end: Date
    let source: String
}

/// One night, dated the morning it ends (AC2): what it drew and its totals.
struct SleepNight: Equatable, Sendable, Identifiable {
    /// Local midnight of the day the night belongs to.
    let day: Date
    /// The segments drawn: the chosen writer's stages, overlaps kept as recorded.
    let segments: [SleepSegment]
    /// Time asleep: every asleep stage, overlaps counted once.
    let asleep: TimeInterval
    /// Time in bed, from any writer (the iPhone's sleep schedule often).
    let inBed: TimeInterval
    /// Each stage's time, overlaps counted once; awake included. Empty for no stages.
    let stages: [SleepStage: TimeInterval]

    var id: Date { day }
    var hasStages: Bool { stages.keys.contains(where: \.isStage) }
    var start: Date { segments.map(\.start).min() ?? day }
    var end: Date { segments.map(\.end).max() ?? day }
}

/// The pure maths of US-56 (tested in LiveMathsTests). HealthKit's statistics queries do
/// the daily sums and ranges; this buckets them into weeks and months, works out each
/// range's headline, the cards' latest and trend, and sleep's nights.
enum LiveMaths {
    /// Hours and minutes, as Apple Health writes sleep: "7 hr 32 min", "45 min", "8 hr".
    static func duration(_ seconds: TimeInterval) -> [(String, String)] {
        let minutes = Int((seconds / 60).rounded())
        let (hours, rest) = (minutes / 60, minutes % 60)
        if hours == 0 { return [(String(rest), "min")] }
        return rest == 0 ? [(String(hours), "hr")] : [(String(hours), "hr"), (String(rest), "min")]
    }

    // MARK: Buckets

    /// Days grouped into weeks or months: steps as the daily average of the days with
    /// steps (Apple Health's 6M and Y bars), heart rate as the lowest to highest, resting
    /// heart rate and VO2 max as the mean.
    static func bucket(_ days: [LivePoint], by component: Calendar.Component, metric: LiveMetric, calendar: Calendar) -> [LivePoint] {
        guard component != .day, component != .hour else { return days }
        let groups = Dictionary(grouping: days) { calendar.dateInterval(of: component, for: $0.start)?.start ?? $0.start }
        return groups.keys.sorted().map { start in
            let group = groups[start]!
            let values = group.compactMap(\.value)
            return LivePoint(start: start,
                             value: values.isEmpty ? nil : values.reduce(0, +) / Double(values.count),
                             low: group.compactMap(\.low).min(),
                             high: group.compactMap(\.high).max())
        }
    }

    // MARK: Headline

    struct Headline: Equatable {
        /// "Total", "Average" or "Range", as Apple Health heads its chart.
        let title: String
        /// The number, or "52–140" for a range; nil when the window holds nothing.
        let value: String?
    }

    /// The headline for what is in view: steps a day's total or the daily average, heart
    /// rate its lowest to highest, resting heart rate and VO2 max their average. `points`
    /// are the range's own buckets for D (hours) and W or M (days); for 6M and Y pass the days,
    /// so the average is of days, not of weekly averages.
    static func headline(_ metric: LiveMetric, range: LiveRange, points: [LivePoint]) -> Headline {
        switch metric {
        case .heartRate:
            guard let low = points.compactMap(\.low).min(), let high = points.compactMap(\.high).max() else { return Headline(title: "Range", value: nil) }
            return Headline(title: "Range", value: "\(metric.text(low))–\(metric.text(high))")
        case .steps where range == .day:
            let values = points.compactMap(\.value)
            return Headline(title: "Total", value: values.isEmpty ? nil : metric.text(values.reduce(0, +)))
        default:
            let values = points.compactMap(\.value)
            return Headline(title: "Average", value: values.isEmpty ? nil : metric.text(values.reduce(0, +) / Double(values.count)))
        }
    }

    // MARK: Cards

    /// A card from the recent days: the newest day with a value, and up to the last seven
    /// days' values for its trend. Heart rate's card takes its newest sample (`latest`) and
    /// its days' averages for the trend.
    static func card(days: [LivePoint], latest: (value: Double, date: Date)? = nil) -> LiveCard? {
        let held = days.filter { $0.value != nil }.sorted { $0.start < $1.start }
        let trend = held.suffix(7).compactMap(\.value)
        if let latest { return LiveCard(value: latest.value, date: latest.date, showsTime: true, trend: trend) }
        guard let newest = held.last, let value = newest.value else { return nil }
        return LiveCard(value: value, date: newest.start, showsTime: false, trend: trend)
    }

    /// Sleep's card: the newest night's time asleep, and the last seven nights' for its trend
    /// (in hours). A night recorded only as In Bed shows its time in bed, as Apple Health
    /// shows it (AC9, Codex R3).
    static func card(nights: [SleepNight]) -> LiveCard? {
        let held = nights.filter { $0.asleep > 0 || $0.inBed > 0 }.sorted { $0.day < $1.day }
        guard let newest = held.last else { return nil }
        return LiveCard(value: shown(newest), date: newest.day, showsTime: false, trend: held.suffix(7).map { shown($0) / 3600 },
                        inBed: newest.asleep == 0)
    }

    /// A night's time asleep, or its time in bed when it has no sleep.
    static func shown(_ night: SleepNight) -> TimeInterval {
        night.asleep > 0 ? night.asleep : night.inBed
    }

    /// The card's day or time, as Apple Health writes it: the time for a reading today
    /// (heart rate), "Today", "Yesterday", else the day.
    static func when(_ date: Date, showsTime: Bool, now: Date, calendar: Calendar) -> String {
        if calendar.isDate(date, inSameDayAs: now) {
            return showsTime ? date.formatted(Date.FormatStyle(date: .omitted, time: .shortened, calendar: calendar, timeZone: calendar.timeZone)) : "Today"
        }
        if let yesterday = calendar.date(byAdding: .day, value: -1, to: now), calendar.isDate(date, inSameDayAs: yesterday) { return "Yesterday" }
        return date.formatted(Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone).day().month(.abbreviated))
    }

    // MARK: Sleep

    /// A night's day: sleep starting from 6 pm on belongs to the next morning, so a night
    /// from 11 pm to 7 am, and every segment of it, is dated the day it ends (AC2), in the
    /// zone of the calendar given (the phone's).
    static func nightDay(of segment: SleepSegment, calendar: Calendar) -> Date {
        calendar.startOfDay(for: segment.start.addingTimeInterval(6 * 3600))
    }

    /// Segments as nights, oldest first. Several writers can record one night (a watch, the
    /// iPhone's sleep schedule, a third-party app); Apple Health shows one by its source order,
    /// which apps cannot read. So: the writer with the most staged time draws the stages; with
    /// no stages, every writer's "asleep" is joined; "In Bed" is joined from all of them.
    static func nights(_ segments: [SleepSegment], calendar: Calendar) -> [SleepNight] {
        let byDay = Dictionary(grouping: segments.filter { $0.end > $0.start }) { nightDay(of: $0, calendar: calendar) }
        return byDay.keys.sorted().map { day in
            let all = byDay[day]!
            let staged = Dictionary(grouping: all.filter(\.stage.isStage), by: \.source)
                .mapValues { covered($0.map { ($0.start, $0.end) }) }
            let chosen: [SleepSegment]
            if let writer = staged.max(by: { $0.value < $1.value || ($0.value == $1.value && $0.key > $1.key) })?.key {
                chosen = all.filter { $0.source == writer && $0.stage != .inBed }
            } else {
                chosen = all.filter { $0.stage == .asleep || $0.stage == .awake }
            }
            let inBed = all.filter { $0.stage == .inBed }
            var stages: [SleepStage: TimeInterval] = [:]
            if chosen.contains(where: \.stage.isStage) {
                for stage in [SleepStage.awake, .rem, .core, .deep] {
                    stages[stage] = covered(chosen.filter { $0.stage == stage }.map { ($0.start, $0.end) })
                }
            }
            let drawn = (chosen + inBed).sorted { ($0.start, $0.stage) < ($1.start, $1.stage) }
            return SleepNight(day: day, segments: drawn,
                              asleep: covered(chosen.filter(\.stage.isAsleep).map { ($0.start, $0.end) }),
                              inBed: covered(inBed.map { ($0.start, $0.end) }),
                              stages: stages)
        }
    }

    /// The nights' average time asleep, of nights with any sleep.
    static func averageAsleep(_ nights: [SleepNight]) -> TimeInterval? {
        let held = nights.map(\.asleep).filter { $0 > 0 }
        return held.isEmpty ? nil : held.reduce(0, +) / Double(held.count)
    }

    /// The nights' average time in bed, of nights in bed.
    static func averageInBed(_ nights: [SleepNight]) -> TimeInterval? {
        let held = nights.map(\.inBed).filter { $0 > 0 }
        return held.isEmpty ? nil : held.reduce(0, +) / Double(held.count)
    }

    /// Each stage's average, of the nights with stages (Apple Health's stage averages).
    static func stageAverages(_ nights: [SleepNight]) -> [SleepStage: TimeInterval] {
        let staged = nights.filter(\.hasStages)
        guard !staged.isEmpty else { return [:] }
        var averages: [SleepStage: TimeInterval] = [:]
        for stage in SleepStage.drawn {
            averages[stage] = staged.map { $0.stages[stage] ?? 0 }.reduce(0, +) / Double(staged.count)
        }
        return averages
    }

    /// How long the intervals cover, overlaps counted once.
    static func covered(_ intervals: [(Date, Date)]) -> TimeInterval {
        var total: TimeInterval = 0
        var open: (Date, Date)?
        for (start, end) in intervals.sorted(by: { $0.0 < $1.0 }) where end > start {
            if let current = open, start <= current.1 {
                open = (current.0, max(current.1, end))
            } else {
                if let current = open { total += current.1.timeIntervalSince(current.0) }
                open = (start, end)
            }
        }
        if let current = open { total += current.1.timeIntervalSince(current.0) }
        return total
    }
}
