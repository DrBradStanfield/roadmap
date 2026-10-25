import Charts
import SwiftUI

/// One plotted value: a day and a number in a series. Most metrics have one
/// series; blood pressure has systolic and diastolic.
struct ChartPoint: Identifiable {
    let id: String
    let date: Date
    let value: Double
    let series: String

    /// A history's active values, ready to plot. Numbers are the engine's own text, in the user's units.
    static func points(_ history: MetricHistory) -> [ChartPoint] {
        history.rows.filter(\.isActive).flatMap { row -> [ChartPoint] in
            guard let date = DayText.date(row.day) else { return [] }
            if history.metric == MyData.bloodPressure {
                return [("Systolic", row.systolic), ("Diastolic", row.diastolic)].compactMap { series, text in
                    text.flatMap(Double.init).map { ChartPoint(id: row.id + series, date: date, value: $0, series: series) }
                }
            }
            return Double(row.value).map { [ChartPoint(id: row.id, date: date, value: $0, series: history.label)] } ?? []
        }
    }
}

/// A history's chart inputs, built once per history the engine answers, never on a redraw:
/// a scrub redraws the page many times a second.
struct ChartData {
    let history: MetricHistory
    let points: [ChartPoint]
    /// Each point's day, in the points' order.
    let days: [Date]
    /// The oldest and newest of those days; nil with no values.
    let first: Date?, last: Date?
    /// The range the page opens on for those days.
    let opening: ChartRange
    /// Each day's active value, for the scrub's callout: looked up, never found by parsing
    /// every row's day on each frame of a scrub.
    let activeRows: [Date: MetricHistory.Row]

    init(_ history: MetricHistory) {
        self.history = history
        points = ChartPoint.points(history)
        days = points.map(\.date)
        (first, last) = (days.min(), days.max())
        opening = ChartRange.opening(for: days)
        // The first active row for a day wins, as `rows.first` would pick it.
        activeRows = Dictionary(history.rows.filter(\.isActive).compactMap { row in DayText.date(row.day).map { ($0, row) } },
                                uniquingKeysWith: { first, _ in first })
    }
}

/// The metric page's chart (US-25 AC17), drawn as Apple Health draws one: a
/// line through the values, and a finger dragged across it picks the nearest
/// day, marked by a rule with a callout of its value and date. No target band:
/// the engine gives the app no range to shade, and Swift invents none. The web
/// twin is the chart in widget-src/src/components/HistoryPanel.tsx. Drawn only for a
/// chart with values.
struct MetricChart: View {
    let chart: ChartData
    /// A range's length: the chart shows that much and scrolls across the rest, as
    /// Apple Health's does.
    let window: TimeInterval
    /// The first day a scrolling chart shows.
    @Binding var scrolledTo: Date
    /// The scrubbed day, shared so the page can hide its headline under the callout.
    @Binding var selected: Date?
    @State private var finger: Date?
    @Environment(\.dynamicTypeSize) private var textSize

    /// A little past the newest value, so its point is drawn whole at the right edge.
    nonisolated static func margin(window: TimeInterval) -> TimeInterval { max(86_400, window / 30) }

    /// What the chart shows at once; the scrub filter must use the same length.
    nonisolated static func visibleLength(window: TimeInterval) -> TimeInterval { window + margin(window: window) }

    /// The days a scrubbing finger may pick: those in view.
    nonisolated static func inView(_ days: [Date], scrolledTo: Date, window: TimeInterval) -> [Date] {
        let end = scrolledTo.addingTimeInterval(visibleLength(window: window))
        return days.filter { $0 >= scrolledTo && $0 <= end }
    }

    /// Each metric's own graph colour (Brad 2026-10-23): colour lives only in the chart,
    /// on the metric page and its card's trend line; a card's name stays plain. No two
    /// metrics share a hue; blood pressure's two lines are related reds. A metric with
    /// none falls back to the accent colour. Every caller reads it here (US-25 AC17).
    nonisolated static func colors(for metric: String) -> [Color] {
        palette[metric] ?? [.accentColor]
    }

    /// Hand-chosen pairs, light then dark, 0xRRGGBB: each reads as a line on its card (3:1,
    /// MyDataLayoutTests) and is calmer in dark mode (Brad 2026-10-23). Built once.
    nonisolated static let palette: [String: [Color]] = [
        "weight": [Color(light: 0xAF52DE, dark: 0xBE88DA)],
        "waist": [Color(light: 0x5856D6, dark: 0x8684CF)],
        MyData.bloodPressure: [Color(light: 0xFF3B30, dark: 0xE6817B), Color(light: 0xD37A70, dark: 0xDAA39C)],
        "hba1c": [Color(light: 0xD07A00, dark: 0xE6B261)],
        "ldl": [Color(light: 0x007AFF, dark: 0x61A3E6)],
        "apob": [Color(light: 0x2E9ED2, dark: 0x92CDE6)],
        "total_cholesterol": [Color(light: 0x2A9BB0, dark: 0x73BDCA)],
        "hdl": [Color(light: 0x2CA84B, dark: 0x65BC7B)],
        "triglycerides": [Color(light: 0xB28F00, dark: 0xE6CF61)],
        "creatinine": [Color(light: 0xA2845E, dark: 0x9B8B76)],
        "lpa": [Color(light: 0xB2598C, dark: 0xA0708C)],
        "psa": [Color(light: 0x6680A6, dark: 0x738195)],
        "height": [Color(light: 0x8E8E93, dark: 0x828284)],
    ]

    var body: some View {
        Chart {
            ForEach(chart.points) { point in
                LineMark(x: .value("Day", point.date, unit: .day), y: .value(chart.history.unit, point.value))
                    .foregroundStyle(by: .value("Reading", point.series))
                    .interpolationMethod(.linear)
                PointMark(x: .value("Day", point.date, unit: .day), y: .value(chart.history.unit, point.value))
                    .foregroundStyle(by: .value("Reading", point.series))
                    .symbolSize(point.date == selected ? 90 : 30)
            }
            if let selected, let row = chart.activeRows[selected] {
                RuleMark(x: .value("Day", selected, unit: .day))
                    .foregroundStyle(Color.secondary.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .top, spacing: 6, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        callout(row)
                    }
            }
        }
        .chartForegroundStyleScale(range: Self.colors(for: chart.history.metric))
        .chartLegend(chart.history.metric == MyData.bloodPressure ? .visible : .hidden)
        .chartYScale(domain: .automatic(includesZero: false))
        // Aligned, so the newest month's label stays inside the card.
        .chartXAxis { AxisMarks(preset: .aligned, values: .automatic(desiredCount: textSize.isAccessibilitySize ? 2 : 4)) }
        .modifier(XDomain(window: window, scrolledTo: $scrolledTo, first: chart.first, last: chart.last))
        .chartXSelection(value: $finger)
        .onChange(of: finger) {
            // Only the days in view: a finger in a gap never picks one off screen.
            let inView = MetricChart.inView(chart.days, scrolledTo: scrolledTo, window: window)
            let day = finger.flatMap { ChartRange.nearest(to: $0, in: inView) }
            if day != selected { selected = day }
        }
        .sensoryFeedback(.selection, trigger: selected) { _, new in new != nil }
        // Days are midnight UTC (DayText.date): axis labels read them in UTC so no zone shifts a day.
        .environment(\.timeZone, .gmt)
        .environment(\.calendar, DayText.utc)
        .frame(minHeight: 220)
        .accessibilityChartDescriptor(MetricChartDescriptor(title: chart.history.label, unit: chart.history.unit, points: chart.points))
    }

    private func callout(_ row: MetricHistory.Row) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(row.value).font(.title2.weight(.semibold)).monospacedDigit()
                Text(chart.history.unit).font(.subheadline).foregroundStyle(.secondary)
            }
            Text(DayText.short(row.day)).font(.subheadline).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityHidden(true)
    }
}

/// A range scrolls across every value, a window at a time.
private struct XDomain: ViewModifier {
    let window: TimeInterval
    @Binding var scrolledTo: Date
    let first: Date?, last: Date?

    func body(content: Content) -> some View {
        if let first, let last {
            let margin = MetricChart.margin(window: window)
            content
                .chartXScale(domain: min(first, last.addingTimeInterval(-window))...last.addingTimeInterval(margin))
                .chartScrollableAxes(.horizontal)
                .chartXVisibleDomain(length: MetricChart.visibleLength(window: window))
                .chartScrollPosition(x: $scrolledTo)
        }
    }
}

/// What VoiceOver's audio graph and chart summary read (`accessibilityChartDescriptor`).
private struct MetricChartDescriptor: AXChartDescriptorRepresentable {
    let title: String
    let unit: String
    let points: [ChartPoint]

    func makeChartDescriptor() -> AXChartDescriptor {
        let times = points.map { $0.date.timeIntervalSince1970 }
        let values = points.map(\.value)
        let xAxis = AXNumericDataAxisDescriptor(title: "Day", range: (times.min() ?? 0)...(times.max() ?? 0), gridlinePositions: []) {
            Date(timeIntervalSince1970: $0).formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, timeZone: .gmt))
        }
        let yAxis = AXNumericDataAxisDescriptor(title: unit, range: (values.min() ?? 0)...(values.max() ?? 0), gridlinePositions: []) {
            "\($0.formatted()) \(unit)"
        }
        let names = points.reduce(into: [String]()) { names, point in
            if !names.contains(point.series) { names.append(point.series) }
        }
        let series = names.map { name in
            AXDataSeriesDescriptor(name: name, isContinuous: true, dataPoints: points.filter { $0.series == name }.map {
                AXDataPoint(x: $0.date.timeIntervalSince1970, y: $0.value)
            })
        }
        return AXChartDescriptor(title: title, summary: nil, xAxis: xAxis, yAxis: yAxis, additionalAxes: [], series: series)
    }
}
