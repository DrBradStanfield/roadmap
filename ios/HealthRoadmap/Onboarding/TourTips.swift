import SwiftUI
import TipKit

/// Where the tour is (US-57): the three tips in order, then done. The tips' rules read it
/// through `Tour.$step`, so TipKit keeps it across launches.
enum TourStep: Int, Codable, Sendable, CaseIterable {
    case notStarted, snapshot, foundation, bloodTests, done

    /// After onboarding finishes on My plan (AC1). Once only: a started tour never restarts.
    func started() -> TourStep { self == .notStarted ? .snapshot : self }

    /// A tip of this step was closed or acted on (AC2, AC3): the next tip, or done.
    /// A tip that is not the current one changes nothing (a late status update).
    func closing(_ tip: TourStep) -> TourStep {
        guard tip == self, isTip else { return self }
        return TourStep(rawValue: rawValue + 1) ?? .done
    }

    /// "Skip tour" (AC3), or the person's third own save (review R2b), ends a running
    /// tour. A tour that never started stays so.
    func ended() -> TourStep { isTip ? .done : self }

    /// One of the three tips, not before or after the tour.
    var isTip: Bool { self != .notStarted && self != .done }
}

/// The tour's state, held in TipKit's store.
enum Tour {
    /// `TourStep`'s raw value; TipKit's rules compare plain values.
    @Parameter static var step: Int = TourStep.notStarted.rawValue

    /// The tab on screen, `TourTab`'s raw value. TabView keeps a hidden tab's views, so a
    /// tip due on My data showed over My plan without it.
    @Parameter static var tab: Int = 0

    /// RootView tells the tour which tab shows.
    @MainActor static func showing(_ shown: TourTab) {
        if tab != shown.rawValue { tab = shown.rawValue }
    }

    static var current: TourStep { TourStep(rawValue: step) ?? .done }

    /// True when this started the tour.
    @MainActor static func start() -> Bool { move(to: current.started()) }

    /// Ends a running tour; true when it was running.
    @MainActor static func end() -> Bool { move(to: current.ended()) }

    /// `step`'s tip was closed: its x, a tap outside it, its action, or its screen having
    /// no anchor (review R4). Moves the tour on and sends "Tour tip closed n", once; a late
    /// or repeated close does nothing.
    @MainActor static func closed(_ step: TourStep, analytics: Analytics?) {
        guard move(to: current.closing(step)) else { return }
        if let event = Analytics.Event.tip(step, skipped: false) { analytics?.event(event) }
        if current == .done { finished?() }
    }

    /// "Skip tour" on `step`'s tip: ends the tour and sends "Tour skipped n".
    @MainActor static func skipped(_ step: TourStep, analytics: Analytics?) {
        guard end() else { return }
        if let event = Analytics.Event.tip(step, skipped: true) { analytics?.event(event) }
        finished?()
    }

    /// Told when a tip ends the tour, closed or skipped: RootView then offers the cloud
    /// prompt (review R2c).
    @MainActor static var finished: (() -> Void)?

    /// Writes only a step that differs (/simplify 5): TipKit re-evaluates every rule on a write.
    @MainActor private static func move(to next: TourStep) -> Bool {
        guard next != current else { return false }
        step = next.rawValue
        return true
    }

    static let skipAction = "skip"
    static let uploadAction = "upload"
}

/// The tabs a tip can show on.
enum TourTab: Int { case plan = 1, data, other }

/// One of the tour's three tips: one line (Brad 2026-10-25), shown only at its own step
/// and on its own tab.
protocol TourTip: Tip {
    static var step: TourStep { get }
    static var tab: TourTab { get }
    static var line: String { get }
}

extension TourTip {
    var title: Text { Text(Self.line) }
    var actions: [Action] { [Action(id: Tour.skipAction, title: "Skip tour")] }
    var rules: [Rule] {
        let (mine, myTab) = (Self.step.rawValue, Self.tab.rawValue)
        return [#Rule(Tour.$step) { $0 == mine }, #Rule(Tour.$tab) { $0 == myTab }]
    }
}

/// Tip 1 (AC4): the whole row of summary tiles at the top of My plan, one tip.
struct SnapshotTip: TourTip {
    static let step = TourStep.snapshot
    static let tab = TourTab.plan
    static let line = "A snapshot of your health. Tap any tile to learn more."
}

/// Tip 2 (AC6): the first card of the Foundation section.
struct FoundationTip: TourTip {
    static let step = TourStep.foundation
    static let tab = TourTab.plan
    static let line = "Start here. Each step comes with the reason and the evidence."
}

/// Tip 3 (AC7): Blood tests on My data, with the lab upload.
struct BloodTestsTip: TourTip {
    static let step = TourStep.bloodTests
    static let tab = TourTab.data
    static let line = "The more you add, the more personal your plan. A lab report fills these in for you."
    static let actionTitle = "Add a lab report"
    var actions: [Action] { [Action(id: Tour.uploadAction, title: Self.actionTitle)] }
}

extension View {
    /// Anchors one of the tour's tips here (US-57). Its x, or a tap outside it, moves the
    /// tour on (review R2a); "Skip tour" ends it; the last tip's action goes to `action`.
    func tourTip<T: TourTip>(_ tip: T, arrowEdge: Edge = .top, action: @escaping @MainActor () -> Void = {}) -> some View {
        modifier(TourTipAnchor(tip: tip, arrowEdge: arrowEdge, action: action))
    }

    /// A screen that cannot draw `tip`'s anchor (no tiles, no Foundation card): the step
    /// passes as closed once due, so the tour never stalls on it (review R4).
    func tourStep<T: TourTip>(_ tip: T, hasNoAnchor missing: Bool) -> some View {
        modifier(TourStepWithoutAnchor(tip: tip, missing: missing))
    }
}

private struct TourTipAnchor<T: TourTip>: ViewModifier {
    let tip: T
    let arrowEdge: Edge
    let action: @MainActor () -> Void
    @Environment(\.analytics) private var analytics

    func body(content: Content) -> some View {
        content
            .popoverTip(tip, arrowEdge: arrowEdge) { chosen in
                if chosen.id == Tour.skipAction {
                    Tour.skipped(T.step, analytics: analytics)
                } else {
                    closed()
                    action()
                }
            }
            // The tip's view leaves when the popover goes for any reason, a tap outside it
            // or leaving its tab included, which TipKit does not report: that counts as
            // closed (review R2a).
            .tipViewStyle(TourTipStyle(gone: closed))
            .task {
                // The x invalidates the tip: move on.
                for await status in tip.statusUpdates {
                    if case .invalidated = status { closed() }
                }
            }
    }

    private func closed() { Tour.closed(T.step, analytics: analytics) }
}

private struct TourStepWithoutAnchor<T: TourTip>: ViewModifier {
    let tip: T
    let missing: Bool
    @Environment(\.analytics) private var analytics

    func body(content: Content) -> some View {
        content.task(id: missing) {
            guard missing else { return }
            for await due in tip.shouldDisplayUpdates where due {
                Tour.closed(T.step, analytics: analytics)
            }
        }
    }
}

/// A tour tip's look: its one line, its x, "Skip tour" as plain text, and tip 3's action
/// as the app's accent button (OnAccent text, US-25 AC17c; TipKit's own drew white on the
/// light dark-mode green, about 2:1). At accessibility text sizes it scrolls rather than
/// clips (AC11).
private struct TourTipStyle: TipViewStyle {
    let gone: @MainActor () -> Void

    func makeBody(configuration: Configuration) -> some View {
        ViewThatFits(in: .vertical) {
            card(configuration)
            ScrollView { card(configuration) }
                .frame(minHeight: 200, idealHeight: 360)
        }
        .onDisappear(perform: gone)
    }

    private func card(_ configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                configuration.title?
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button { configuration.tip.invalidate(reason: .tipClosed) } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .symbolRenderingMode(.palette)
                        .foregroundStyle(Color(.secondaryLabel), Color(.tertiarySystemFill))
                        // A real 44-point target around the small symbol (review R6).
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .padding(-10)
                .accessibilityLabel("Close")
            }
            ForEach(configuration.actions) { action in
                if action.id == Tour.skipAction {
                    // Skipping is offered, not urged: a plain text button.
                    Button(action: action.handler) { action.label().font(.subheadline.weight(.semibold)) }
                        .buttonStyle(.borderless)
                } else {
                    Button(action: action.handler) { action.label() }
                        .buttonStyle(.accent)
                }
            }
        }
        .padding(20)
    }
}

/// TipKit at launch (US-57 AC10). Unit tests never configure it. The UI tests and the App
/// Store screenshots pass `--ui-testing`, which hides every tip; adding `--show-tips` starts
/// from an empty store with the tips on, for a tour UI test.
enum TourSetup {
    static let showTipsArgument = "--show-tips"

    enum Mode: Equatable { case none, hidden, fresh, normal }

    static func mode(environment: [String: String], arguments: [String]) -> Mode {
        if environment["XCTestConfigurationFilePath"] != nil { return .none }
        guard arguments.contains(Analytics.uiTestingArgument) else { return .normal }
        return arguments.contains(showTipsArgument) ? .fresh : .hidden
    }

    @MainActor static func configure(environment: [String: String] = ProcessInfo.processInfo.environment,
                                     arguments: [String] = ProcessInfo.processInfo.arguments) {
        switch mode(environment: environment, arguments: arguments) {
        case .none: return
        case .hidden: Tips.hideAllTipsForTesting()
        case .fresh: try? Tips.resetDatastore()
        case .normal: break
        }
        // The tour's order is its own rule, so no wait between tips.
        try? Tips.configure([.displayFrequency(.immediate)])
    }
}
