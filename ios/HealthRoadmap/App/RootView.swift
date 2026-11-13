import StoreKit
import UIKit
import SwiftUI

/// The two tabs (US-73 AC1): My health, which the app opens on, then Chat (US-52). The web
/// twin is widget-src/src/components/BottomTabBar.tsx. Each tab sits in a navigation stack;
/// My health has no bar (Brad 2026-10-22, US-25 AC17), and a strip of its background keeps
/// rows from the clock.
struct RootView: View {
    enum Tab: Hashable { case health, chat }

    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync
    let chat: ChatHistoryStore
    @State private var tab = Tab.health
    @State private var reviewPrompt = ReviewPrompt()
    /// A plan card has come on screen on My health: the review prompt waits for it (US-25 AC10).
    @State private var planShowing = false
    @State private var analytics = Analytics()
    /// The backup offer after the person's third save (US-57 AC8).
    @State private var cloudPrompt = CloudPrompt()
    @State private var offer = Offer.idle
    /// Each ask for the backup offer bumps it: one wait, which a newer ask restarts (S16).
    @State private var offerAsks = 0
    /// The app's window: the cloud prompt waits while any sheet is up in it.
    @State private var window: UIWindow?
    @Environment(\.requestReview) private var requestReview
    @Environment(\.scenePhase) private var scenePhase
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(ReminderTaps.self) private var reminderTaps
    @Environment(AppleHealthSync.self) private var health: AppleHealthSync?
    @Environment(LiveHealth.self) private var live: LiveHealth?
    @Environment(DataEraser.self) private var eraser
    /// The first run's keys, written only through `send` (FirstRun.swift).
    private let keys = FirstRunKeys()
    /// The record's erase count when the questions were last finished: an erase made on
    /// another device raises it through the cloud, and the questions come back (US-54 AC7).
    @AppStorage("onboardedEpoch") private var onboardedEpoch = 0
    /// Whose record that count belongs to: "" for the phone's own, else the cloud provider.
    /// Counts from different records never compare (adversary re-check N1).
    @AppStorage("onboardedSource") private var onboardedSource = ""
    /// What covers the tabs on a first run (FirstRun.swift).
    @State private var cover = Cover.deciding

    var body: some View {
        TabView(selection: $tab) {
            NavigationStack { MyDataView(engine: engine, store: store, sync: sync, planShown: { if !planShowing { planShowing = true } },
                                         settingsClosed: settingsClosed).firmTopEdge() }
                .tabItem { Label("My health", systemImage: "heart.text.square") }
                .tag(Tab.health)
            // ChatView keeps its own navigation stack and title.
            ChatView(engine: engine, store: store, history: chat)
                .tabItem { Label("Chat", systemImage: "bubble.left.and.text.bubble.right") }
                .tag(Tab.chat)
        }
        .sensoryFeedback(.selection, trigger: tab)
        .onChange(of: tab) { offerCloud() }
        // A tour tip shows only on its own tab (TourTips.swift).
        .onChange(of: tab, initial: true) { Tour.showing(tab == .health ? .health : .other) }
        // Clarity starts only once the whole window is masked (Analytics.swift, D9).
        .background(WindowReader {
            window = $0
            analytics.start(in: $0, on: screenName)
        })
        .onChange(of: screenName, initial: true) { analytics.screen(screenName) }
        // Edit sheets pin the record they opened on (MyData/RecordPin.swift).
        .environment(store)
        .environment(\.analytics, analytics)
        .onAppear {
            Tour.finished = { offerAsks += 1 }
            health?.analytics = analytics
        }
        // Back up closes the prompt by leaving `prompting`; Sync opens once it has gone (onDismiss).
        // Each sheet's onDismiss looks at the record again: an erase that closed it (S48).
        .sheet(isPresented: Binding(get: { offer.prompting }, set: { if !$0 { send(.promptClosed) } }), onDismiss: { send(.promptClosed); recordChanged() }) {
            CloudPromptView { send(.backUpTapped) }
                .onAppear {
                    // Shown, so never again (AC8); marked only once it is on screen.
                    cloudPrompt.shown()
                    analytics.event(.cloudPromptShown)
                }
        }
        .sheet(isPresented: Binding(get: { offer == .sync }, set: { if !$0 { send(.syncClosed) } }), onDismiss: recordChanged) { SyncView(sync: sync) }
        .task(id: store.ownSaves) {
            // The person's own saves after onboarding (AC9). Onboarding's answers are made
            // under its cover; finishing passes over its last one (review R1).
            guard keys.onboarded, !cover.shown else { return cloudPrompt.ignoreSaves(upTo: store.ownSaves) }
            cloudPrompt.ownSaves(store.ownSaves)
            // The third own save ends a tour still running, so it never blocks the prompt (R2b).
            if cloudPrompt.endsTour { _ = Tour.end() }
            offerAsks += 1
        }
        // The one wait before the offer, so the sheet that saved, or the tip that closed, has
        // gone. A newer ask restarts it; nothing waits once the prompt is spent.
        .task(id: offerAsks) {
            guard offerAsks > 0, !cloudPrompt.isSpent else { return }
            try? await Task.sleep(for: .seconds(1))
            if !Task.isCancelled { offerCloud() }
        }
        // Nothing inside the cover dismisses it: only `send` moves it.
        .fullScreenCover(isPresented: Binding(get: { cover.shown }, set: { _ in })) {
            firstRunCover
                // The launch screen's colour, so the opening and a relaunch mid-questions never flash (US-25 AC21b).
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(Color(.systemGroupedBackground), ignoresSafeAreaEdges: .all)
        }
        .onAppear(perform: decideFirstRun)
        .onChange(of: eraser.startsOver) { send(.erased) }
        // An erase from elsewhere that landed while this phone's own held it (US-25 AC16d).
        .onChange(of: eraser.holdLifts) { recordChanged() }
        // Erase words the Settings sheet closed on before they were seen (US-25 AC16d).
        .alert(EraseText.title, isPresented: Binding(get: { eraser.held != nil }, set: { if !$0 { eraser.seen() } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(eraser.held?.words ?? "")
        }
        // An erase from elsewhere; this phone's own waits for its words to be dismissed.
        // Another record's erase epoch never stands in for this one's (S41): any change to
        // ShownRecord, the drawn epoch included, is a switch for the reminders.
        .onChange(of: shownRecord) { reminders.recordSourceChanged(); recordChanged() }
        .onChange(of: store.readable?.json) { reviewPrompt.recordChanged() }
        // Reminders refill on launch, on every record change and on return (US-25 AC9).
        .task(id: store.readable?.json) { await reminders.refresh() }
        .onChange(of: scenePhase) {
            guard scenePhase == .active else { return }
            Task { await reminders.refresh() }
            store.redraw() // the plan reads the time (Codex R1)
        }
        // Midnight with the app open: the same redraw.
        .onReceive(NotificationCenter.default.publisher(for: .NSCalendarDayChanged).receive(on: RunLoop.main)) { _ in
            if scenePhase == .active { store.redraw() }
        }
        .onChange(of: reminderTaps.planRequests, initial: true) { if reminderTaps.planRequests > 0 { tab = .health } }
        .task(id: ReviewMoment(tab: tab, planShowing: planShowing)) {
            // Only once a plan card is on screen (US-25 AC10), and a pause first, so the plan is
            // read before iOS's rating sheet; leaving the tab during it cancels the ask without using it up.
            guard tab == .health, planShowing else { return }
            try? await Task.sleep(for: .seconds(2))
            // Never over the cloud prompt, a tour tip or any sheet (review R7): a later
            // visit asks instead, since planOpened is not used up here.
            guard !Task.isCancelled, offer == .idle, quiet else { return }
            if reviewPrompt.planOpened() { requestReview() }
        }
    }

    // MARK: First run (US-25 AC10, US-54)

    /// The welcome screen, then the new-user questions, in one cover.
    @ViewBuilder private var firstRunCover: some View {
        switch cover {
        case .welcome:
            WelcomeView(sync: sync) {
                send(.started(needs: needsQuestions))
            } connected: {
                send(.connected(needs: needsQuestions))
            }
        case .questions(let run):
            if let health {
                OnboardingView(store: store, health: health, onlyMissing: run == .onlyMissing, keepUnits: run == .afterErase) { send(.finished) }
            } else {
                // Never strand a cover with nothing on it (review R13).
                Color.clear.onAppear { send(.finished) }
            }
        case .deciding, .none:
            EmptyView()
        }
    }

    /// nil while the record is unread: the cover closes unfinished, so the next launch decides (S42).
    private var needsQuestions: Bool? { keys.needsQuestions(needsFlow: needsFlow) }

    private var needsFlow: Bool? { store.myData.map { OnboardingSteps.needsFlow($0.profile) } }

    /// Clarity's screen name, in fixed words (US-25 AC19).
    private var screenName: Analytics.Screen {
        switch cover {
        case .welcome: .welcome
        case .questions: .onboarding
        // A US-56 page names only the screen, never the metric (its usage signal). D9's words (Brad 2026-11-05).
        case .deciding, .none: switch tab { case .health: (live?.pagesOpen ?? 0) > 0 ? .appleHealthMetric : .myHealth; case .chat: .chat }
        }
    }

    private var shownRecord: ShownRecord {
        ShownRecord(source: source, open: sync.recordOpen, store: store)
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
    /// An erase from elsewhere closes the backup prompt or Sync sheet first (S48): their onDismiss
    /// calls this again, and the questions rise once the sheet has gone.
    private func recordChanged() {
        let uncounted = source != onboardedSource && countable
        switch Cover.onRecordChange(cover: cover, offer: offer, holding: eraser.holdsRemoteErases, erasedElsewhere: erasedElsewhere, uncounted: uncounted) {
        case .erase?: send(.erased)
        // From any offer, these two land idle: the prompt closes (to Sync after Back up), then Sync.
        case .closeOffer?: send(.promptClosed); send(.syncClosed)
        case .takeCount?: takeCount()
        case nil: break
        }
    }

    private var countable: Bool { Cover.countable(source: source, open: sync.recordOpen) }

    /// finished() calls it too: a finish before a connected cloud opens takes nothing (S43).
    private func takeCount() {
        guard countable, let data = store.myData else { return }
        (onboardedEpoch, onboardedSource) = (data.eraseEpoch ?? 0, source)
    }

    private func decideFirstRun() {
        // At launch the cover is simply there, never sliding up over an empty My health
        // (US-25 AC21b, Brad 2026-10-26). Only the first launched event decides.
        var now = Transaction()
        now.disablesAnimations = true
        withTransaction(now) { send(.launched(keys.launch(needsFlow: needsFlow, erasedElsewhere: erasedElsewhere))) }
    }

    /// Moves the cover by `event`, writes its keys, and runs the effect it names. "Delete all my
    /// data" empties the record, so the questions come back (US-54 AC7, Brad 2026-10-22): the
    /// keys say so (startOver), nothing more.
    private func send(_ event: Cover.Event) {
        let (next, effect) = Cover.transition(cover, event)
        keys.persist(next, effect)
        cover = next
        if effect == .finish { finished() }
    }

    /// The questions are done, once (S9).
    private func finished() {
        takeCount()
        tab = .health
        // Onboarding's answers, the last one included, are not the person's own saves (R1).
        cloudPrompt.ignoreSaves(upTo: store.ownSaves)
        // The tour continues on My health, once ever (US-57 AC1).
        if Tour.start() { analytics.event(.tourStarted) }
    }

    /// What the review prompt's wait restarts on: the tab, and a plan coming on screen.
    private struct ReviewMoment: Hashable { let tab: Tab; let planShowing: Bool }

    // MARK: Cloud prompt (US-57 AC8)

    /// No sheet, popover or alert is up in the window.
    private var quiet: Bool { window?.rootViewController?.presentedViewController == nil }

    /// Settings closed: any erase words left unseen show here, then a due backup offer (US-57 AC8).
    private func settingsClosed() {
        eraser.settingsClosed()
        offerAsks += 1
    }

    /// Offers the backup when it is due, at a quiet moment: no cover, no sheet up.
    private func offerCloud() {
        guard !cover.shown, quiet, cloudPrompt.isDue(connected: sync.provider != nil) else { return }
        send(.due)
    }

    /// Moves the offer by `event`; the prompt's closing is counted once, by its answer.
    private func send(_ event: Offer.Event) {
        if event == .promptClosed, case .offering(let backUp) = offer {
            analytics.event(backUp ? .cloudPromptBackUp : .cloudPromptNotNow)
        }
        offer = Offer.transition(offer, event)
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
