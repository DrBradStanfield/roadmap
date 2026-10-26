import SwiftUI
import UIKit

/// US-56's cards on My data: the Turn On row until Apple's sheet is done (AC4, AC5), then
/// heart rate, resting heart rate and sleep in Vitals and VO2 max and steps under Fitness
/// (AC6), each in the vitals card style. A metric with no data is left out. The section
/// reads `LiveHealth` from the environment, so My data adds one line for each place.

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

/// The footer under the new cards (AC6, AC4; AC2 since Brad 2026-10-27).
enum LiveFooter {
    static let shownOnly = "From Apple Health. Kept on this iPhone only, so the cards show at once: not in your record or on the website."
    /// The path as iOS 27 has it (checked on the simulator 2026-10-25: Health moved under Apps).
    static let access = "To change what Health Roadmap can read: Settings › Apps › Health › Data Access & Devices › Health Roadmap."
    /// The Turn On and Reconnect row's words (AC5, AC5b).
    static let reconnect = "Heart rate, sleep, VO2 max and steps can show here from Apple Health."
}

/// One place's cards (AC5, AC6), each its own section as the vitals are. In Vitals, under
/// blood pressure: the Turn On row, or heart rate, resting heart rate and sleep, or the
/// Reconnect row. Under Fitness: VO2 max and steps, not shown when neither has data.
struct LiveCardsSection: View {
    @Environment(LiveHealth.self) private var live: LiveHealth?
    @Environment(AppleHealthSync.self) private var health: AppleHealthSync?
    /// `LiveMetric.vitals` or `LiveMetric.fitness`.
    let metrics: [LiveMetric]
    /// The bands by metric, for a card's band (US-56 AC8): My data hands VO2 max's only.
    var bands: [LiveMetric: Vo2MaxBands] = [:]
    let open: (LiveMetric) -> Void

    /// What a place shows.
    enum Shown: Equatable {
        case nothing, turnOn, reconnect
        /// The metrics with a reading, in order.
        case cards([LiveMetric])
    }

    /// Vitals shows the Turn On row until Apple's sheet is done (AC4, AC5), only to a person
    /// who connected Apple Health: otherwise My data's Apple Health row is the way in. After it, the
    /// cards with a reading. With none anywhere, after a "Don't Allow" or with an empty Health
    /// (iOS cannot tell them apart), Vitals shows one calm Reconnect row, never an error or a
    /// greyed line (AC5b, Brad 2026-10-25). Nothing while the answer is unknown or unread.
    static func shown(_ metrics: [LiveMetric], connected: Bool, needsAccess: Bool?, hasRead: Bool, cards: [LiveMetric: LiveCard]) -> Shown {
        let vitals = metrics == LiveMetric.vitals
        if needsAccess == true { return vitals && connected ? .turnOn : .nothing }
        guard needsAccess == false, hasRead else { return .nothing }
        if vitals, cards.isEmpty { return .reconnect }
        let held = metrics.filter { cards[$0] != nil }
        return held.isEmpty && !vitals ? .nothing : .cards(held)
    }

    var body: some View {
        if let live, live.available {
            // The sync's status is read only where it matters, Vitals before the sheet, so its
            // import never redraws the cards (review, efficiency 2).
            let connected = metrics == LiveMetric.vitals && live.needsAccess == true && health?.connected == true
            let shown = Self.shown(metrics, connected: connected, needsAccess: live.needsAccess, hasRead: live.hasRead, cards: live.cards)
            switch shown {
            case .nothing:
                EmptyView()
            case .turnOn, .reconnect:
                Section { LiveReconnectRow(live: live, turnOn: shown == .turnOn) }
                    .listSectionSpacing(.compact)
            case .cards(let shown):
                let vitals = metrics == LiveMetric.vitals
                let fitnessFollows = LiveMetric.fitness.contains { live.cards[$0] != nil }
                ForEach(shown) { metric in
                    if let card = live.cards[metric] {
                        Section {
                            Button { open(metric) } label: { LiveCardView(metric: metric, card: card, now: live.now(), calendar: live.calendar, band: bands[metric]?.band(card.value)) }
                                .tint(.primary)
                        } header: {
                            if !vitals, metric == shown.first { SectionTitle.fitness() }
                        } footer: {
                            // Fitness, when shown, carries the access line, so it is said once.
                            if metric == shown.last { Text(vitals && fitnessFollows ? LiveFooter.shownOnly : "\(LiveFooter.shownOnly) \(LiveFooter.access)") }
                        }
                        .listSectionSpacing(.compact)
                    }
                }
            }
        }
    }
}

/// After "Don't Allow", or with nothing in Health (AC5b, Brad 2026-10-25): one calm row in
/// normal text with a Reconnect button and, under it, where the readings are turned on.
/// For a person who connected Apple Health before 2026-10-26 and was never asked for the five,
/// the same row says Turn On (AC5). Either button runs the app's one Health connect while iOS
/// would still show the sheet, else opens Settings. VoiceOver reads the words as one
/// element, then the button.
struct LiveReconnectRow: View {
    let live: LiveHealth
    let turnOn: Bool
    @Environment(AppleHealthSync.self) private var health: AppleHealthSync?
    @State private var asking = false
    @Environment(\.openURL) private var openURL

    /// What the button does: the one connect, or Settings.
    enum Action { case connect, settings }

    /// Turn On acts on the known answer (the sheet is due). Reconnect checks afresh, since
    /// iOS shows the sheet only once: still due, the connect; answered or unknown, Settings.
    static func action(turnOn: Bool, due: () async throws -> Bool) async -> Action {
        if turnOn { return .connect }
        return (try? await due()) == true ? .connect : .settings
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(LiveFooter.reconnect)
                .font(.subheadline)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityLabel("\(LiveFooter.reconnect) \(LiveFooter.access)")
            Button {
                asking = true
                Task {
                    switch await Self.action(turnOn: turnOn, due: { try await live.store.needsRequest() }) {
                    case .connect: await health?.connect()
                    case .settings: if let settings = URL(string: UIApplication.openSettingsURLString) { openURL(settings) }
                    }
                    asking = false
                }
            } label: {
                Text(turnOn ? "Turn On" : "Reconnect").frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(asking)
            Text(LiveFooter.access)
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 4)
    }
}

/// One metric's card, drawn as a vital's (`CardShell`): the plain name, its day or time
/// and a chevron on top; the value large with its trend in the metric's colour. VoiceOver
/// reads it as one sentence (AC12).
struct LiveCardView: View {
    let metric: LiveMetric
    let card: LiveCard
    let now: Date
    let calendar: Calendar
    var band: Vo2MaxBand? = nil

    var body: some View {
        // Heart rate's card is its newest sample: today it shows the time, as Apple Health's does.
        let when = DayText.when(card.date, time: metric.aggregation == .range, now: now, calendar: calendar)
        CardShell(label: metric.label, when: when, trend: card.trend, tint: metric.tint) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                LiveValue(metric: metric, value: card.value)
                if card.inBed { Text("in bed").font(.subheadline.weight(.medium)).foregroundStyle(.secondary) }
                if let band { Text(band.label).font(.subheadline.weight(.medium)).foregroundStyle(.secondary) }
            }
        }
        .contentShape(Rectangle())
        .accessibilityLabel(LiveCardView.spoken(metric, card: card, when: when, band: band))
    }

    /// "Heart Rate, 72 beats per minute, 10:42."
    static func spoken(_ metric: LiveMetric, card: LiveCard, when: String, band: Vo2MaxBand? = nil) -> String {
        let reading = metric == .sleep ? "\(metric.text(card.value)) \(card.inBed ? "in bed" : "asleep")" : "\(metric.text(card.value)) \(metric.spokenUnit)"
        return "\(metric.label), \(reading), \(when)\(band.map { ", \($0.label)" } ?? "")"
    }
}

/// A value large with its unit; sleep's hours and minutes each with theirs, as Apple Health writes it.
struct LiveValue: View {
    let metric: LiveMetric
    let value: Double

    var body: some View {
        if metric == .sleep {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                ForEach(LiveMaths.duration(value), id: \.self) { CardValue(value: $0.number, unit: $0.unit) }
            }
        } else {
            CardValue(value: metric.text(value), unit: metric.unit)
        }
    }
}
