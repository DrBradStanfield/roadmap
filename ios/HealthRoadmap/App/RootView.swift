import SwiftUI

/// The two tabs, in the web's mobile order (US-25 AC3): My data first, then My plan.
/// The app opens on My data. The web twin is widget-src/src/components/MobileTabBar.tsx.
struct RootView: View {
    enum Tab: Hashable { case data, plan }

    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync
    @State private var tab = Tab.data

    var body: some View {
        TabView(selection: $tab) {
            MyDataView(store: store, sync: sync)
                .tabItem { Label("My data", systemImage: "list.bullet.clipboard") }
                .tag(Tab.data)
            PlanView(engine: engine, store: store, sync: sync, showMyData: { tab = .data })
                .tabItem { Label("My plan", systemImage: "heart.text.square") }
                .tag(Tab.plan)
        }
        .sensoryFeedback(.selection, trigger: tab)
    }
}
