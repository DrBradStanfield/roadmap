import StoreKit
import UIKit
import SwiftUI

/// The tabs, in the web's mobile order (US-25 AC3): My data, My plan, then Chat (US-52).
/// The app opens on My data. The web twin is widget-src/src/components/BottomTabBar.tsx.
/// Each tab sits in a navigation stack. My plan has a small title, whose bar turns
/// to frosted glass as content scrolls under it; My data has no bar (Brad
/// 2026-10-22, US-25 AC17), and a strip of its background keeps rows from the clock.
struct RootView: View {
    enum Tab: Hashable { case data, plan, chat }

    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync
    let chat: ChatHistoryStore
    @State private var tab = Tab.data
    @State private var reviewPrompt = ReviewPrompt()
    @State private var analytics = Analytics()
    /// The backup offer after the person's third save (US-57 AC8).
    @State private var cloudPrompt = CloudPrompt()
    @State private var offeringCloud = false
    @State private var backingUp = false
    @State private var showSync = false
    /// The app's window: the cloud prompt waits while any sheet is up in it.
    @State private var window: UIWindow?
    @Environment(\.requestReview) private var requestReview
    @Environment(\.scenePhase) private var scenePhase
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(ReminderTaps.self) private var reminderTaps
    @Environment(AppleHealthSync.self) private var health: AppleHealthSync?
    @Environment(LiveHealth.self) private var live: LiveHealth?
    @Environment(DataEraser.self) private var eraser
    /// Set once the welcome screen is done; a setting, not health data.
    @AppStorage("welcomed") private var welcomed = false
    /// Set once the new-user questions are done (US-54); never shown again after.
    @AppStorage("onboarded") private var onboarded = false
    /// Set when the first question screen is reached (OnboardingView).
    @AppStorage("onboardingHealthAsked") private var onboardingStarted = false
    /// Which questions Apple Health answered, by name (US-54 AC3b); forgotten with the run.
    @AppStorage("onboardingFromHealth") private var onboardingFromHealth = ""
    /// The questions began after "I already use Health Roadmap": a relaunch keeps asking
    /// only what the cloud record lacks (Codex re-check R1).
    @AppStorage("onboardingOnlyMissing") private var onlyMissingRun = false
    /// The questions restarted after "Delete all my data": the record keeps the units the
    /// erase kept, so the phone's region never overrides them (Codex R1).
    @AppStorage("onboardingAfterErase") private var afterErase = false
    /// The record's erase count when the questions were last finished: an erase made on
    /// another device raises it through the cloud, and the questions come back (US-54 AC7).
    @AppStorage("onboardedEpoch") private var onboardedEpoch = 0
    /// Whose record that count belongs to: "" for the phone's own, else the cloud provider.
    /// Counts from different records never compare (adversary re-check N1).
    @AppStorage("onboardedSource") private var onboardedSource = ""
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
            titled("My plan") { PlanView(store: store, showMyData: { tab = .data }) }
                .tabItem { Label("My plan", systemImage: "heart.text.square") }
                .tag(Tab.plan)
            // ChatView keeps its own navigation stack and title.
            ChatView(engine: engine, store: store, history: chat)
                .tabItem { Label("Chat", systemImage: "bubble.left.and.text.bubble.right") }
                .tag(Tab.chat)
        }
        .sensoryFeedback(.selection, trigger: tab)
        .onChange(of: tab) { offerCloud() }
        // A tour tip shows only on its own tab (TourTips.swift).
        .onChange(of: tab, initial: true) { Tour.showing(tab == .plan ? .plan : tab == .data ? .data : .other) }
        // Clarity starts only once the whole window is masked (Analytics.swift, D9).
        .background(WindowReader {
            window = $0
            analytics.start(in: $0, on: screenName)
        })
        .onChange(of: screenName, initial: true) { analytics.screen(screenName) }
        // Edit sheets pin the record they opened on (MyData/RecordPin.swift).
        .environment(store)
        .environment(\.analytics, analytics)
        .onAppear { Tour.finished = { Task { await offerCloudSoon() } } }
        .sheet(isPresented: $offeringCloud, onDismiss: cloudPromptClosed) {
            CloudPromptView { backingUp = true }
                .onAppear {
                    // Shown, so never again (AC8); marked only once it is on screen.
                    cloudPrompt.shown()
                    analytics.event(.cloudPromptShown)
                }
        }
        .sheet(isPresented: $showSync) { SyncView(sync: sync) }
        .task(id: store.ownSaves) {
            // The person's own saves after onboarding (AC9). Onboarding's answers are made
            // under its cover; finishOnboarding passes over its last one (review R1).
            guard onboarded, firstRun == nil else { return cloudPrompt.ignoreSaves(upTo: store.ownSaves) }
            cloudPrompt.ownSaves(store.ownSaves)
            // The third own save ends a tour still running, so it never blocks the prompt (R2b).
            if cloudPrompt.endsTour { _ = Tour.end() }
            await offerCloudSoon()
        }
        .fullScreenCover(isPresented: Binding(get: { firstRun != nil }, set: { if !$0 { firstRun = nil } })) {
            firstRunCover
                // The launch screen's colour, so the opening and a relaunch mid-questions never flash (US-25 AC21b).
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemGroupedBackground), ignoresSafeAreaEdges: .all)
        }
        .onAppear(perform: decideFirstRun)
        .onChange(of: eraser.startsOver) { startOver() }
        // An erase from elsewhere; this phone's own waits for its words to be dismissed.
        .onChange(of: shownRecord) { recordChanged() }
        .onChange(of: store.recordJSON) { reviewPrompt.recordChanged() }
        // Reminders refill on launch, on every record change and on return (US-25 AC9).
        .task(id: store.recordJSON) { await reminders.refresh() }
        .onChange(of: scenePhase) {
            guard scenePhase == .active else { return }
            Task { await reminders.refresh() }
            store.redraw() // the plan reads the time (Codex R1)
        }
        // Midnight with the app open: the same redraw.
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged).receive(on: RunLoop.main)) { _ in
            if scenePhase == .active { store.redraw() }
        }
        .onChange(of: reminderTaps.planRequests, initial: true) { if reminderTaps.planRequests > 0 { tab = .plan } }
        .task(id: tab) {
            // A pause first, so the plan is on screen before iOS's rating sheet;
            // leaving the tab during it cancels the ask without using it up.
            guard tab == .plan else { return }
            try? await Task.sleep(for: .seconds(2))
            // Never over the cloud prompt, a tour tip or any sheet (review R7): a later
            // visit asks instead, since planOpened is not used up here.
            guard !Task.isCancelled, !offeringCloud, quiet else { return }
            if reviewPrompt.planOpened() { requestReview() }
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
                OnboardingView(store: store, health: health, onlyMissing: onlyMissing, keepUnits: afterErase, finish: finishOnboarding)
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
        // A US-56 page on My data names only the screen, never the metric (its usage signal).
        case nil: switch tab { case .data: (live?.pagesOpen ?? 0) > 0 ? .appleHealthMetric : .myData; case .plan: .plan; case .chat: .chat }
        }
    }

    /// Which record is on screen and its erase count. The phone's copy shows until a
    /// connected cloud opens, so "open" is part of it.
    private struct ShownRecord: Equatable { var source: String; var open: Bool; var epoch: Int? }

    private var shownRecord: ShownRecord {
        ShownRecord(source: source, open: sync.recordOpen, epoch: store.myData?.eraseEpoch)
    }

    private var source: String { sync.provider?.rawValue ?? "" }

    /// Erased since the count was taken, by this record's own count.
    private var erasedElsewhere: Bool {
        // Not only after the questions: an existing user whose full record skipped them too (Codex re-check R3).
        source == onboardedSource
            && (store.myData.map { OnboardingSteps.erasedSince(onboardedEpoch, epoch: $0.eraseEpoch, profile: $0.profile) } ?? false)
    }

    /// The count for a record the phone has not counted yet (a cloud just connected or
    /// switched; the questions' own state) is taken, not compared. The phone's copy of a
    /// connected cloud never sets it: only the opened cloud record does.
    private func recordChanged() {
        guard decided, firstRun == nil, !eraser.erasing, !eraser.awaitingDismissal else { return }
        if erasedElsewhere { startOver(); return }
        if source != onboardedSource, source.isEmpty || sync.recordOpen { takeCount() }
    }

    private func takeCount() {
        onboardedEpoch = store.myData?.eraseEpoch ?? 0
        onboardedSource = source
    }

    private func decideFirstRun() {
        guard !decided else { return }
        decided = true
        // At launch the cover is simply there, never sliding up over an empty My data
        // (US-25 AC21b, Brad 2026-10-26).
        var now = Transaction()
        now.disablesAnimations = true
        withTransaction(now) {
            // A launch mid-questions resumes them instead (AC7); a skipped user lands in needsQuestions.
            if welcomed, onboarded, erasedElsewhere { startOver(); return }
            firstRun = !welcomed ? .welcome : needsQuestions ? .questions(onlyMissing: onlyMissingRun) : nil
        }
    }

    /// "Delete all my data" empties the record, so the questions come back (US-54 AC7,
    /// Brad 2026-10-22). Not the welcome screen: the person is already in, and a
    /// connected cloud stays connected.
    private func startOver() {
        onboarded = false
        onboardingStarted = false
        onboardingFromHealth = ""
        onlyMissingRun = false
        afterErase = true
        firstRun = .questions(onlyMissing: false)
    }

    private func finishOnboarding() {
        onboarded = true
        onboardingFromHealth = ""
        afterErase = false
        takeCount()
        tab = .plan
        firstRun = nil
        // Onboarding's answers, the last one included, are not the person's own saves (R1).
        cloudPrompt.ignoreSaves(upTo: store.ownSaves)
        // The tour continues on My plan, once ever (US-57 AC1).
        if Tour.start() { analytics.event(.tourStarted) }
    }

    // MARK: Cloud prompt (US-57 AC8)

    /// No sheet, popover or alert is up in the window.
    private var quiet: Bool { window?.rootViewController?.presentedViewController == nil }

    /// Offers the backup when it is due, at a quiet moment: no cover, no sheet up. A pause
    /// first, so the sheet that saved, or the tip that closed, has gone. Nothing waits once
    /// the prompt is spent.
    private func offerCloudSoon() async {
        guard !cloudPrompt.isSpent else { return }
        try? await Task.sleep(for: .seconds(1))
        if !Task.isCancelled { offerCloud() }
    }

    private func offerCloud() {
        guard firstRun == nil, quiet, cloudPrompt.isDue(connected: sync.provider != nil) else { return }
        offeringCloud = true
    }

    /// "Back up" opens Sync once the prompt has gone, so two sheets never overlap.
    private func cloudPromptClosed() {
        analytics.event(backingUp ? .cloudPromptBackUp : .cloudPromptNotNow)
        if backingUp { showSync = true }
        backingUp = false
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
