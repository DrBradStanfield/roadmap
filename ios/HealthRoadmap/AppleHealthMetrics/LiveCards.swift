import SwiftUI
import UIKit

/// US-56's cards on My health: the Turn On row until Apple's sheet is done (AC4, AC5), then
/// sleep under Sleep and VO2 max, resting heart rate and steps under Fitness (AC6, US-73),
/// each in the vitals card style. A metric with no data is left out. The section reads
/// `LiveHealth` from the environment, so My health adds one line for each place.

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
    /// Where Apple Health's settings for this app are (AC5c). iOS 18 moved Health under
    /// Settings › Apps; the app runs from iOS 17. The iOS 27 path was checked on the simulator
    /// 2026-11-01 (the app's own Settings page has no Health row); iOS 17's is Apple's known
    /// layout, not seen on a simulator.
    static func healthPath(appsMenu: Bool) -> String {
        "Settings › \(appsMenu ? "Apps › " : "")Health › Data Access & Devices › Health Roadmap"
    }
    static var healthPath: String {
        if #available(iOS 18, *) { return healthPath(appsMenu: true) }
        return healthPath(appsMenu: false)
    }
    static var access: String { "To change what Health Roadmap can read: \(healthPath)." }
    /// The settings sheet's line on the cards: kept on this iPhone, and where to change access.
    static var cards: String { "\(shownOnly) \(access)" }
    /// The Turn On and Open Settings row's words (AC5, AC5b).
    static let reconnect = "Resting heart rate, sleep, VO2 max and steps can show here from Apple Health."
    /// The line under the row's button: these are Apple Health's settings, and where (AC5c, Brad 2026-11-01).
    static var healthSettings: String { "The Apple Health settings for this app are in \(healthPath)." }
}

/// One topic's Apple Health cards (AC5, AC6), each its own section, under the topic's heading
/// and urgent cards (`header`) and over its other plan cards (`footer`). On My health (US-73):
/// sleep under Sleep; under Fitness VO2 max, resting heart rate and steps, or the Turn On or
/// Open Settings row. It reads `LiveHealth` here, not in My health's list, so a live refresh
/// redraws this section alone; the heading shows when the topic has plan cards or this has rows.
struct LiveCardsSection<Header: View, Footer: View>: View {
    @Environment(LiveHealth.self) private var live: LiveHealth?
    @Environment(AppleHealthSync.self) private var health: AppleHealthSync?
    let metrics: [LiveMetric]
    /// The bands by metric, for a card's band (US-56 AC8): My health hands VO2 max's only.
    var bands: [LiveMetric: Vo2MaxBands] = [:]
    /// This place keeps the Turn On / Open Settings row: My health's Fitness, not its Sleep (US-73).
    /// Their "From Apple Health…" line is in the settings sheet's Apple Health section.
    let keepsReconnect: Bool
    /// The topic has plan cards, so its heading shows whatever Health holds.
    let hasCards: Bool
    let open: (LiveMetric) -> Void
    @ViewBuilder let header: Header
    @ViewBuilder let footer: Footer

    var body: some View {
        let shown = LiveShown.shown(metrics, keepsReconnect: keepsReconnect, live: live, health: health)
        if hasCards || shown != .nothing {
            header
            if let live {
                switch shown {
                case .nothing:
                    EmptyView()
                case .turnOn, .reconnect:
                    Section { LiveReconnectRow(live: live, turnOn: shown == .turnOn) }
                        .listSectionSpacing(.compact)
                case .cards(let shown):
                    ForEach(shown) { metric in
                        if let card = live.cards[metric] {
                            Section {
                                Button { open(metric) } label: { LiveCardView(metric: metric, card: card, now: live.now(), calendar: live.calendar, band: bands[metric]?.band(card.value)) }
                                    .tint(.primary)
                            }
                            .listSectionSpacing(.compact)
                        }
                    }
                }
            }
            footer
        }
    }
}

/// What a place of Apple Health cards shows.
enum LiveShown: Equatable {
    case nothing, turnOn, reconnect
    /// The metrics with a reading, in order.
    case cards([LiveMetric])

    /// The place that keeps the reconnect row shows the Turn On row until Apple's sheet is done
    /// (AC4, AC5), only to a person who connected Apple Health: otherwise the settings sheet's
    /// Apple Health row is the way in. After it, the cards with a reading. With none anywhere,
    /// after a "Don't Allow" or with an empty Health (iOS cannot tell them apart), it shows one
    /// calm Open Settings row, never an error or a greyed line (AC5b, Brad 2026-10-25). A place
    /// with none of its own metrics shows nothing, so its heading hides (US-73 AC2). Nothing
    /// while the answer is unknown or unread.
    static func shown(_ metrics: [LiveMetric], connected: Bool, needsAccess: Bool?, hasRead: Bool, cards: [LiveMetric: LiveCard], keepsReconnect: Bool) -> LiveShown {
        if needsAccess == true { return keepsReconnect && connected ? .turnOn : .nothing }
        guard needsAccess == false, hasRead else { return .nothing }
        if keepsReconnect, cards.isEmpty { return .reconnect }
        let held = metrics.filter { cards[$0] != nil }
        return held.isEmpty ? .nothing : .cards(held)
    }

    /// What this place shows now; `.nothing` without live Health. The sync's status is read only
    /// where it matters, before the sheet, so its import never redraws the cards (review, efficiency 2).
    @MainActor static func shown(_ metrics: [LiveMetric], keepsReconnect: Bool, live: LiveHealth?, health: AppleHealthSync?) -> LiveShown {
        guard let live, live.available else { return .nothing }
        let connected = keepsReconnect && live.needsAccess == true && health?.connected == true
        return shown(metrics, connected: connected, needsAccess: live.needsAccess, hasRead: live.hasRead, cards: live.cards, keepsReconnect: keepsReconnect)
    }
}

/// After "Don't Allow", or with nothing in Health (AC5b, Brad 2026-10-25): one calm row in
/// normal text with an Open Settings button and, under it, where Apple Health's settings for the app are (AC5c).
/// For a person who connected Apple Health before 2026-10-26 and was never asked for the five,
/// the same row says Turn On (AC5). Either button runs the app's one Health connect while iOS
/// would still show the sheet, else opens Settings. VoiceOver reads the words as one
/// element, then the button.
struct LiveReconnectRow: View {
    /// The button's words. iOS asks only once, so after the sheet the button almost always
    /// opens Settings, and says so (AC5c, Brad 2026-11-01: "Reconnect" reconnected nothing).
    /// While the sheet would still show (a stale answer), the same tap shows it instead.
    static func title(turnOn: Bool) -> String { turnOn ? "Turn On" : "Open Settings" }

    let live: LiveHealth
    let turnOn: Bool
    @Environment(AppleHealthSync.self) private var health: AppleHealthSync?
    @State private var asking = false
    @Environment(\.openURL) private var openURL

    /// What the button does: the one connect, or Settings.
    enum Action { case connect, settings }

    /// Turn On acts on the known answer (the sheet is due). Open Settings checks afresh, since
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
                .accessibilityLabel("\(LiveFooter.reconnect) \(LiveFooter.healthSettings)")
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
                Text(Self.title(turnOn: turnOn)).frame(maxWidth: .infinity)
            }
            .buttonStyle(.bordered)
            .disabled(asking)
            Text(LiveFooter.healthSettings)
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
        let when = DayText.when(card.date, time: false, now: now, calendar: calendar)
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

    /// "Resting Heart Rate, 58 beats per minute, Today."
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
