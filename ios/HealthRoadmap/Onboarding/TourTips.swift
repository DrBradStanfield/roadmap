import SwiftUI
import TipKit

/// The tour's step, kept across launches in TipKit's store (US-57 AC1), which already has the
/// demo record's own folder and the UI tests' fresh start (`TourSetup`). The tips themselves
/// are the app's own popovers, shown by `TourGuide` (docs/gotchas.md 2026-11-27, second entry).
enum Tour {
    /// `TourStep`'s raw value.
    @Parameter static var step: Int = TourStep.notStarted.rawValue
    /// Set when this build starts or moves the tour. A step saved without it is an earlier
    /// build's (TipKit's own tour), which ends at upgrade rather than resuming (owner, review R6).
    @Parameter static var keptByThisBuild: Bool = false

    static var current: TourStep { TourStep(rawValue: step) ?? .done }

    static func keep(_ next: TourStep) {
        step = next.rawValue
        keptByThisBuild = true
    }
}

/// Runs the tour (US-57): holds its one state, keeps its step, and turns what My health's
/// list shows into events. RootView owns it; My health's anchors and list report to it.
@MainActor
@Observable
final class TourGuide {
    private(set) var state: TourState
    /// What the list shows: facts, never a mode (TourState.swift).
    @ObservationIgnored private var sight = TourSight()
    @ObservationIgnored var analytics: Analytics?
    /// Told when a tip ends the tour, closed or skipped: RootView then offers the cloud prompt (review R2c).
    @ObservationIgnored var ended: (() -> Void)?
    /// My health's doors: scroll the list to a step's anchor, and open the lab upload.
    @ObservationIgnored var scroll: ((TourTarget) -> Void)?
    @ObservationIgnored var openLabUpload: (() -> Void)?
    /// A sheet, alert or cover is up in the window (RootView reads it, as its `quiet` does): a
    /// due tip waits, so it is never presented behind one (review R2).
    @ObservationIgnored var presenting: () -> Bool = { false }

    /// Something other than a tour tip is presented over `window`, and not on its way out.
    static func presenting(over window: UIWindow?) -> Bool {
        guard let shown = window?.rootViewController?.presentedViewController else { return false }
        return !shown.isBeingDismissed && shown.modalPresentationStyle != .popover
    }

    /// Writes the step to keep; tests pass their own, as TipKit is never configured under them.
    @ObservationIgnored private let keep: (TourStep) -> Void

    /// `keptHere`: this build saved the step. A tour an earlier build left at a tip ends here, once,
    /// so a phone never scrolls to Blood tests days after the update (owner, review R6); one this
    /// build began and the app lost mid-way resumes at its tip.
    init(step: TourStep = Tour.current, keptHere: Bool = Tour.keptByThisBuild,
         keep: @escaping (TourStep) -> Void = { Tour.keep($0) }) {
        self.keep = keep
        if step.isTip, !keptHere {
            state = .finished
            keep(.done)
        } else {
            state = TourState(step)
        }
    }

    /// After onboarding finishes (AC1). True when this started the tour: once only. A hidden
    /// tour (`--ui-testing`, AC10) never starts, so it never sits due (review R5).
    func start() -> Bool {
        guard TourSetup.presents else { return false }
        let before = state
        send(.started)
        return state != before
    }

    func send(_ event: TourState.Event) {
        let (next, effects) = TourState.transition(state, event)
        let moved = next != state
        guard moved || !effects.isEmpty else { return }
        if next.step != state.step { keep(next.step) }
        state = next
        for effect in effects { run(effect) }
        // Looks again after a scroll is asked for too: an anchor already where the scroll puts it
        // never moves, so no report would come.
        if moved || effects.contains(.bringIntoView(next.step)) { look() }
    }

    private func run(_ effect: TourState.Effect) {
        switch effect {
        case .bringIntoView(let step): if let target = sight.targets[step] { scroll?(target) }
        case .logged(let step, let skipped): if let event = Analytics.Event.tip(step, skipped: skipped) { analytics?.event(event) }
        case .openLabUpload: openLabUpload?()
        case .tourEnded: ended?()
        }
    }

    /// The step due and whether the list is bringing its anchor in, or nil when no tip is due.
    private var due: (step: TourStep, bringing: Bool)? {
        switch state {
        case .waiting(let step): (step, false)
        case .bringing(let step): (step, true)
        default: nil
        }
    }

    /// Sends the due tip's event, if the list has one to give. Hidden tips (AC10) never look.
    private func look(after moment: TourSight.Moment = .moved) {
        guard TourSetup.presents, !presenting(), let due,
              let event = sight.look(due.step, bringing: due.bringing, after: moment) else { return }
        send(event)
    }

    // MARK: What My health's list reports

    func listShown(_ shown: Bool) {
        guard shown != sight.shown else { return }
        sight.shown = shown
        look(after: .returned)
    }

    /// RootView's first-run cover appeared, or has gone.
    func coverUp(_ up: Bool) {
        guard up != sight.coverUp else { return }
        sight.coverUp = up
        look(after: .returned)
    }

    /// The person or iOS scrolls the list, or stops: looks again once it comes to rest.
    func listMoving(_ moving: Bool) {
        guard moving != sight.moving else { return }
        sight.moving = moving
        if !moving { look(after: .stopped) }
    }

    func listBounds(_ bounds: CGRect) {
        if bounds.width != listWidth { listWidth = bounds.width }
        changingSight { $0.bounds = bounds }
    }

    /// My health's list width, which sizes every tip's card (`cardWidth`).
    private(set) var listWidth: CGFloat = 0

    /// A tip card's width: the list's, less the popover's margins, at most 440 points (an iPad
    /// or a wide window). Never the anchor row's: at the largest text size the first row reports
    /// its label's width, and tip 1 drew 280 points wide (measured).
    var cardWidth: CGFloat { listWidth > 0 ? min(listWidth - 32, 440) : 360 }

    /// The list's offset or its limits changed (iOS 18+): a scroll moved it, or rows were
    /// measured. A tip being brought in looks for its arrival.
    func listScrolled(_ scroll: TourScroll) {
        changingSight { $0.scroll = scroll }
    }

    func anchor(_ step: TourStep, at frame: CGRect?) { changingSight { $0.anchors[step] = frame } }

    func targets(_ targets: [TourStep: TourTarget]) {
        guard targets != sight.targets else { return }
        sight.targets = targets
        look(after: .returned)
    }

    /// Looks again when the due anchor comes on screen or leaves it while the list is at rest
    /// (moved without a scroll: a redraw, a text size change), and on every change while the list
    /// brings it in, for its arrival. A finished tour stops keeping frames (the anchors report on
    /// every scroll frame); one not yet started keeps them, as onboarding's end starts it over a list
    /// already drawn.
    private func changingSight(_ change: (inout TourSight) -> Void) {
        guard TourSetup.presents, state != .finished else { return }
        guard let due else { return change(&sight) }
        let before = sight.onScreen(due.step)
        change(&sight)
        if due.bringing || sight.onScreen(due.step) != before { look() }
    }
}

/// One of the tour's three tips: one line, then "Skip tour", its counter and "Next" (Brad
/// 2026-10-25); tip 3 has its own action, the lab upload, above that row.
protocol TourTip {
    static var step: TourStep { get }
    static var line: String { get }
    /// The tip's own action, drawn above the row: tip 3's alone.
    static var actionTitle: String? { get }
}

extension TourTip {
    static var actionTitle: String? { nil }
    /// "1/3", read by VoiceOver as "Tip 1 of 3".
    static var counter: String { "\(step.rawValue)/\(tipCount)" }
    static var spokenCounter: String { "Tip \(step.rawValue) of \(tipCount)" }
    private static var tipCount: Int { TourStep.allCases.filter(\.isTip).count }
    /// The last tip's Next ends the tour.
    static var nextTitle: String { step.next == .done ? "Done" : "Next" }
}

/// Tip 1 (AC4): My health's first row, waist-to-height (US-73 AC11; words Brad's, 2026-11-05).
struct SnapshotTip: TourTip {
    static let step = TourStep.snapshot
    static let line = "Your numbers, grouped by topic. Tap any row for its history and what it means."
}

/// Tip 2 (AC6): the first card in Weight & diabetes (words Brad's, 2026-11-05).
struct FoundationTip: TourTip {
    static let step = TourStep.foundation
    static let line = "Each step comes with the reason and the evidence. Tap a card to read it."
}

/// Tip 3 (AC7): the Blood tests heading, with the lab upload on it.
struct BloodTestsTip: TourTip {
    static let step = TourStep.bloodTests
    static let line = "The more data you add, the more personal your plan. You can upload lab reports to fill these in for you."
    static let actionTitle: String? = "Add a lab report"
}

extension View {
    /// Anchors one of the tour's tips here (US-57): tells the tour where it is, and shows the
    /// tip's popover while the tour shows its step. A tap outside only dismisses the popover,
    /// as every popover does, and counts as closed (review R2a).
    /// `rowTop`: room above it in its row, a scroll to the top aligning the row, not the view.
    func tourTip<T: TourTip>(_ tip: T, rowTop: CGFloat = 0) -> some View { modifier(TourTipAnchor<T>(rowTop: rowTop)) }
}

private struct TourTipAnchor<T: TourTip>: ViewModifier {
    let rowTop: CGFloat
    @Environment(TourGuide.self) private var tour: TourGuide?

    func body(content: Content) -> some View {
        let up = tour?.state == .showing(T.step)
        // A finished tour reads a constant, so no report fires on each scroll frame.
        let running = tour.map { $0.state != .finished } ?? false
        content
            .onGeometryChange(for: CGRect.self) { [rowTop] in
                guard running else { return .null }
                let frame = $0.frame(in: .global)
                return CGRect(x: frame.minX, y: frame.minY - rowTop, width: frame.width, height: frame.height + rowTop)
            } action: { tour?.anchor(T.step, at: $0.isNull ? nil : $0) }
            .onDisappear { tour?.anchor(T.step, at: nil) }
            .popover(isPresented: Binding(get: { up }, set: { if !$0 { tour?.send(.closed(T.step)) } }), arrowEdge: .top) {
                TourTipCard(tip: T.self, width: tour?.cardWidth ?? 360) { tour?.send($0) }
                    // The popover has gone, however it went: the next tip, or the upload, may now show.
                    .onDisappear { tour?.send(.gone(T.step)) }
                    .presentationCompactAdaptation(.popover)
                    // Solid, not glass: on glass, dark mode's accent text fell to 2.6:1 where a
                    // light patch showed through (measured 2026-10-25). On this it clears 4.5:1.
                    .presentationBackground(Color(.secondarySystemGroupedBackground))
            }
    }
}

/// A tour tip's look: its one line, tip 3's action as the app's accent button (OnAccent
/// text, US-25 AC17c), then one row: "Skip tour", the counter, "Next" (Brad 2026-10-25). No
/// x: Next and a tap outside both move on, and Skip tour ends the tour. At accessibility
/// text sizes it scrolls rather than clips (AC11).
private struct TourTipCard: View {
    let tip: any TourTip.Type
    let width: CGFloat
    let send: (TourState.Event) -> Void

    var body: some View {
        ViewThatFits(in: .vertical) {
            card
            ScrollView { card }
                .frame(minHeight: 200, idealHeight: 360)
        }
        .frame(width: width)
    }

    private var card: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text(tip.line)
                .font(.headline)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let title = tip.actionTitle {
                Button(title) { send(.acted(tip.step)) }
                    .buttonStyle(.accent)
            }
            TourControls(tip: tip, skip: { send(.skipped(tip.step)) }, next: { send(.closed(tip.step)) })
        }
        .padding(20)
    }
}

/// "Skip tour" on the left, "1/3" centred, "Next" on the right; stacked at accessibility
/// sizes, where one row does not fit. Each button has a 44-point target (review R6); the
/// accent text clears 4.5:1 on the tip in both modes.
private struct TourControls: View {
    let tip: any TourTip.Type
    let skip: () -> Void
    let next: () -> Void
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if typeSize.isAccessibilitySize {
            VStack(alignment: .leading, spacing: 4) {
                counter
                button(tip.nextTitle, next, weight: .semibold, alignment: .leading)
                button("Skip tour", skip, weight: .regular, alignment: .leading)
            }
        } else {
            HStack(spacing: 8) {
                button("Skip tour", skip, weight: .regular, alignment: .leading)
                counter
                button(tip.nextTitle, next, weight: .semibold, alignment: .trailing)
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
    private func button(_ title: String, _ action: @escaping () -> Void, weight: Font.Weight, alignment: Alignment) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.weight(weight))
                .frame(maxWidth: .infinity, minHeight: 44, alignment: alignment)
                .contentShape(Rectangle())
        }
        .buttonStyle(.borderless)
    }
}

/// TipKit at launch (US-57 AC10), for the tour's kept step. Unit tests never configure it.
/// The UI tests and the App Store screenshots pass `--ui-testing`, which hides the tour;
/// adding `--show-tips` starts from an empty store with the tour on, for a tour UI test.
enum TourSetup {
    static let showTipsArgument = "--show-tips"

    enum Mode: Equatable { case none, hidden, fresh, normal }

    /// False when `--ui-testing` hid the tour: it never scrolls the list or shows a tip.
    @MainActor static var presents = true

    static func mode(environment: [String: String], arguments: [String]) -> Mode {
        if environment["XCTestConfigurationFilePath"] != nil { return .none }
        guard arguments.contains(Analytics.uiTestingArgument) else { return .normal }
        return arguments.contains(showTipsArgument) ? .fresh : .hidden
    }

    @MainActor static func configure(environment: [String: String] = ProcessInfo.processInfo.environment,
                                     arguments: [String] = ProcessInfo.processInfo.arguments) {
        switch mode(environment: environment, arguments: arguments) {
        case .none: return
        case .hidden: presents = false
        case .fresh:
            #if DEBUG
            // A demo record never resets the phone's own tips' store (its own is set below).
            if DemoRecord.isOn { break }
            #endif
            try? Tips.resetDatastore()
        case .normal: break
        }
        #if DEBUG
        // A demo record keeps its tips' store in its own folder: the phone's tour is never marked seen.
        if DemoRecord.isOn, let folder = try? DemoRecord.recordFolder() {
            try? Tips.configure([.datastoreLocation(.url(folder.appending(path: "Tips")))])
            return
        }
        #endif
        try? Tips.configure()
    }
}
