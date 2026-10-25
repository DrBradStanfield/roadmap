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

    /// "Skip tour" (AC3) ends it.
    func skipped() -> TourStep { self == .notStarted ? self : .done }

    /// One of the three tips, not before or after the tour.
    var isTip: Bool { self != .notStarted && self != .done }
}

/// The tour's state, held in TipKit's store.
enum Tour {
    /// `TourStep`'s raw value; TipKit's rules compare plain values.
    @Parameter static var step: Int = TourStep.notStarted.rawValue

    static var current: TourStep { TourStep(rawValue: step) ?? .done }

    /// A tip is still due: the cloud prompt waits (AC8).
    static var running: Bool { current.isTip }

    /// True when this started the tour.
    @MainActor static func start() -> Bool {
        let next = current.started()
        defer { step = next.rawValue }
        return next != current
    }

    /// True when closing `tip` moved the tour on; a late or repeated close is false.
    @MainActor static func close(_ tip: TourStep) -> Bool {
        let next = current.closing(tip)
        defer { step = next.rawValue }
        return next != current
    }

    @MainActor static func skip() {
        step = current.skipped().rawValue
        SnapshotTip().invalidate(reason: .actionPerformed)
        FoundationTip().invalidate(reason: .actionPerformed)
        BloodTestsTip().invalidate(reason: .actionPerformed)
    }

    static let skipAction = "skip"
    static let uploadAction = "upload"
}

/// Tip 1 (AC4): the whole row of summary tiles at the top of My plan, one tip.
struct SnapshotTip: Tip {
    static let line = "A snapshot of your health. Tap any tile to learn more."
    var title: Text { Text(Self.line) }
    var actions: [Action] { [Action(id: Tour.skipAction, title: "Skip tour")] }
    var rules: [Rule] {
        let mine = TourStep.snapshot.rawValue
        return [#Rule(Tour.$step) { $0 == mine }]
    }
}

/// Tip 2 (AC6): the first card of the Foundation section.
struct FoundationTip: Tip {
    static let line = "Start here. Each step comes with the reason and the evidence."
    var title: Text { Text(Self.line) }
    var actions: [Action] { [Action(id: Tour.skipAction, title: "Skip tour")] }
    var rules: [Rule] {
        let mine = TourStep.foundation.rawValue
        return [#Rule(Tour.$step) { $0 == mine }]
    }
}

/// Tip 3 (AC7): Blood tests on My data, with the lab upload.
struct BloodTestsTip: Tip {
    static let line = "The more you add, the more personal your plan. A lab report fills these in for you."
    static let actionTitle = "Add a lab report"
    var title: Text { Text(Self.line) }
    var actions: [Action] { [Action(id: Tour.uploadAction, title: Self.actionTitle)] }
    var rules: [Rule] {
        let mine = TourStep.bloodTests.rawValue
        return [#Rule(Tour.$step) { $0 == mine }]
    }
}

extension View {
    /// Anchors one of the tour's tips here (US-57). Its x moves the tour on; "Skip tour"
    /// ends it; the last tip's action goes to `action` and finishes the tour.
    func tourTip(_ tip: some Tip, step: TourStep, arrowEdge: Edge = .top, action: @escaping @MainActor () -> Void = {}) -> some View {
        modifier(TourTipAnchor(tip: tip, step: step, arrowEdge: arrowEdge, action: action))
    }
}

private struct TourTipAnchor<T: Tip>: ViewModifier {
    let tip: T
    let step: TourStep
    let arrowEdge: Edge
    let action: @MainActor () -> Void
    @Environment(\.analytics) private var analytics

    func body(content: Content) -> some View {
        content
            .popoverTip(tip, arrowEdge: arrowEdge) { chosen in
                if chosen.id == Tour.skipAction {
                    if let event = Analytics.Event.skipped(step) { analytics?.event(event) }
                    Tour.skip()
                } else {
                    closed()
                    tip.invalidate(reason: .actionPerformed)
                    action()
                }
            }
            .tipViewStyle(TourTipStyle())
            .task {
                // The x, or the popover swiped away, invalidates the tip: move on.
                for await status in tip.statusUpdates {
                    if case .invalidated = status { closed() }
                }
            }
    }

    private func closed() {
        if Tour.close(step), let event = Analytics.Event.tipClosed(step) { analytics?.event(event) }
    }
}

/// A tour tip's look: its one line, its x, "Skip tour" as plain text, and tip 3's action
/// as the app's own accent button, whose label is OnAccent (US-25 AC17c): TipKit's own
/// drew white on the light dark-mode green, about 2:1.
private struct TourTipStyle: TipViewStyle {
    func makeBody(configuration: Configuration) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .top, spacing: 12) {
                configuration.title?
                    .font(.headline)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button { configuration.tip.invalidate(reason: .tipClosed) } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.title2)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                // A 44-point target around the small symbol.
                .frame(width: 44, height: 44)
                .padding(-10)
                .accessibilityLabel("Close")
            }
            ForEach(configuration.actions) { action in
                if action.id == Tour.skipAction {
                    // Skipping is offered, not urged: a plain text button.
                    Button(action: action.handler) { action.label().font(.subheadline.weight(.semibold)) }
                        .buttonStyle(.borderless)
                } else {
                    Button(action: action.handler) {
                        action.label().font(.headline).frame(maxWidth: .infinity).padding(.vertical, 6).onAccentLabel()
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
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
