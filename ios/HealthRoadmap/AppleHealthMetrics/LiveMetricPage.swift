import Charts
import SwiftUI

/// A US-56 metric's page, pushed from its card: sleep opens `SleepPage` (AC9), the rest
/// `LiveMetricPage` (AC7). Each is handed its card's reading, which it always shows.
struct LiveHealthPage: View {
    let live: LiveHealth
    let metric: LiveMetric
    /// The person's VO2 max bands, handed only to VO2 max's page (AC8); nil shows none.
    var bands: Vo2MaxBands? = nil
    /// The metric's "About" guide (US-58 AC7), shown at the foot of its page; nil shows none.
    var guide: MetricGuide? = nil

    var body: some View {
        let reading = live.cards[metric]?.date
        Group {
            if metric == .sleep { SleepPage(live: live, reading: reading, guide: guide) } else { LiveMetricPage(live: live, metric: metric, reading: reading, bands: bands, guide: guide) }
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
/// and VO2 max as points. No target band; VO2 max shades its fitness bands behind the chart,
/// with a legend under it (AC8). Read from HealthKit each time it shows, on a return to the
/// app and on unlock (AC2, Codex R1).
struct LiveMetricPage: View {
    let live: LiveHealth
    let metric: LiveMetric
    /// The card's reading: the page reads back to it and opens with it in view (Codex R2).
    let reading: Date?
    /// VO2 max's fitness bands for the person's age and sex (AC8).
    let bands: Vo2MaxBands?
    let guide: MetricGuide?
    @State private var range: LiveRange
    @State private var days: [LivePoint] = []
    @State private var daysRead = false
    /// D's hours, for each day read so far (`hoursRead`), read as the person moves to a day.
    @State private var hours: [LivePoint] = []
    @State private var hoursRead: Set<Date> = []
    /// The wake and appearance the reads above belong to; a newer one reads again.
    @State private var readFor: ReadFor?
    /// The range's bars, rebuilt after a read or a range change, never on a redraw (E2).
    @State private var points: [LivePoint] = []
    @State private var scrolledTo: Date
    @State private var selected: LivePoint?
    /// The day that was today when the page last read, so D follows midnight (N5).
    @State private var today: Date

    init(live: LiveHealth, metric: LiveMetric, reading: Date?, bands: Vo2MaxBands? = nil, guide: MetricGuide? = nil) {
        self.live = live
        self.metric = metric
        self.reading = reading
        self.bands = bands
        self.guide = guide
        _range = State(initialValue: metric.opening)
        let first = metric.opening == .day ? LiveHealth.pageStart(reaching: reading, back: 7, now: live.now(), calendar: live.calendar) : reading
        let geometry = LiveChartGeometry(range: metric.opening, now: live.now(), calendar: live.calendar, first: first)
        _scrolledTo = State(initialValue: geometry.opening(showing: reading))
        _today = State(initialValue: live.calendar.startOfDay(for: live.now()))
    }

    /// What the reads depend on: a wake, the range, and on D the days in view.
    private struct Wanted: Equatable {
        let wakes: Int
        let range: LiveRange
        let days: [Date]
    }

    var body: some View {
        let geometry = geometry
        let inView = geometry.inView(range.isShort ? points : days, by: \.start, from: scrolledTo)
        let wanted = Wanted(wakes: live.wakes, range: range, days: range == .day ? geometry.daysInView(from: scrolledTo) : [])
        LivePageFrame(metric: metric, ranges: LiveRange.allCases, range: $range, empty: isEmpty, key: wanted, guide: guide) { shows in
            await load(wanted, shows: shows)
        } reset: {
            selected = nil
            rebuild()
            scrolledTo = self.geometry.opening(showing: reading)
        } content: {
            PageHeadline(headline: headline(inView: inView, geometry: geometry))
            chart(geometry: geometry)
        } below: {
            // AC8's legend: High first, as the chart reads top down, then the source and the caveat.
            if let bands {
                Section {
                    ForEach(bands.present.reversed(), id: \.self) { Vo2BandRow(band: $0, bands: bands, tint: metric.tint).equatable() }
                } header: {
                    Text("Fitness bands for \(bands.title)")
                } footer: {
                    Text("These bands compare your VO2 max with people of your age and sex in the FRIEND registry, cut at its 20th, 50th and 80th percentiles (Kaminsky 2022). From age 60, Low uses Apple's Low Cardio Fitness alert line (below 18 for men, 15 for women), which Apple ties to the fitness independent living may need. Apple Watch estimates VO2 max; FRIEND's values come from lab treadmill tests.")
                }
            }
        }
    }

    private var geometry: LiveChartGeometry {
        // D scrolls back a week, and to the card's reading's day (a 400-day hourly domain took
        // Swift Charts seconds to lay out); the others across the days read, and to the
        // card's reading before they are read, so the opening position is in the domain.
        let first = range == .day ? LiveHealth.pageStart(reaching: reading, back: 7, now: live.now(), calendar: live.calendar)
            : [days.first?.start, reading].compactMap { $0 }.min()
        return LiveChartGeometry(range: range, now: live.now(), calendar: live.calendar, first: first)
    }

    /// Read and drew nothing. A page opened from a card holds its reading, so it is never empty.
    private var isEmpty: Bool {
        (range == .day ? !hoursRead.isEmpty : daysRead) && points.isEmpty
    }

    /// D reads the hours of each day in view it has not read; the other ranges read the days,
    /// once the page leaves D (E4). A wake reads again; a locked phone keeps what was drawn.
    private func load(_ wanted: Wanted, shows: Int) async {
        let (store, now, calendar) = (live.store, live.now(), live.calendar)
        let fresh = ReadFor(wakes: wanted.wakes, shows: shows)
        if fresh != readFor {
            readFor = fresh
            hoursRead = []
            daysRead = false
            if let moved = geometry.following(scrolledTo, wasToday: today) { scrolledTo = moved }
            today = calendar.startOfDay(for: now)
        }
        // A cancelled read (the page left, or the key moved) marks nothing read (N1).
        if wanted.range == .day {
            for day in wanted.days where !hoursRead.contains(day) {
                guard let read = try? await LiveHealth.readHours(store, metric, day: day, now: now, calendar: calendar), !Task.isCancelled else { return }
                let merged = (hours.filter { calendar.startOfDay(for: $0.start) != day } + read).sorted { $0.start < $1.start }
                if merged != hours { hours = merged }
                hoursRead.insert(day)
            }
        } else if !daysRead {
            guard let read = try? await LiveHealth.readDays(store, metric, reaching: reading, now: now, calendar: calendar), !Task.isCancelled else { return }
            if read != days { days = read }
            daysRead = true
        }
        rebuild()
    }

    private func rebuild() {
        let built = range == .day ? hours : LiveMaths.bucket(days, by: range.bucket, calendar: live.calendar)
        if built != points { points = built }
    }

    // MARK: Headline

    private func headline(inView: [LivePoint], geometry: LiveChartGeometry) -> Headline {
        var head = LiveMaths.headline(metric, range: selected == nil ? range : (range == .day ? .day : .week), points: selected.map { [$0] } ?? inView)
        head.span = selected.map { geometry.label(of: $0.start) } ?? geometry.label(from: scrolledTo)
        return head
    }

    // MARK: Chart

    private func chart(geometry: LiveChartGeometry) -> some View {
        let unit = range.bucket
        let yDomain = bands?.yDomain(values: points.compactMap(\.value))
        return Chart {
            // AC8: the bands behind the values, each from its lower bound to the next one's.
            if let bands, let yDomain {
                ForEach(bands.present, id: \.self) { band in
                    let shade = bands.shade(band, in: yDomain)
                    RectangleMark(xStart: .value("Time", geometry.domain.lowerBound), xEnd: .value("Time", geometry.domain.upperBound),
                                  yStart: .value(metric.unit, shade.lowerBound), yEnd: .value(metric.unit, shade.upperBound))
                        .foregroundStyle(Self.shade(band, tint: metric.tint))
                        .accessibilityHidden(true)
                }
                // A thin rule at each cut-point keeps the bands visible in dark mode (adversary R8).
                ForEach(bands.cuts, id: \.self) { cut in
                    RuleMark(y: .value(metric.unit, cut))
                        .foregroundStyle(metric.tint.opacity(0.4))
                        .lineStyle(StrokeStyle(lineWidth: 0.5))
                        .accessibilityHidden(true)
                }
            }
            ForEach(points) { point in
                let tint = metric.tint.opacity(selected == nil || selected == point ? 1 : 0.4)
                switch metric.aggregation {
                case .sum:
                    BarMark(x: .value("Time", point.start, unit: unit), y: .value(metric.label, point.value ?? 0))
                        .foregroundStyle(tint)
                case .range:
                    let (low, high) = Self.span(point)
                    BarMark(x: .value("Time", point.start, unit: unit), yStart: .value("Low", low), yEnd: .value("High", high), width: .ratio(0.45))
                        .clipShape(Capsule())
                        .foregroundStyle(tint)
                case .mean:
                    // With bands, at the value's shown place, so the dot sits in the band it is placed in (AC8).
                    PointMark(x: .value("Time", point.start, unit: unit), y: .value(metric.unit, bands == nil ? point.value ?? 0 : Vo2MaxBands.shown(point.value ?? 0)))
                        .symbolSize(selected == point ? 90 : 40)
                        .foregroundStyle(metric.tint)
                }
            }
            if let selected { SelectionRule(date: selected.start, unit: unit) }
        }
        .modifier(LiveYScale(metric: metric, points: points, domain: yDomain))
        .modifier(ScrollingChart(geometry: geometry, items: points, date: \.start, scrolledTo: $scrolledTo, selected: $selected))
        .accessibilityChartDescriptor(LiveChartDescriptor(metric: metric, points: points, geometry: geometry, from: scrolledTo, bands: bands))
    }

    /// A band's shading: deeper for fitter, calm in both modes; its name is always in text.
    static func shade(_ band: Vo2MaxBand, tint: Color) -> Color {
        let opacity: Double = switch band {
        case .low: 0.05
        case .belowAverage: 0.11
        case .aboveAverage: 0.18
        case .high: 0.26
        }
        return tint.opacity(opacity)
    }

    /// Heart rate's bar: a single reading still shows as a short capsule, as Apple Health's dot.
    static func span(_ point: LivePoint) -> (Double, Double) {
        let (low, high) = (point.low ?? point.value ?? 0, point.high ?? point.value ?? 0)
        return high - low < 1 ? (low - 0.5, high + 0.5) : (low, high)
    }
}

/// The wake and the appearance a page's reads belong to: a new one of either reads again
/// (AC2: each showing reads; Codex R1). Scrolling within one keeps its per-day reads.
struct ReadFor: Equatable {
    let wakes: Int
    let shows: Int
}

/// What both pages share (AC7, AC9): the range picker, the chart or its empty line, the
/// "From Apple Health" line under it, the read (`key` changes read again), a reset when
/// the range changes, and anything listed below.
struct LivePageFrame<Key: Equatable, Content: View, Below: View>: View {
    let metric: LiveMetric
    let ranges: [LiveRange]
    @Binding var range: LiveRange
    let empty: Bool
    let key: Key
    /// The metric's guide, below everything else, as a record metric's page ends (US-58 AC7).
    let guide: MetricGuide?
    /// Reads for `key`; its argument counts the page's appearances, so a page shown again
    /// (back through the tab bar) reads again, as each showing must (AC2, Codex R1 2026-10-26).
    let load: (Int) async -> Void
    let reset: () -> Void
    @ViewBuilder let content: Content
    @ViewBuilder let below: Below
    @State private var shows = 0

    private struct Read: Equatable {
        let key: Key
        let shows: Int
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Range", selection: $range) {
                        ForEach(ranges) { Text($0.rawValue).tag($0).accessibilityLabel($0.spoken) }
                    }
                    .pickerStyle(.segmented)
                    if empty {
                        Text(metric.empty).font(.subheadline).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 220)
                    } else {
                        content
                    }
                    Text("From Apple Health").font(.footnote).foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }
            below
            if let guide { GuideSections(guide: guide) }
        }
        .metricPageList(title: metric.label)
        .onAppear { shows += 1 }
        .task(id: Read(key: key, shows: shows)) { await load(shows) }
        .onChange(of: range) { reset() }
    }
}

/// The scrolling chart both pages draw (AC7, AC9): axis labels in the page's format (fewer
/// at accessibility sizes, as `MetricChart`), a range's window scrolled across every
/// value, and a finger picking the nearest bar in view with a selection haptic, in the
/// page's calendar.
struct ScrollingChart<Item: Equatable>: ViewModifier {
    let geometry: LiveChartGeometry
    let items: [Item]
    let date: KeyPath<Item, Date>
    @Binding var scrolledTo: Date
    @Binding var selected: Item?
    @State private var finger: Date?
    @Environment(\.dynamicTypeSize) private var textSize

    func body(content: Content) -> some View {
        content
            .chartXAxis {
                let start = max(scrolledTo, geometry.domain.lowerBound)
                // Three at accessibility sizes: with two, both can land on the edges and go unlabelled.
                AxisMarks(preset: .aligned, values: .automatic(desiredCount: textSize.isAccessibilitySize ? 3 : 4)) { value in
                    AxisGridLine()
                    if let date = value.as(Date.self), ChartRange.labels(date, from: start, length: geometry.window) {
                        AxisValueLabel(format: geometry.axisFormat)
                    }
                }
            }
            .chartXScale(domain: geometry.domain)
            .chartScrollableAxes(.horizontal)
            .chartXVisibleDomain(length: geometry.window)
            .chartScrollPosition(x: $scrolledTo)
            .chartXSelection(value: $finger)
            .onChange(of: finger) {
                let near = finger.flatMap { ChartRange.nearest(to: $0, in: geometry.inView(items, by: date, from: scrolledTo), by: date) }
                if near != selected { selected = near }
            }
            .sensoryFeedback(.selection, trigger: selected) { _, new in new != nil }
            .environment(\.calendar, geometry.calendar)
            .environment(\.timeZone, geometry.calendar.timeZone)
            .frame(minHeight: 220)
    }
}

/// The scrubbed bar's rule.
struct SelectionRule: ChartContent {
    let date: Date
    let unit: Calendar.Component

    var body: some ChartContent {
        RuleMark(x: .value("Time", date, unit: unit))
            .foregroundStyle(Color.secondary.opacity(0.5))
            .lineStyle(StrokeStyle(lineWidth: 1))
    }
}

/// Heart rate's axis spans its readings, as Apple Health's does, not from zero; sums start at zero.
private struct LiveYScale: ViewModifier {
    let metric: LiveMetric
    let points: [LivePoint]
    /// VO2 max's axis with its bands (AC8): every band and every value.
    let domain: ClosedRange<Double>?

    func body(content: Content) -> some View {
        if let domain {
            content.chartYScale(domain: domain)
        } else if metric.aggregation == .range, let low = points.compactMap(\.low).min(), let high = points.compactMap(\.high).max() {
            content.chartYScale(domain: (low - 10).rounded(.down)...(high + 10).rounded(.up))
        } else {
            content.chartYScale(domain: .automatic(includesZero: metric.aggregation == .sum))
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
        end = range.isShort ? today : calendar.dateInterval(of: range.bucket, for: now)?.end ?? today
        let start = range.start(ending: end, calendar: calendar)
        window = end.timeIntervalSince(start)
        // From the start of the oldest value's bar: a week or month begins before its first day.
        let oldest = first.map { calendar.dateInterval(of: range.bucket, for: $0)?.start ?? $0 } ?? start
        domain = min(oldest, start)...end
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

    /// Where the chart opens: a range back from the end, or, when the card's reading is
    /// older, the range ending with the reading's day (on D), week or month, so a page never
    /// opens empty after a card with a value (Codex R2).
    func opening(showing reading: Date?) -> Date {
        guard let reading, reading < windowStart else { return windowStart }
        let close = calendar.dateInterval(of: range == .day ? .day : range.bucket, for: reading)?.end ?? reading
        // The window's own length, so the reading's bar is always inside it (months differ).
        return max(domain.lowerBound, close.addingTimeInterval(-window))
    }

    /// D after a wake (N5): a window on the day that was today moves to the new today; one the
    /// person scrolled back stays. Nil when nothing moves.
    func following(_ scrolledTo: Date, wasToday: Date) -> Date? {
        let shown = calendar.startOfDay(for: max(scrolledTo, domain.lowerBound))
        guard range == .day, shown == wasToday, wasToday != calendar.startOfDay(for: windowStart) else { return nil }
        return windowStart
    }

    /// The items whose date falls in view: bars by their start, nights by their day.
    func inView<Item>(_ items: [Item], by date: KeyPath<Item, Date>, from start: Date) -> [Item] {
        let start = max(start, domain.lowerBound)
        let stop = start.addingTimeInterval(window)
        return items.filter { $0[keyPath: date] >= start && $0[keyPath: date] < stop }
    }

    /// The days a D window starting at `start` overlaps: one, or two when it straddles midnight.
    func daysInView(from start: Date) -> [Date] {
        let start = max(start, domain.lowerBound)
        let (first, last) = (calendar.startOfDay(for: start), calendar.startOfDay(for: start.addingTimeInterval(window - 1)))
        return first == last ? [first] : [first, last]
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

/// What VoiceOver's audio graph reads (AC12), as `MetricChart` does: the bars in view only,
/// not everything read (adversary R8).
struct LiveChartDescriptor: AXChartDescriptorRepresentable {
    let metric: LiveMetric
    let points: [LivePoint]
    let calendar: Calendar
    let bands: Vo2MaxBands?

    init(metric: LiveMetric, points: [LivePoint], geometry: LiveChartGeometry, from start: Date, bands: Vo2MaxBands? = nil) {
        self.metric = metric
        self.points = geometry.inView(points, by: \.start, from: start)
        calendar = geometry.calendar
        self.bands = bands
    }

    /// AC8: "Fitness bands for women aged 40 to 49: High, 33.0 and above …; Low, below 19.7 …."
    var summary: String? {
        bands.map { bands in "Fitness bands for \(bands.title): " + bands.present.reversed().map(bands.spoken).joined(separator: "; ") + "." }
    }

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
        let series: [AXDataSeriesDescriptor] = metric.aggregation == .range
            ? [AXDataSeriesDescriptor(name: "Lowest", isContinuous: false, dataPoints: points.compactMap { p in p.low.map { AXDataPoint(x: p.start.timeIntervalSince1970, y: $0) } }),
               AXDataSeriesDescriptor(name: "Highest", isContinuous: false, dataPoints: points.compactMap { p in p.high.map { AXDataPoint(x: p.start.timeIntervalSince1970, y: $0) } })]
            : [AXDataSeriesDescriptor(name: metric.label, isContinuous: false, dataPoints: points.compactMap { p in p.value.map { AXDataPoint(x: p.start.timeIntervalSince1970, y: $0) } })]
        return AXChartDescriptor(title: metric.label, summary: summary, xAxis: xAxis, yAxis: yAxis, additionalAxes: [], series: series)
    }
}

/// One row of AC8's legend: the band's swatch, name and range, one VoiceOver element.
/// Equatable, so scrubbing the chart does not rebuild it.
struct Vo2BandRow: View, Equatable {
    let band: Vo2MaxBand
    let bands: Vo2MaxBands
    let tint: Color
    @Environment(\.dynamicTypeSize) private var textSize

    nonisolated static func == (a: Self, b: Self) -> Bool { a.band == b.band && a.bands == b.bands && a.tint == b.tint }

    var body: some View {
        HStack(spacing: 10) {
            RoundedRectangle(cornerRadius: 4)
                .fill(LiveMetricPage.shade(band, tint: tint))
                .strokeBorder(tint.opacity(0.45))
                .frame(width: 16, height: 16)
            let layout = LabelValue.layout(textSize)
            layout {
                Text(band.label)
                if !textSize.isAccessibilitySize { Spacer(minLength: 8) }
                Text(bands.range(band)).monospacedDigit().foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(bands.spoken(band))
    }
}
