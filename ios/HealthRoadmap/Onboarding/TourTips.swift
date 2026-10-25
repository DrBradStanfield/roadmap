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

    /// `step`'s tip was closed: its Next, a tap outside it, its action, or its screen having
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
    static let nextAction = "next"
    static let uploadAction = "upload"
}

/// The tabs a tip can show on.
enum TourTab: Int { case plan = 1, data, other }

/// One of the tour's three tips: one line, then "Skip tour", its counter and "Next"
/// (Brad 2026-10-25), shown only at its own step and on its own tab.
protocol TourTip: Tip {
    static var step: TourStep { get }
    static var tab: TourTab { get }
    static var line: String { get }
}

extension TourTip {
    var title: Text { Text(Self.line) }
    var actions: [Action] { Self.controls }
    /// The bottom row's two buttons; the style draws the counter between them.
    static var controls: [Action] { [Action(id: Tour.skipAction, title: "Skip tour"), Action(id: Tour.nextAction, title: nextTitle)] }
    /// "1/3", read by VoiceOver as "Tip 1 of 3".
    static var counter: String { "\(step.rawValue)/\(tipCount)" }
    static var spokenCounter: String { "Tip \(step.rawValue) of \(tipCount)" }
    private static var tipCount: Int { TourStep.allCases.filter(\.isTip).count }
    /// The last tip's Next ends the tour.
    static var nextTitle: String { step.closing(step) == .done ? "Done" : "Next" }
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

/// Tip 3 (AC7): Blood tests on My data, with the lab upload above the row.
struct BloodTestsTip: TourTip {
    static let step = TourStep.bloodTests
    static let tab = TourTab.data
    static let line = "The more data you add, the more personal your plan. You can upload lab reports to fill these in for you."
    static let actionTitle = "Add a lab report"
    var actions: [Action] { [Action(id: Tour.uploadAction, title: Self.actionTitle)] + Self.controls }
}

extension View {
    /// Anchors one of the tour's tips here (US-57). Its Next, or a tap outside it, moves
    /// the tour on (review R2a), and Next then runs `next`; "Skip tour" ends it; the last
    /// tip's own action goes to `action`, first so a trailing closure binds to it.
    func tourTip<T: TourTip>(_ tip: T, arrowEdge: Edge = .top, action: @escaping @MainActor () -> Void = {},
                             next: @escaping @MainActor () -> Void = {}) -> some View {
        modifier(TourTipAnchor(tip: tip, arrowEdge: arrowEdge, next: next, action: action))
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
    let next: @MainActor () -> Void
    let action: @MainActor () -> Void
    @Environment(\.analytics) private var analytics

    func body(content: Content) -> some View {
        content
            .popoverTip(tip, arrowEdge: arrowEdge) { chosen in
                switch chosen.id {
                case Tour.skipAction: Tour.skipped(T.step, analytics: analytics)
                case Tour.nextAction: closed(); next()
                default: closed(); action()
                }
            }
            // The tip's view leaves when the popover goes for any reason, a tap outside it
            // or leaving its tab included, which TipKit does not report: that counts as
            // closed (review R2a).
            .tipViewStyle(TourTipStyle(gone: closed))
            // Solid, not glass: on glass, dark mode's accent text fell to 2.6:1 where a
            // light patch showed through (measured 2026-10-25). On this it clears 4.5:1.
            .tipBackground(Color(.secondarySystemGroupedBackground))
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

/// A tour tip's look: its one line, tip 3's action as the app's accent button (OnAccent
/// text, US-25 AC17c; TipKit's own drew white on the light dark-mode green, about 2:1),
/// then one row: "Skip tour", the counter, "Next" (Brad 2026-10-25). No x: Next and a tap
/// outside both move on, and Skip tour ends the tour. At accessibility text sizes it
/// scrolls rather than clips (AC11).
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
        let controls = [Tour.skipAction, Tour.nextAction]
        return VStack(alignment: .leading, spacing: 14) {
            configuration.title?
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            ForEach(configuration.actions.filter { !controls.contains($0.id) }) { action in
                Button(action: action.handler) { action.label() }
                    .buttonStyle(.accent)
            }
            if let tip = configuration.tip as? any TourTip,
               let skip = configuration.actions.first(where: { $0.id == Tour.skipAction }),
               let next = configuration.actions.first(where: { $0.id == Tour.nextAction }) {
                TourControls(tip: type(of: tip), skip: skip, next: next)
            }
        }
        .padding(20)
    }
}

/// "Skip tour" on the left, "1/3" centred, "Next" on the right; stacked at accessibility
/// sizes, where one row does not fit. Each button has a 44-point target (review R6); the
/// accent text clears 4.5:1 on the tip in both modes.
private struct TourControls: View {
    let tip: any TourTip.Type
    let skip: Tips.Action
    let next: Tips.Action
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                counter
                button(next, weight: .semibold, alignment: .leading)
                button(skip, weight: .regular, alignment: .leading)
            }
        } else {
            HStack(spacing: 8) {
                button(skip, weight: .regular, alignment: .leading)
                counter
                button(next, weight: .semibold, alignment: .trailing)
            }
        }
    }

    private var counter: some View {
        Text(tip.counter)
            .font(.subheadline.monospacedDigit())
            .accessibilityLabel(tip.spokenCounter)
    }

    /// Plain accent text, not a filled button: the row offers, it does not urge. The
    /// whole half-row (or the whole line, stacked) taps, 44 points tall (review R1).
    private func button(_ action: Tips.Action, weight: Font.Weight, alignment: Alignment) -> some View {
        Button(action: action.handler) {
            action.label()
                .font(.subheadline.weight(weight))
                .frame(maxWidth: .infinity, minHeight: 44, alignment: alignment)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
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
