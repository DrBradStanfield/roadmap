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
        guard tip == self, self != .notStarted, self != .done else { return self }
        return TourStep(rawValue: rawValue + 1) ?? .done
    }

    /// "Skip tour" (AC3) and the last tip's action (AC7) end it.
    func skipped() -> TourStep { self == .notStarted ? self : .done }
}

/// The tour's state, held in TipKit's store.
enum Tour {
    /// `TourStep`'s raw value; TipKit's rules compare plain values.
    @Parameter static var step: Int = TourStep.notStarted.rawValue

    static var current: TourStep { TourStep(rawValue: step) ?? .done }

    @MainActor static func start() { step = current.started().rawValue }

    @MainActor static func close(_ tip: TourStep) { step = current.closing(tip).rawValue }

    @MainActor static func skip() {
        step = current.skipped().rawValue
        SnapshotTip().invalidate(reason: .actionPerformed)
        FoundationTip().invalidate(reason: .actionPerformed)
        BloodTestsTip().invalidate(reason: .actionPerformed)
    }

    static let skipAction = "skip"
    static let uploadAction = "upload"
}

/// Tip 1 (AC4): the summary tiles at the top of My plan.
struct SnapshotTip: Tip {
    var title: Text { Text("Your numbers at a glance") }
    var message: Text? { Text("BMI, ideal weight, daily protein. Tap any tile to see what it means.") }
    var actions: [Action] { [Action(id: Tour.skipAction, title: "Skip tour")] }
    var rules: [Rule] {
        let mine = TourStep.snapshot.rawValue
        return [#Rule(Tour.$step) { $0 == mine }]
    }
}

/// Tip 2 (AC6): the first card of the Foundation section.
struct FoundationTip: Tip {
    var title: Text { Text("Why each step is here") }
    var message: Text? { Text("Each step comes with the reason and the evidence. Tap a step to read them.") }
    var actions: [Action] { [Action(id: Tour.skipAction, title: "Skip tour")] }
    var rules: [Rule] {
        let mine = TourStep.foundation.rawValue
        return [#Rule(Tour.$step) { $0 == mine }]
    }
}

/// Tip 3 (AC7): Blood tests on My data, with the lab upload.
struct BloodTestsTip: Tip {
    var title: Text { Text("Add your blood tests") }
    var message: Text? { Text("The more you add, the more personal your plan. A lab report fills these in.") }
    var actions: [Action] { [Action(id: Tour.uploadAction, title: "Add a lab report")] }
    var rules: [Rule] {
        let mine = TourStep.bloodTests.rawValue
        return [#Rule(Tour.$step) { $0 == mine }]
    }
}

extension View {
    /// Anchors one of the tour's tips here (US-57). Closing it moves the tour on;
    /// "Skip tour" ends it; any other action goes to `action`, then ends the tour
    /// (only the last tip has one).
    func tourTip<T: Tip>(_ tip: T, step: TourStep, arrowEdge: Edge = .top, action: @escaping @MainActor (String) -> Void = { _ in }) -> some View {
        popoverTip(tip, arrowEdge: arrowEdge) { chosen in
            if chosen.id != Tour.skipAction { action(chosen.id) }
            Tour.skip()
        }
        .task {
            // The x, or a popover swiped away, invalidates the tip: move on.
            for await status in tip.statusUpdates {
                if case .invalidated = status { Tour.close(step) }
            }
        }
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
