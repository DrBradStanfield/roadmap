import Charts
import SwiftUI

/// A US-56 metric's page, pushed from its card: sleep opens `SleepPage` (AC9), the rest
/// `LiveMetricPage` (AC7).
struct LiveHealthPage: View {
    let live: LiveHealth
    let metric: LiveMetric

    var body: some View {
        Group {
            if metric == .sleep { SleepPage(live: live) } else { LiveMetricPage(live: live, metric: metric) }
        }
        // Clarity's fixed screen name "Apple Health metric" while a page shows (usage signal).
        .onAppear { live.pagesOpen += 1 }
        .onDisappear { live.pagesOpen -= 1 }
    }
}

/// Heart rate, resting heart rate, VO2 max or steps, as Apple Health's page draws them
/// (AC7): the range picker (D, W, M, 6M, Y), the headline for what is in view, the chart,
/// a scrub that shows the touched bar's value. Read-only: no "+", no list, no correction,
/// no Unit menu. Heart rate draws each bar low to high; steps as bars; resting heart rate
/// and VO2 max as points. No target band. Read from HealthKit each time it shows (AC2).
struct LiveMetricPage: View {
    let live: LiveHealth
    let metric: LiveMetric
    @State private var range: LiveRange
    @State private var days: [LivePoint] = []
    @State private var hours: [LivePoint] = []
    @State private var read = false
    @State private var scrolledTo = Date.distantPast
    @State private var finger: Date?
    @State private var selected: LivePoint?
    @Environment(\.dynamicTypeSize) private var textSize

    init(live: LiveHealth, metric: LiveMetric) {
        self.live = live
        self.metric = metric
        _range = State(initialValue: Self.opening(metric))
    }

    /// Apple Health opens heart rate and steps on the day; resting heart rate, one value a
    /// day, on the week; VO2 max, a few a month, on six months.
    static func opening(_ metric: LiveMetric) -> LiveRange {
        switch metric {
        case .heartRate, .steps: .day
        case .restingHeartRate: .week
        case .vo2Max, .sleep: .sixMonths
        }
    }

    var body: some View {
        let geometry = LiveChartGeometry(range: range, now: live.now(), calendar: live.calendar, first: (range == .day ? hours : days).first?.start)
        let points = range == .day ? hours : LiveMaths.bucket(days, by: range.bucket, metric: metric, calendar: live.calendar)
        let inView = geometry.inView(range == .day ? hours : range == .week || range == .month ? points : days, from: scrolledTo)
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Range", selection: $range) {
                        ForEach(LiveRange.allCases) { Text($0.rawValue).tag($0).accessibilityLabel($0.spoken) }
                    }
                    .pickerStyle(.segmented)
                    headline(inView: inView, geometry: geometry)
                    if read && points.isEmpty {
                        Text("No \(metric.label.lowercased()) in Apple Health for this time.").font(.subheadline).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 220)
                    } else {
                        chart(points, geometry: geometry)
                    }
                    Text("From Apple Health").font(.footnote).foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(metric.label)
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: range, initial: true) {
            selected = nil
            scrolledTo = LiveChartGeometry(range: range, now: live.now(), calendar: live.calendar, first: nil).windowStart
        }
    }

    /// Reads HealthKit again each time the page shows; a locked phone keeps what was drawn.
    private func load() async {
        guard let page = try? await LiveHealth.readPage(live.store, metric, now: live.now(), calendar: live.calendar) else { return }
        (days, hours, read) = (page.days, page.hours, true)
    }

    // MARK: Headline

    private func headline(inView: [LivePoint], geometry: LiveChartGeometry) -> some View {
        let shown = selected.map { [$0] } ?? inView
        let head = LiveMaths.headline(metric, range: selected == nil ? range : (range == .day ? .day : .week), points: shown)
        let span = selected.map { geometry.label(of: $0.start) } ?? geometry.label(from: scrolledTo)
        return VStack(alignment: .leading, spacing: 2) {
            Text(head.title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(head.value ?? "None")
                    .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                if head.value != nil { Text(metric.unit).font(.title3).foregroundStyle(.secondary) }
            }
            Text(span).font(.subheadline).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: Chart

    private func chart(_ points: [LivePoint], geometry: LiveChartGeometry) -> some View {
        let unit = range.bucket
        return Chart {
            ForEach(points) { point in
                switch metric {
                case .steps:
                    BarMark(x: .value("Time", point.start, unit: unit), y: .value("Steps", point.value ?? 0))
                        .foregroundStyle(metric.tint.opacity(selected == nil || selected == point ? 1 : 0.4))
                case .heartRate:
                    let (low, high) = Self.span(point)
                    BarMark(x: .value("Time", point.start, unit: unit), yStart: .value("Low", low), yEnd: .value("High", high), width: .ratio(0.45))
                        .clipShape(Capsule())
                        .foregroundStyle(metric.tint.opacity(selected == nil || selected == point ? 1 : 0.4))
                default:
                    PointMark(x: .value("Time", point.start, unit: unit), y: .value(metric.unit, point.value ?? 0))
                        .symbolSize(selected == point ? 90 : 40)
                        .foregroundStyle(metric.tint)
                }
            }
            if let selected {
                RuleMark(x: .value("Time", selected.start, unit: unit))
                    .foregroundStyle(Color.secondary.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 1))
            }
        }
        .modifier(HeartScale(metric: metric, points: points))
        .chartXAxis { AxisMarks(preset: .aligned, values: .automatic(desiredCount: textSize.isAccessibilitySize ? 2 : 4)) { _ in
            AxisGridLine()
            AxisValueLabel(format: geometry.axisFormat)
        } }
        .chartXScale(domain: geometry.domain)
        .chartScrollableAxes(.horizontal)
        .chartXVisibleDomain(length: geometry.window)
        .chartScrollPosition(x: $scrolledTo)
        .chartXSelection(value: $finger)
        .onChange(of: finger) {
            let visible = geometry.inView(points, from: scrolledTo)
            let near = finger.flatMap { finger in visible.min { abs($0.start.timeIntervalSince(finger)) < abs($1.start.timeIntervalSince(finger)) } }
            if near != selected { selected = near }
        }
        .sensoryFeedback(.selection, trigger: selected) { _, new in new != nil }
        .environment(\.calendar, live.calendar)
        .environment(\.timeZone, live.calendar.timeZone)
        .frame(minHeight: 220)
        .accessibilityChartDescriptor(LiveChartDescriptor(metric: metric, points: points, calendar: live.calendar))
    }

    /// Heart rate's bar: a single reading still shows as a short capsule, as Apple Health's dot.
    static func span(_ point: LivePoint) -> (Double, Double) {
        let (low, high) = (point.low ?? point.value ?? 0, point.high ?? point.value ?? 0)
        return high - low < 1 ? (low - 0.5, high + 0.5) : (low, high)
    }
}

/// Heart rate's axis spans its readings, as Apple Health's does, not from zero; steps start at zero.
private struct HeartScale: ViewModifier {
    let metric: LiveMetric
    let points: [LivePoint]

    func body(content: Content) -> some View {
        if metric == .heartRate, let low = points.compactMap(\.low).min(), let high = points.compactMap(\.high).max() {
            content.chartYScale(domain: (low - 10).rounded(.down)...(high + 10).rounded(.up))
        } else {
            content.chartYScale(domain: .automatic(includesZero: metric == .steps))
        }
    }
}

/// Where a range's chart starts and ends: it ends with the current hour's day, week or
/// month (today shows as it stands, AC2) and scrolls back across every value, a range at
/// a time, as Apple Health's does. Real instants in the phone's zone.
struct LiveChartGeometry {
    let range: LiveRange
    let calendar: Calendar
    /// The end of the bucket holding now.
    let end: Date
    /// A range's length.
    let window: TimeInterval
    let domain: ClosedRange<Date>

    init(range: LiveRange, now: Date, calendar: Calendar, first: Date?) {
        self.range = range
        self.calendar = calendar
        let today = calendar.dateInterval(of: .day, for: now)?.end ?? now
        end = range == .day || range == .week || range == .month ? today : calendar.dateInterval(of: range.bucket, for: now)?.end ?? today
        let start = range.start(ending: end, calendar: calendar)
        window = end.timeIntervalSince(start)
        domain = min(first ?? start, start)...end
    }

    /// The axis labels, as Apple Health's: hours, weekdays, days of the month, or months.
    var axisFormat: Date.FormatStyle {
        let format = Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone)
        return switch range {
        case .day: format.hour()
        case .week: format.weekday(.abbreviated)
        case .month: format.day()
        case .sixMonths, .year: format.month(.abbreviated)
        }
    }

    /// The first instant shown when the chart opens: a range back from the end.
    var windowStart: Date { end.addingTimeInterval(-window) }

    /// The points whose bucket starts in view.
    func inView(_ points: [LivePoint], from start: Date) -> [LivePoint] {
        let start = max(start, domain.lowerBound)
        let stop = start.addingTimeInterval(window)
        return points.filter { $0.start >= start && $0.start < stop }
    }

    /// The span in view, as Apple Health writes it under the headline.
    func label(from start: Date) -> String {
        let start = max(start, domain.lowerBound)
        let stop = start.addingTimeInterval(window - 1)
        let style = Date.IntervalFormatStyle(date: .abbreviated, time: .omitted, locale: .current, calendar: calendar, timeZone: calendar.timeZone)
        return range == .day ? start.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, calendar: calendar, timeZone: calendar.timeZone)) : (start..<stop).formatted(style)
    }

    /// A touched bucket's span: its hour, day, week or month.
    func label(of start: Date) -> String {
        let format = Date.FormatStyle(calendar: calendar, timeZone: calendar.timeZone)
        switch range {
        case .day:
            let stop = calendar.date(byAdding: .hour, value: 1, to: start) ?? start
            return (start..<stop).formatted(Date.IntervalFormatStyle(date: .omitted, time: .shortened, locale: .current, calendar: calendar, timeZone: calendar.timeZone))
        case .week, .month: return start.formatted(format.weekday(.abbreviated).day().month(.abbreviated).year())
        case .sixMonths:
            let stop = calendar.date(byAdding: .day, value: 6, to: start) ?? start
            return (start..<stop).formatted(Date.IntervalFormatStyle(date: .abbreviated, time: .omitted, locale: .current, calendar: calendar, timeZone: calendar.timeZone))
        case .year: return start.formatted(format.month(.wide).year())
        }
    }
}

/// What VoiceOver's audio graph reads (AC12), as `MetricChart` does.
struct LiveChartDescriptor: AXChartDescriptorRepresentable {
    let metric: LiveMetric
    let points: [LivePoint]
    let calendar: Calendar

    func makeChartDescriptor() -> AXChartDescriptor {
        let times = points.map { $0.start.timeIntervalSince1970 }
        let values = points.compactMap { $0.high ?? $0.value }
        let lows = points.compactMap { $0.low ?? $0.value }
        let (calendar, metric) = (calendar, metric)
        let xAxis = AXNumericDataAxisDescriptor(title: "Time", range: (times.min() ?? 0)...(times.max() ?? 0), gridlinePositions: []) {
            Date(timeIntervalSince1970: $0).formatted(Date.FormatStyle(date: .abbreviated, time: .shortened, calendar: calendar, timeZone: calendar.timeZone))
        }
        let yAxis = AXNumericDataAxisDescriptor(title: metric.spokenUnit, range: (lows.min() ?? 0)...(values.max() ?? 0), gridlinePositions: []) {
            "\(metric.text($0)) \(metric.spokenUnit)"
        }
        let series: [AXDataSeriesDescriptor] = metric == .heartRate
            ? [AXDataSeriesDescriptor(name: "Lowest", isContinuous: false, dataPoints: points.compactMap { p in p.low.map { AXDataPoint(x: p.start.timeIntervalSince1970, y: $0) } }),
               AXDataSeriesDescriptor(name: "Highest", isContinuous: false, dataPoints: points.compactMap { p in p.high.map { AXDataPoint(x: p.start.timeIntervalSince1970, y: $0) } })]
            : [AXDataSeriesDescriptor(name: metric.label, isContinuous: false, dataPoints: points.compactMap { p in p.value.map { AXDataPoint(x: p.start.timeIntervalSince1970, y: $0) } })]
        return AXChartDescriptor(title: metric.label, summary: nil, xAxis: xAxis, yAxis: yAxis, additionalAxes: [], series: series)
    }
}
