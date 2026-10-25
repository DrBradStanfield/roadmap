import SwiftUI

/// US-56's cards on My data: the access card until Apple's sheet is done (AC4, AC5), then
/// heart rate, resting heart rate and sleep in Vitals and VO2 max and steps under Fitness
/// (AC6), each in the vitals card style. A metric with no data is left out. The sections
/// read `LiveHealth` from the environment, so My data adds one line for each.

extension LiveMetric {
    /// Its graph colour.
    var tint: Color { MetricChart.colors(for: paletteKey)[0] }
}

extension SleepStage {
    /// Apple Health's stage colours, matched by eye (to check side by side on Brad's iPhone, AC9).
    var tint: Color {
        switch self {
        case .awake: Color(light: 0xE8603C, dark: 0xF0927A)
        case .rem: Color(light: 0x1E9BD7, dark: 0x6EC1EA)
        case .core: Color(light: 0x0A60D6, dark: 0x5E95E8)
        case .deep: Color(light: 0x4B3FB8, dark: 0x8E85E0)
        case .asleep: LiveMetric.sleep.tint
        case .inBed: Color(light: 0x6E8B8A, dark: 0x8FA9A7)
        }
    }
}

extension SectionTitle {
    /// VO2 max and steps (AC6), in activity orange.
    static func fitness() -> Self { Self(title: "Fitness", symbol: "figure.run", tint: .orange) }
}

/// The footer under the new cards (AC6, AC4).
enum LiveFooter {
    static let shownOnly = "From Apple Health. Shown here only: not saved to your record or the website."
    static let access = "To change what Health Roadmap can read: Settings › Health › Data Access & Devices › Health Roadmap."
}

/// Vitals' part (AC5, AC6): the access card, or heart rate, resting heart rate and sleep,
/// each its own section as the vitals are. Placed in Vitals under blood pressure.
struct LiveVitalsCards: View {
    @Environment(LiveHealth.self) private var live: LiveHealth?
    let open: (LiveMetric) -> Void

    var body: some View {
        if let live, live.available {
            if live.needsAccess == true {
                Section { LiveAccessCard(live: live) }
                    .listSectionSpacing(.compact)
            } else if live.needsAccess == false, live.hasRead {
                let shown = LiveMetric.vitals.filter { live.cards[$0] != nil }
                let nothing = shown.isEmpty && LiveMetric.fitness.allSatisfy { live.cards[$0] == nil }
                ForEach(shown) { metric in
                    Section {
                        Button { open(metric) } label: { LiveCardView(metric: metric, card: live.cards[metric]!, now: live.now(), calendar: live.calendar) }
                            .tint(.primary)
                    } footer: {
                        if metric == shown.last { footer(fitnessFollows: LiveMetric.fitness.contains { live.cards[$0] != nil }) }
                    }
                    .listSectionSpacing(.compact)
                }
                // Nothing to show: refused or empty look the same (AC4), so say where access lives.
                if nothing {
                    Section {
                        Label("No heart, sleep or fitness data in Apple Health yet.", systemImage: "heart.text.square")
                            .foregroundStyle(.secondary)
                    } footer: {
                        Text(LiveFooter.access)
                    }
                    .listSectionSpacing(.compact)
                }
            }
        }
    }

    /// Fitness, when shown, carries the access line, so it is said once.
    private func footer(fitnessFollows: Bool) -> some View {
        Text(fitnessFollows ? LiveFooter.shownOnly : "\(LiveFooter.shownOnly) \(LiveFooter.access)")
    }
}

/// The Fitness heading's cards (AC6): VO2 max and steps; not shown when neither has data.
struct LiveFitnessSection: View {
    @Environment(LiveHealth.self) private var live: LiveHealth?
    let open: (LiveMetric) -> Void

    var body: some View {
        if let live, live.available, live.needsAccess == false {
            let shown = LiveMetric.fitness.filter { live.cards[$0] != nil }
            ForEach(Array(shown.enumerated()), id: \.element) { index, metric in
                Section {
                    Button { open(metric) } label: { LiveCardView(metric: metric, card: live.cards[metric]!, now: live.now(), calendar: live.calendar) }
                        .tint(.primary)
                } header: {
                    if index == 0 { SectionTitle.fitness() }
                } footer: {
                    if index == shown.count - 1 { Text("\(LiveFooter.shownOnly) \(LiveFooter.access)") }
                }
                .listSectionSpacing(.compact)
            }
        }
    }
}

/// The access card (AC5): a heart, the title, one line and one button, in the vitals card
/// style. No "Not now": it stays until tapped.
struct LiveAccessCard: View {
    let live: LiveHealth
    @State private var asking = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label {
                Text("Heart, sleep and fitness").font(.subheadline.weight(.semibold))
            } icon: {
                Image(systemName: "heart.fill").foregroundStyle(Color.red.softInDark)
            }
            Text("See your heart rate, sleep, VO2 max and steps from Apple Health here. They stay in Apple Health: we only show them.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button {
                asking = true
                Task {
                    await live.requestAccess()
                    asking = false
                }
            } label: {
                Text("Show from Apple Health").frame(maxWidth: .infinity).onAccentLabel()
            }
            .buttonStyle(.borderedProminent)
            .disabled(asking)
        }
        .padding(.vertical, 4)
    }
}

/// One metric's card, drawn as a vital's (`ValueRow` with `card:`): the plain name, its day
/// or time and a chevron on top; the value large with its trend in the metric's colour.
/// VoiceOver reads it as one sentence (AC12); at accessibility sizes the name stacks over the day.
struct LiveCardView: View {
    let metric: LiveMetric
    let card: LiveCard
    let now: Date
    let calendar: Calendar
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        let when = LiveMaths.when(card.date, showsTime: card.showsTime, now: now, calendar: calendar)
        VStack(alignment: .leading, spacing: 10) {
            LabelValue.layout(textSize).callAsFunction {
                Text(metric.label).font(.subheadline.weight(.semibold))
                Spacer()
                HStack {
                    Text(when).font(.footnote).foregroundStyle(.secondary)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
                }
            }
            HStack(alignment: .bottom) {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    LiveValue(metric: metric, value: card.value)
                    if card.inBed { Text("in bed").font(.subheadline.weight(.medium)).foregroundStyle(.secondary) }
                }
                Spacer(minLength: 12)
                if !textSize.isAccessibilitySize {
                    Sparkline(points: card.trend, tint: metric.tint, size: CGSize(width: 110, height: 40))
                }
            }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(LiveCardView.spoken(metric, card: card, when: when))
        .accessibilityAddTraits(.isButton)
    }

    /// "Heart Rate, 72 beats per minute, 10:42."
    static func spoken(_ metric: LiveMetric, card: LiveCard, when: String) -> String {
        let value = card.value
        let reading = metric == .sleep ? "\(metric.text(value)) \(card.inBed ? "in bed" : "asleep")" : "\(metric.text(value)) \(metric.spokenUnit)"
        return "\(metric.label), \(reading), \(when)"
    }
}

/// A value large with its unit; sleep's hours and minutes each with theirs, as Apple Health writes it.
struct LiveValue: View {
    let metric: LiveMetric
    let value: Double

    var body: some View {
        if metric == .sleep {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                ForEach(LiveMaths.duration(value), id: \.1) { CardValue(value: $0.0, unit: $0.1) }
            }
        } else {
            CardValue(value: metric.text(value), unit: metric.unit)
        }
    }
}
