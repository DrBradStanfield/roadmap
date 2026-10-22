import StoreKit
import SwiftUI

/// The tabs, in the web's mobile order (US-25 AC3): My data, My plan, then Chat (US-52).
/// The app opens on My data. The web twin is widget-src/src/components/MobileTabBar.tsx.
/// Each tab sits in a navigation stack. My plan has a small title, whose bar turns
/// to frosted glass as content scrolls under it; My data has no bar (Brad
/// 2026-10-22, US-25 AC17), and a strip of its background keeps rows from the clock.
struct RootView: View {
    enum Tab: Hashable { case data, plan, chat }

    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync
    @State private var tab = Tab.data
    @State private var reviewPrompt = ReviewPrompt()
    @State private var analytics = Analytics()
    @Environment(\.requestReview) private var requestReview
    @Environment(\.scenePhase) private var scenePhase
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(ReminderTaps.self) private var reminderTaps
    @Environment(AppleHealthSync.self) private var health: AppleHealthSync?
    /// Set once the welcome screen is done; a setting, not health data.
    @AppStorage("welcomed") private var welcomed = false
    /// Set once the new-user questions are done (US-54); never shown again after.
    @AppStorage("onboarded") private var onboarded = false
    /// Set when the first question screen is reached (OnboardingView).
    @AppStorage("onboardingHealthAsked") private var onboardingStarted = false
    /// The questions began after "I already use Health Roadmap": a relaunch keeps asking
    /// only what the cloud record lacks (Codex re-check R1).
    @AppStorage("onboardingOnlyMissing") private var onlyMissingRun = false
    /// What covers the tabs on a first run, decided once at launch, so the cover
    /// stays until the person finishes even as answers fill the record.
    @State private var firstRun: FirstRun?
    @State private var decided = false

    enum FirstRun: Equatable { case welcome, questions(onlyMissing: Bool) }

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { MyDataView(engine: engine, store: store, sync: sync).firmTopEdge() }
                .tabItem { Label("My data", systemImage: "list.bullet.clipboard") }
                .tag(Tab.data)
            titled("My plan") { PlanView(engine: engine, store: store, showMyData: { tab = .data }) }
                .tabItem { Label("My plan", systemImage: "heart.text.square") }
                .tag(Tab.plan)
            // ChatView keeps its own navigation stack and title.
            ChatView(engine: engine, store: store)
                .tabItem { Label("Chat", systemImage: "bubble.left.and.text.bubble.right") }
                .tag(Tab.chat)
        }
        .sensoryFeedback(.selection, trigger: tab)
        // Clarity starts only once the whole window is masked (Analytics.swift, D9).
        .background(WindowReader { analytics.start(in: $0, on: screenName) })
        .onChange(of: screenName, initial: true) { analytics.screen(screenName) }
        // Edit sheets pin the record they opened on (MyData/RecordPin.swift).
        .environment(store)
        .fullScreenCover(isPresented: Binding(get: { firstRun != nil }, set: { if !$0 { firstRun = nil } })) {
            firstRunCover
        }
        .onAppear(perform: decideFirstRun)
        .onChange(of: store.recordJSON) { reviewPrompt.recordChanged() }
        // Reminders refill on launch, on every record change and on return (US-25 AC9).
        .task(id: store.recordJSON) { await reminders.refresh() }
        .onChange(of: scenePhase) { if scenePhase == .active { Task { await reminders.refresh() } } }
        .onChange(of: reminderTaps.planRequests, initial: true) { if reminderTaps.planRequests > 0 { tab = .plan } }
        .task(id: tab) {
            // A pause first, so the plan is on screen before iOS's rating sheet;
            // leaving the tab during it cancels the ask without using it up.
            guard tab == .plan else { return }
            try? await Task.sleep(for: .seconds(2))
            if !Task.isCancelled, reviewPrompt.planOpened() { requestReview() }
        }
    }

    // MARK: First run (US-25 AC10, US-54)

    /// The welcome screen, then the new-user questions, in one cover.
    @ViewBuilder private var firstRunCover: some View {
        switch firstRun {
        case .welcome:
            WelcomeView(sync: sync) {
                welcomed = true
                firstRun = needsQuestions ? .questions(onlyMissing: false) : nil
            } connected: {
                welcomed = true
                onlyMissingRun = true
                if needsQuestions { firstRun = .questions(onlyMissing: true) } else { finishOnboarding() }
            }
        case .questions(let onlyMissing):
            if let health {
                OnboardingView(store: store, health: health, onlyMissing: onlyMissing, finish: finishOnboarding)
            } else {
                // Never strand a cover with nothing on it (review R13).
                Color.clear.onAppear(perform: finishOnboarding)
            }
        case nil:
            EmptyView()
        }
    }

    /// A phone that has not finished the questions, with a record that lacks sex, birth year
    /// or height, or one that started them (quit at weight resumes there; review R2, AC7).
    private var needsQuestions: Bool {
        !onboarded && (onboardingStarted || (store.myData.map { OnboardingSteps.needsFlow($0.profile) } ?? false))
    }

    /// Clarity's screen name, in fixed words (US-25 AC19).
    private var screenName: Analytics.Screen {
        switch firstRun {
        case .welcome: .welcome
        case .questions: .onboarding
        case nil: switch tab { case .data: .myData; case .plan: .plan; case .chat: .chat }
        }
    }

    private func decideFirstRun() {
        guard !decided else { return }
        decided = true
        firstRun = !welcomed ? .welcome : needsQuestions ? .questions(onlyMissing: onlyMissingRun) : nil
    }

    private func finishOnboarding() {
        onboarded = true
        tab = .plan
        firstRun = nil
    }

    private func titled(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
        NavigationStack {
            content()
                .navigationTitle(title)
                .navigationBarTitleDisplayMode(.inline)
                .firmTopEdge()
        }
    }
}

private extension View {
    /// iOS 26 fades scrolled content softly under the bar, which leaves faint rows
    /// behind the clock. The hard edge hides them. Earlier versions draw a solid bar.
    @ViewBuilder func firmTopEdge() -> some View {
        if #available(iOS 26, *) {
            scrollEdgeEffectStyle(.hard, for: .top)
        } else {
            self
        }
    }
}
