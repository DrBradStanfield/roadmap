import SwiftUI
import UIKit
#if canImport(Clarity)
import Clarity
#endif

/// Usage analytics (ios/architecture.md D9, amended 2026-10-22; US-25 AC19): Microsoft
/// Clarity's session replays, taps and rage taps, as the website has, with every screen
/// masked. The whole window is masked BEFORE Clarity starts, so every tab, sheet, cover
/// and alert in it is masked too. Text inputs are masked one by one as well
/// (`analyticsMasked()`), because Clarity's docs say a parent's mask does not force an
/// input's. Screen names are fixed words, never a title that could carry a value. Nothing
/// is ever unmasked; AnalyticsMaskingTests holds all of this. The dashboard's masking
/// mode is Strict as a second layer.
@MainActor
final class Analytics {
    /// The app's own Clarity project (a mobile project, not the website's; Brad created
    /// it 2026-10-22 with Strict masking). A public id, not a secret.
    static let clarityProjectId: String? = "z1kbjvj8u6"

    /// Launch argument the UI tests pass, so their sessions never reach Clarity.
    nonisolated static let uiTestingArgument = "--ui-testing"

    private let sdk: AnalyticsSDK
    private let projectId: String?
    private let testing: Bool
    private(set) var started = false

    init(sdk: AnalyticsSDK = ClarityAnalytics(), projectId: String? = Analytics.clarityProjectId,
         testing: Bool = Analytics.isTesting(environment: ProcessInfo.processInfo.environment, arguments: ProcessInfo.processInfo.arguments)) {
        self.sdk = sdk
        self.projectId = projectId
        self.testing = testing
    }

    /// Masks `window`, then starts Clarity. Once; never under XCTest or the UI tests.
    @discardableResult
    func start(in window: UIWindow, on screen: Screen = .welcome) -> Bool {
        guard !started, let projectId, !projectId.isEmpty, !testing else { return false }
        sdk.mask(window)
        guard sdk.start(projectId: projectId) else { return false }
        started = true
        sdk.screen(screen.rawValue)
        return true
    }

    /// Names the screen in fixed words (US-25 AC19). A no-op until started.
    func screen(_ screen: Screen) {
        if started { sdk.screen(screen.rawValue) }
    }

    /// Sends one of the fixed events (US-57's usage signal). A no-op until started.
    func event(_ event: Event) {
        if started { sdk.event(event.rawValue) }
    }

    /// The only events Clarity ever gets (D9, Brad 2026-10-25): fixed words, never a value
    /// and never a tile's name. AnalyticsMaskingTests pins the list.
    enum Event: String, CaseIterable {
        case tourStarted = "Tour started"
        case tourTipClosed1 = "Tour tip closed 1", tourTipClosed2 = "Tour tip closed 2", tourTipClosed3 = "Tour tip closed 3"
        case tourSkipped1 = "Tour skipped 1", tourSkipped2 = "Tour skipped 2", tourSkipped3 = "Tour skipped 3"
        case tileExplainerOpened = "Tile explainer opened"
        case cloudPromptShown = "Cloud prompt shown", cloudPromptBackUp = "Cloud prompt back up", cloudPromptNotNow = "Cloud prompt not now"

        /// A tour tip closed with its x, or acted on: the tour moved on.
        static func tipClosed(_ step: TourStep) -> Event? {
            switch step {
            case .snapshot: .tourTipClosed1
            case .foundation: .tourTipClosed2
            case .bloodTests: .tourTipClosed3
            case .notStarted, .done: nil
            }
        }

        /// "Skip tour" on a tip.
        static func skipped(_ step: TourStep) -> Event? {
            switch step {
            case .snapshot: .tourSkipped1
            case .foundation: .tourSkipped2
            case .bloodTests: .tourSkipped3
            case .notStarted, .done: nil
            }
        }
    }

    /// The only screen names Clarity ever gets.
    enum Screen: String {
        case welcome = "Welcome", onboarding = "Onboarding", myData = "My data", plan = "My plan", chat = "Chat"
        /// A US-56 metric page: the screen only, never which metric or a value.
        case appleHealthMetric = "Apple Health metric"
    }

    /// Under XCTest, or launched by the UI tests (a separate process without XCTest's variable).
    nonisolated static func isTesting(environment: [String: String], arguments: [String]) -> Bool {
        environment["XCTestConfigurationFilePath"] != nil || arguments.contains(uiTestingArgument)
    }
}

/// The calls the app makes, behind a protocol so the order is tested on a fake.
@MainActor
protocol AnalyticsSDK {
    func mask(_ view: UIView)
    func start(projectId: String) -> Bool
    func screen(_ name: String)
    func event(_ name: String)
}

struct ClarityAnalytics: AnalyticsSDK {
    func mask(_ view: UIView) {
        #if canImport(Clarity)
        ClaritySDK.maskView(view)
        #endif
    }

    func start(projectId: String) -> Bool {
        #if canImport(Clarity)
        ClaritySDK.initialize(config: ClarityConfig(projectId: projectId))
        #else
        false
        #endif
    }

    func screen(_ name: String) {
        #if canImport(Clarity)
        _ = ClaritySDK.setCurrentScreenName(name)
        #endif
    }

    func event(_ name: String) {
        #if canImport(Clarity)
        _ = ClaritySDK.sendCustomEvent(value: name)
        #endif
    }
}

extension EnvironmentValues {
    /// The app's one Analytics, for views that send a fixed event (RootView sets it).
    @Entry var analytics: Analytics? = nil
}

extension View {
    /// Masks a text input for Clarity on its own (US-25 AC19). Every TextField,
    /// TextEditor and SecureField carries it; AnalyticsMaskingTests counts them.
    func analyticsMasked() -> some View {
        #if canImport(Clarity)
        clarityMask()
        #else
        self
        #endif
    }
}

/// Hands over the window a view lands in, once it has one: the window Clarity masks.
struct WindowReader: UIViewRepresentable {
    let found: (UIWindow) -> Void

    func makeUIView(context: Context) -> Probe { Probe(found: found) }
    func updateUIView(_ uiView: Probe, context: Context) {}

    final class Probe: UIView {
        let found: (UIWindow) -> Void

        init(found: @escaping (UIWindow) -> Void) {
            self.found = found
            super.init(frame: .zero)
            isHidden = true
            isUserInteractionEnabled = false
        }

        required init?(coder: NSCoder) { nil }

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window { found(window) }
        }
    }
}
