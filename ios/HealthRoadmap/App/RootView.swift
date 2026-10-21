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
    @Environment(\.requestReview) private var requestReview
    @Environment(\.scenePhase) private var scenePhase
    @Environment(ReminderScheduler.self) private var reminders
    @Environment(ReminderTaps.self) private var reminderTaps
    /// Set once the welcome screen is done; a setting, not health data.
    @AppStorage("welcomed") private var welcomed = false

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
        // Edit sheets pin the record they opened on (MyData/RecordPin.swift).
        .environment(store)
        .fullScreenCover(isPresented: Binding(get: { !welcomed }, set: { welcomed = !$0 })) {
            WelcomeView { welcomed = true }
        }
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
