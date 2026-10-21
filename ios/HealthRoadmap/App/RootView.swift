import StoreKit
import SwiftUI

/// The two tabs, in the web's mobile order (US-25 AC3): My data first, then My plan.
/// The app opens on My data. The web twin is widget-src/src/components/MobileTabBar.tsx.
/// Each tab sits in a navigation stack with a small title: its bar turns to frosted
/// glass as content scrolls under it, so rows never run beneath the clock.
struct RootView: View {
    enum Tab: Hashable { case data, plan }

    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync
    @State private var tab = Tab.data
    @State private var reviewPrompt = ReviewPrompt()
    @Environment(\.requestReview) private var requestReview
    /// Set once the welcome screen is done; a setting, not health data.
    @AppStorage("welcomed") private var welcomed = false

    var body: some View {
        TabView(selection: $tab) {
            titled("My data") { MyDataView(store: store, sync: sync) }
                .tabItem { Label("My data", systemImage: "list.bullet.clipboard") }
                .tag(Tab.data)
            titled("My plan") { PlanView(engine: engine, store: store, sync: sync, showMyData: { tab = .data }) }
                .tabItem { Label("My plan", systemImage: "heart.text.square") }
                .tag(Tab.plan)
        }
        .sensoryFeedback(.selection, trigger: tab)
        .fullScreenCover(isPresented: Binding(get: { !welcomed }, set: { welcomed = !$0 })) {
            WelcomeView { welcomed = true }
        }
        .onChange(of: store.recordJSON) { reviewPrompt.recordChanged() }
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
