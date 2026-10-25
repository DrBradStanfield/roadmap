import Charts
import SwiftUI

/// Sleep's page, built as Apple Health's Sleep page displays it (AC9): on D, one night's
/// stages (Awake, REM, Core, Deep) over its clock times in Apple's stage colours, each
/// stage's time beside it; on W, M and 6M, each night's time asleep with the stages'
/// averages. A source with only "Asleep" or "In Bed" shows those, without stages.
/// Read-only, read from HealthKit each time it shows (AC2).
struct SleepPage: View {
    let live: LiveHealth
    @State private var range: LiveRange = .day
    @State private var nights: [SleepNight] = []
    @State private var read = false
    /// D's night, counted back from the newest (0).
    @State private var back = 0
    @State private var scrolledTo = Date.distantPast
    @State private var finger: Date?
    @State private var selected: SleepNight?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Range", selection: $range) {
                        ForEach(LiveRange.sleep) { Text($0.rawValue).tag($0).accessibilityLabel($0.spoken) }
                    }
                    .pickerStyle(.segmented)
                    if read && nights.isEmpty {
                        Text("No sleep in Apple Health for this time.").font(.subheadline).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, minHeight: 220)
                    } else if range == .day {
                        dayView
                    } else {
                        rangeView
                    }
                    Text("From Apple Health").font(.footnote).foregroundStyle(.secondary)
                }
                .padding(.vertical, 6)
            }
            if range == .day, let night = night {
                stagesList(night.hasStages ? night.stages : [.asleep: night.asleep, .inBed: night.inBed], title: nil)
            } else if range != .day {
                let shown = selected.map { [$0] } ?? geometry.inViewNights(nights, from: scrolledTo)
                let averages = LiveMaths.stageAverages(shown)
                if !averages.isEmpty { stagesList(averages, title: selected == nil ? "Average" : nil) }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Sleep")
        .navigationBarTitleDisplayMode(.inline)
        .task { await load() }
        .onChange(of: range, initial: true) {
            selected = nil
            scrolledTo = geometry.windowStart
        }
    }

    private var geometry: LiveChartGeometry {
        LiveChartGeometry(range: range, now: live.now(), calendar: live.calendar, first: nights.first?.day)
    }

    /// D's night, newest first.
    private var night: SleepNight? {
        let held = nights.filter { $0.asleep > 0 || $0.inBed > 0 }
        return back < held.count ? held[held.count - 1 - back] : nil
    }

    private func load() async {
        guard let read = try? await LiveHealth.readNights(live.store, now: live.now(), calendar: live.calendar) else { return }
        (nights, self.read) = (read, true)
    }

    // MARK: D

    @ViewBuilder
    private var dayView: some View {
        let held = nights.filter { $0.asleep > 0 || $0.inBed > 0 }.count
        if let night {
            HStack(alignment: .bottom) {
                total(title: night.asleep > 0 ? "Time Asleep" : "Time in Bed", seconds: night.asleep > 0 ? night.asleep : night.inBed,
                      span: night.day.formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, calendar: live.calendar, timeZone: live.calendar.timeZone)))
                Spacer()
                Button { back += 1 } label: { Image(systemName: "chevron.left") }
                    .disabled(back + 1 >= held)
                    .accessibilityLabel("Night before")
                Button { back -= 1 } label: { Image(systemName: "chevron.right") }
                    .disabled(back == 0)
                    .accessibilityLabel("Night after")
            }
            .buttonStyle(.borderless)
            hypnogram(night)
        }
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
        let inView = geometry.inViewNights(nights, from: scrolledTo)
        let average = selected.map(\.asleep) ?? LiveMaths.averageAsleep(inView)
        total(title: selected == nil ? "Avg. Time Asleep" : "Time Asleep", seconds: average,
              span: selected.map { geometry.label(of: $0.day) } ?? geometry.label(from: scrolledTo))
        Chart {
            ForEach(nights) { night in
                ForEach(Self.bars(night), id: \.0) { stage, seconds in
                    BarMark(x: .value("Night", night.day, unit: .day), y: .value("Hours", seconds / 3600))
                        .foregroundStyle(by: .value("Stage", stage.label))
                        .opacity(selected == nil || selected == night ? 1 : 0.4)
                }
            }
            if let selected {
                RuleMark(x: .value("Night", selected.day, unit: .day))
                    .foregroundStyle(Color.secondary.opacity(0.5))
                    .lineStyle(StrokeStyle(lineWidth: 1))
            }
        }
        .chartForegroundStyleScale(domain: [SleepStage.deep, .core, .rem, .asleep].map(\.label), range: [SleepStage.deep, .core, .rem, .asleep].map(\.tint))
        .chartLegend(.hidden)
        .chartYAxis { AxisMarks { value in
            AxisGridLine()
            AxisValueLabel { if let hours = value.as(Double.self) { Text("\(Int(hours)) hr") } }
        } }
        .chartXAxis { AxisMarks(preset: .aligned, values: .automatic(desiredCount: 4)) { _ in
            AxisGridLine()
            AxisValueLabel(format: geometry.axisFormat)
        } }
        .chartXScale(domain: geometry.domain)
        .chartScrollableAxes(.horizontal)
        .chartXVisibleDomain(length: geometry.window)
        .chartScrollPosition(x: $scrolledTo)
        .chartXSelection(value: $finger)
        .onChange(of: finger) {
            let near = finger.flatMap { finger in inView.min { abs($0.day.timeIntervalSince(finger)) < abs($1.day.timeIntervalSince(finger)) } }
            if near != selected { selected = near }
        }
        .sensoryFeedback(.selection, trigger: selected) { _, new in new != nil }
        .environment(\.calendar, live.calendar)
        .environment(\.timeZone, live.calendar.timeZone)
        .frame(minHeight: 220)
        .accessibilityChartDescriptor(SleepRangeDescriptor(nights: nights, calendar: live.calendar))
    }

    /// A night's bar: its asleep stages stacked, deep at the bottom; or one "Asleep" bar.
    static func bars(_ night: SleepNight) -> [(SleepStage, TimeInterval)] {
        night.hasStages ? [SleepStage.deep, .core, .rem].map { ($0, night.stages[$0] ?? 0) } : [(.asleep, night.asleep)]
    }

    // MARK: Parts

    private func total(title: String, seconds: TimeInterval?, span: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                if let seconds, seconds > 0 {
                    ForEach(LiveMaths.duration(seconds), id: \.1) { number, unit in
                        HStack(alignment: .firstTextBaseline, spacing: 3) {
                            Text(number).font(.system(.largeTitle, design: .rounded).weight(.semibold)).monospacedDigit()
                            Text(unit).font(.title3).foregroundStyle(.secondary)
                        }
                    }
                } else {
                    Text("None").font(.system(.largeTitle, design: .rounded).weight(.semibold))
                }
            }
            Text(span).font(.subheadline).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    /// Each stage's time with its colour, as Apple Health lists them under the chart.
    private func stagesList(_ stages: [SleepStage: TimeInterval], title: String?) -> some View {
        Section {
            ForEach(stages.keys.sorted(), id: \.self) { stage in
                LabeledContent {
                    Text(LiveMaths.duration(stages[stage] ?? 0).map { "\($0.0) \($0.1)" }.joined(separator: " ")).monospacedDigit()
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

extension LiveChartGeometry {
    /// The nights dated in view.
    func inViewNights(_ nights: [SleepNight], from start: Date) -> [SleepNight] {
        let start = max(start, domain.lowerBound)
        let stop = start.addingTimeInterval(window)
        return nights.filter { $0.day >= start && $0.day < stop }
    }
}

/// VoiceOver's audio graph of one night: each segment's stage over time (AC12).
private struct SleepNightDescriptor: AXChartDescriptorRepresentable {
    let night: SleepNight
    let rows: [SleepStage]
    let calendar: Calendar

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
        return AXChartDescriptor(title: "Sleep stages", summary: nil, xAxis: xAxis, yAxis: yAxis, additionalAxes: [],
                                 series: [AXDataSeriesDescriptor(name: "Stages", isContinuous: false, dataPoints: points)])
    }
}

/// VoiceOver's audio graph of the nights' time asleep (AC12).
private struct SleepRangeDescriptor: AXChartDescriptorRepresentable {
    let nights: [SleepNight]
    let calendar: Calendar

    func makeChartDescriptor() -> AXChartDescriptor {
        let calendar = calendar
        let times = nights.map { $0.day.timeIntervalSince1970 }
        let hours = nights.map { $0.asleep / 3600 }
        let xAxis = AXNumericDataAxisDescriptor(title: "Night", range: (times.min() ?? 0)...(times.max() ?? 0), gridlinePositions: []) {
            Date(timeIntervalSince1970: $0).formatted(Date.FormatStyle(date: .abbreviated, time: .omitted, calendar: calendar, timeZone: calendar.timeZone))
        }
        let yAxis = AXNumericDataAxisDescriptor(title: "Time asleep", range: 0...max(hours.max() ?? 0, 1), gridlinePositions: []) {
            LiveMaths.duration($0 * 3600).map { "\($0.0) \($0.1)" }.joined(separator: " ")
        }
        return AXChartDescriptor(title: "Time asleep", summary: nil, xAxis: xAxis, yAxis: yAxis, additionalAxes: [],
                                 series: [AXDataSeriesDescriptor(name: "Time asleep", isContinuous: false, dataPoints: zip(times, hours).map { AXDataPoint(x: $0, y: $1) })])
    }
}
