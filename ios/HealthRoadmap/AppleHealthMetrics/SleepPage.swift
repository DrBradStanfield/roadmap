import Charts
import SwiftUI

/// Sleep's page, built as Apple Health's Sleep page displays it (AC9): on D, one night's
/// stages (Awake, REM, Core, Deep) over its clock times in Apple's stage colours, each
/// stage's time beside it; on W, M and 6M, each night's time asleep with the stages'
/// averages. A source with only "Asleep" or "In Bed" shows those, without stages.
/// Read-only, read from HealthKit each time it shows, on a return to the app and on
/// unlock (AC2, Codex R1).
struct SleepPage: View {
    let live: LiveHealth
    /// The card's night: the page reads back to it and opens on it (Codex R2).
    let reading: Date?
    /// Sleep's "About" guide (US-58 AC7); nil shows none.
    var guide: MetricGuide? = nil
    @State private var range = LiveMetric.sleep.opening
    @State private var nights: [SleepNight] = []
    @State private var read = false
    /// D's night, by its day; nil for the newest up to today (`LiveMaths.newestNight`).
    @State private var picked: Date?
    @State private var scrolledTo = Date.distantPast
    @State private var selected: SleepNight?
    /// The card's night is not yet in view: until the first read lands the chart has no
    /// nights to reach it, whatever range is picked (N7).
    @State private var opening = true
    /// The wake and appearance the nights belong to (AC2, Codex R1).
    @State private var readFor: ReadFor?

    var body: some View {
        LivePageFrame(metric: .sleep, ranges: LiveRange.sleep, range: $range, empty: read && !nights.contains(where: \.hasSleep), key: live.wakes, guide: guide) { shows in
            await load(ReadFor(wakes: live.wakes, shows: shows))
        } reset: {
            selected = nil
            scrolledTo = geometry.opening(showing: reading)
        } content: {
            if range == .day { dayView } else { rangeView }
        } below: {
            if range == .day, let night {
                stagesList(night.hasStages ? night.stages : [.asleep: night.asleep, .inBed: night.inBed], title: nil)
            } else if range != .day {
                let averages = LiveMaths.stageAverages(selected.map { [$0] } ?? geometry.inView(nights, by: \.day, from: scrolledTo))
                if !averages.isEmpty { stagesList(averages, title: selected == nil ? "Average" : nil) }
            }
        }
    }

    private var geometry: LiveChartGeometry {
        LiveChartGeometry(range: range, now: live.now(), calendar: live.calendar, first: nights.first?.day)
    }

    /// The nights with sleep or time in bed, oldest first: D steps through them.
    private var held: [SleepNight] { nights.filter(\.hasSleep) }

    /// D's night: the one picked, else the newest dated today or earlier (adversary R3).
    private var night: SleepNight? {
        picked.flatMap { day in nights.first { $0.day == day } } ?? LiveMaths.newestNight(nights, today: live.calendar.startOfDay(for: live.now()))
    }

    private func load(_ fresh: ReadFor) async {
        guard fresh != readFor else { return }
        // A cancelled read marks nothing read (N1).
        guard let read = try? await LiveHealth.readNights(live.store, reaching: reading, now: live.now(), calendar: live.calendar), !Task.isCancelled else { return }
        if read != nights { nights = read }
        self.read = true
        readFor = fresh
        scrolledTo = Self.landed(opening: opening, scrolledTo: scrolledTo, geometry: geometry, reading: reading)
        opening = false
    }

    /// Where the chart sits once the nights land: on the card's night while it is still to be
    /// brought into view (N7), else where the person left it.
    static func landed(opening: Bool, scrolledTo: Date, geometry: LiveChartGeometry, reading: Date?) -> Date {
        opening ? geometry.opening(showing: reading) : scrolledTo
    }

    /// A night's headline: its time asleep, or time in bed for a night with no sleep (Codex R3).
    static func headline(night: SleepNight) -> Headline {
        Headline(title: night.isInBedOnly ? "Time in Bed" : "Time Asleep", parts: LiveMaths.duration(night.shown))
    }

    // MARK: D

    @ViewBuilder
    private var dayView: some View {
        if let night, let index = held.firstIndex(of: night) {
            HStack(alignment: .bottom) {
                PageHeadline(headline: dayHeadline(night))
                Spacer()
                Button { picked = held[index - 1].day } label: { Image(systemName: "chevron.left") }
                    .disabled(index == 0)
                    .accessibilityLabel("Night before")
                Button { picked = held[index + 1].day } label: { Image(systemName: "chevron.right") }
                    .disabled(index + 1 >= held.count)
                    .accessibilityLabel("Night after")
            }
            .buttonStyle(.borderless)
            hypnogram(night)
        }
    }

    private func dayHeadline(_ night: SleepNight) -> Headline {
        var head = Self.headline(night: night)
        head.span = night.day.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, calendar: live.calendar, timeZone: live.calendar.timeZone))
        return head
    }

    /// The night's stages over its clock times, a row per stage, as Apple Health draws them.
    private func hypnogram(_ night: SleepNight) -> some View {
        let rows: [SleepStage] = night.hasStages ? SleepStage.drawn : [.awake, .asleep, .inBed].filter { stage in night.segments.contains { $0.stage == stage } }
        let segments = night.segments.filter { rows.contains($0.stage) }
        return Chart(Array(segments.enumerated()), id: \.offset) { _, segment in
            BarMark(xStart: .value("Start", segment.start), xEnd: .value("End", segment.end), y: .value("Stage", segment.stage.label))
                .foregroundStyle(segment.stage.tint)
                .clipShape(RoundedRectangle(cornerRadius: 3))
        }
        .chartYScale(domain: rows.map(\.label))
        .chartXAxis { AxisMarks(values: .automatic(desiredCount: 4)) { _ in
            AxisGridLine()
            AxisValueLabel(format: .dateTime.hour())
        } }
        .environment(\.calendar, live.calendar)
        .environment(\.timeZone, live.calendar.timeZone)
        .frame(minHeight: 200)
        .accessibilityChartDescriptor(SleepNightDescriptor(night: night, rows: rows, calendar: live.calendar))
    }

    // MARK: W, M, 6M

    @ViewBuilder
    private var rangeView: some View {
        let geometry = geometry
        PageHeadline(headline: rangeHeadline(geometry))
        SleepRangeChart(nights: nights, geometry: geometry, scrolledTo: $scrolledTo, selected: $selected)
    }

    private func rangeHeadline(_ geometry: LiveChartGeometry) -> Headline {
        var head = selected.map(Self.headline(night:)) ?? Self.headline(geometry.inView(nights, by: \.day, from: scrolledTo))
        head.span = selected.map { geometry.label(of: $0.day) } ?? geometry.label(from: scrolledTo)
        return head
    }

    /// W, M and 6M's headline for the nights in view: the average time asleep; nights
    /// recorded only as In Bed say time in bed (AC9, Codex R3).
    static func headline(_ nights: [SleepNight]) -> Headline {
        if let asleep = LiveMaths.average(nights, \.asleep) { return Headline(title: "Avg. Time Asleep", parts: LiveMaths.duration(asleep)) }
        if let inBed = LiveMaths.average(nights, \.inBed) { return Headline(title: "Avg. Time in Bed", parts: LiveMaths.duration(inBed)) }
        return Headline(title: "Avg. Time Asleep")
    }

    /// A night's bar: its asleep stages stacked, deep at the bottom; or one "Asleep" bar.
    static func bars(_ night: SleepNight) -> [(SleepStage, TimeInterval)] {
        if night.hasStages { return [SleepStage.deep, .core, .rem].map { ($0, night.stages[$0] ?? 0) } }
        return night.asleep > 0 ? [(.asleep, night.asleep)] : [(.inBed, night.inBed)]
    }

    // MARK: Parts

    /// Each stage's time with its colour, as Apple Health lists them under the chart.
    private func stagesList(_ stages: [SleepStage: TimeInterval], title: String?) -> some View {
        Section {
            ForEach(stages.keys.sorted().filter { stages[$0, default: 0] > 0 || stages.keys.contains(where: \.isStage) }, id: \.self) { stage in
                LabeledContent {
                    Text(LiveMetric.sleep.text(stages[stage] ?? 0)).monospacedDigit()
                } label: {
                    Label {
                        Text(stage.label)
                    } icon: {
                        Circle().fill(stage.tint).frame(width: 10, height: 10)
                    }
                }
            }
        } header: {
            if let title { Text(title) }
        }
    }
}

/// W, M and 6M's chart: each night's stages stacked, scrolled across every night. Its own
/// view, so a scrub redraws only it (E3).
private struct SleepRangeChart: View {
    let nights: [SleepNight]
    let geometry: LiveChartGeometry
    @Binding var scrolledTo: Date
    @Binding var selected: SleepNight?

    var body: some View {
        Chart {
            ForEach(nights) { night in
                ForEach(SleepPage.bars(night), id: \.0) { stage, seconds in
                    BarMark(x: .value("Night", night.day, unit: .day), y: .value("Hours", seconds / 3600))
                        .foregroundStyle(by: .value("Stage", stage.label))
                        .opacity(selected == nil || selected == night ? 1 : 0.4)
                }
            }
            if let selected { SelectionRule(date: selected.day, unit: .day) }
        }
        .chartForegroundStyleScale(domain: Self.stacked.map(\.label), range: Self.stacked.map(\.tint))
        .chartLegend(.hidden)
        .chartYAxis { AxisMarks { value in
            AxisGridLine()
            AxisValueLabel { if let hours = value.as(Double.self) { Text("\(Int(hours)) hr") } }
        } }
        .modifier(ScrollingChart(geometry: geometry, items: nights, date: \.day, scrolledTo: $scrolledTo, selected: $selected))
        .accessibilityChartDescriptor(SleepRangeDescriptor(nights: nights, geometry: geometry, from: scrolledTo))
    }

    private static let stacked: [SleepStage] = [.deep, .core, .rem, .asleep, .inBed]
}

/// VoiceOver's audio graph of one night: each segment's stage over time (AC12). A night
/// without stages is named for what it holds: time asleep, or time in bed (Codex R3).
struct SleepNightDescriptor: AXChartDescriptorRepresentable {
    let night: SleepNight
    let rows: [SleepStage]
    let calendar: Calendar

    var title: String { night.hasStages ? "Sleep stages" : night.isInBedOnly ? "Time in bed" : "Time asleep" }

    func makeChartDescriptor() -> AXChartDescriptor {
        let calendar = calendar
        let xAxis = AXNumericDataAxisDescriptor(title: "Time", range: night.start.timeIntervalSince1970...max(night.start.timeIntervalSince1970, night.end.timeIntervalSince1970), gridlinePositions: []) {
            Date(timeIntervalSince1970: $0).formatted(Date.FormatStyle(date: .omitted, time: .shortened, calendar: calendar, timeZone: calendar.timeZone))
        }
        // The stage as its row, top first, read back as its name.
        let rows = rows
        let yAxis = AXNumericDataAxisDescriptor(title: "Stage", range: 0...Double(max(rows.count - 1, 1)), gridlinePositions: []) { index in
            rows.indices.contains(Int(index)) ? rows[Int(index)].label : ""
        }
        let points = night.segments.compactMap { segment in
            rows.firstIndex(of: segment.stage).map { AXDataPoint(x: segment.start.timeIntervalSince1970, y: Double($0), label: segment.stage.label) }
        }
        return AXChartDescriptor(title: title, summary: nil, xAxis: xAxis, yAxis: yAxis, additionalAxes: [],
                                 series: [AXDataSeriesDescriptor(name: night.hasStages ? "Stages" : title, isContinuous: false, dataPoints: points)])
    }
}

/// VoiceOver's audio graph of the nights in view (AC12, adversary R8): each night's time
/// asleep, or "Time in bed" when the nights in view hold only time in bed (Codex R3).
struct SleepRangeDescriptor: AXChartDescriptorRepresentable {
    let nights: [SleepNight]
    let calendar: Calendar

    init(nights: [SleepNight], geometry: LiveChartGeometry, from start: Date) {
        self.nights = geometry.inView(nights, by: \.day, from: start)
        calendar = geometry.calendar
    }

    /// As the headline reads them (N4): time asleep, of the nights with sleep; time in bed
    /// only when every night in view has none.
    private var inBed: Bool { nights.contains(where: \.isInBedOnly) && !nights.contains { $0.asleep > 0 } }
    var title: String { inBed ? "Time in bed" : "Time asleep" }

    func makeChartDescriptor() -> AXChartDescriptor {
        let (calendar, title) = (calendar, title)
        let time: KeyPath<SleepNight, TimeInterval> = inBed ? \.inBed : \.asleep
        let plotted = nights.filter { $0[keyPath: time] > 0 }
        let times = plotted.map { $0.day.timeIntervalSince1970 }
        let hours = plotted.map { $0[keyPath: time] / 3600 }
        let xAxis = AXNumericDataAxisDescriptor(title: "Night", range: (times.min() ?? 0)...(times.max() ?? 0), gridlinePositions: []) {
            Date(timeIntervalSince1970: $0).formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, calendar: calendar, timeZone: calendar.timeZone))
        }
        let yAxis = AXNumericDataAxisDescriptor(title: title, range: 0...max(hours.max() ?? 0, 1), gridlinePositions: []) {
            LiveMetric.sleep.text($0 * 3600)
        }
        return AXChartDescriptor(title: title, summary: nil, xAxis: xAxis, yAxis: yAxis, additionalAxes: [],
                                 series: [AXDataSeriesDescriptor(name: title, isContinuous: false, dataPoints: zip(times, hours).map { AXDataPoint(x: $0, y: $1) })])
    }
}
