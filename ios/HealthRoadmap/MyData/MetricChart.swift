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

/// The metric page's chart (US-25 AC17), drawn as Apple Health draws one: a
/// line through the values, and a finger dragged across it picks the nearest
/// day, marked by a rule with a callout of its value and date. No target band:
/// the engine gives the app no range to shade, and Swift invents none.
struct MetricChart: View {
    let history: MetricHistory
    let points: [ChartPoint]
    /// The range's days, first to last; nil fits the values.
    let domain: ClosedRange<Date>?
    /// The scrubbed day, shared so the page can hide its headline under the callout.
    @Binding var selected: Date?
    @State private var finger: Date?
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        Chart {
            ForEach(points) { point in
                LineMark(x: .value("Day", point.date, unit: .day), y: .value(history.unit, point.value))
                    .foregroundStyle(by: .value("Reading", point.series))
                    .interpolationMethod(.linear)
                PointMark(x: .value("Day", point.date, unit: .day), y: .value(history.unit, point.value))
                    .foregroundStyle(by: .value("Reading", point.series))
                    .symbolSize(point.date == selected ? 90 : 30)
            }
            if let selected, let row = row(on: selected) {
                RuleMark(x: .value("Day", selected, unit: .day))
                    .foregroundStyle(Color.secondary.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 1))
                    .annotation(position: .top, spacing: 6, overflowResolution: .init(x: .fit(to: .chart), y: .disabled)) {
                        callout(row)
                    }
            }
        }
        .chartForegroundStyleScale(range: history.metric == MyData.bloodPressure ? [Color.accentColor, Color.teal] : [Color.accentColor])
        .chartLegend(history.metric == MyData.bloodPressure ? .visible : .hidden)
        .chartYScale(domain: .automatic(includesZero: false))
        // Aligned, so the newest month's label stays inside the card.
        .chartXAxis { AxisMarks(preset: .aligned, values: .automatic(desiredCount: textSize.isAccessibilitySize ? 2 : 4)) }
        .modifier(XDomain(domain: domain))
        .chartXSelection(value: $finger)
        .onChange(of: finger) {
            let day = finger.flatMap { ChartRange.nearest(to: $0, in: points.map(\.date)) }
            if day != selected { selected = day }
        }
        .sensoryFeedback(.selection, trigger: selected) { _, new in new != nil }
        // Days are midnight UTC (DayText.date): axis labels read them in UTC so no zone shifts a day.
        .environment(\.timeZone, .gmt)
        .environment(\.calendar, DayText.utc)
        .frame(minHeight: 220)
        .accessibilityChartDescriptor(MetricChartDescriptor(title: history.label, unit: history.unit, points: points))
    }

    /// The history row a day shows: its active value.
    private func row(on day: Date) -> MetricHistory.Row? {
        history.rows.first { $0.isActive && DayText.date($0.day) == day }
    }

    private func callout(_ row: MetricHistory.Row) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(row.value).font(.title2.weight(.semibold)).monospacedDigit()
                Text(history.unit).font(.subheadline).foregroundStyle(.secondary)
            }
            Text(DayText.short(row.day)).font(.subheadline).foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(Color(uiColor: .tertiarySystemFill), in: RoundedRectangle(cornerRadius: 10))
        .accessibilityHidden(true)
    }
}

/// A fixed x domain for a range, or the chart's own fit for All.
private struct XDomain: ViewModifier {
    let domain: ClosedRange<Date>?

    func body(content: Content) -> some View {
        if let domain {
            content.chartXScale(domain: domain)
        } else {
            content
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
