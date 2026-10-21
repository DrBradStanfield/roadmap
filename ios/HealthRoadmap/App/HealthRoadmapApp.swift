import SwiftUI
import UIKit

@main
struct HealthRoadmapApp: App {
    @State private var parts = Result { try AppParts() }
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            switch parts {
            case .success(let parts):
                RootView(engine: parts.engine, store: parts.store, sync: parts.sync)
                    .task { await parts.sync.start() }
                    .onChange(of: scenePhase) { _, phase in follow(phase, parts.sync) }
            case .failure(let error):
                ContentUnavailableView("The app could not start", systemImage: "exclamationmark.triangle", description: Text(error.localizedDescription))
            }
        }
    }
}

/// Cloud sync follows the app on and off the screen (US-25 AC11c): it re-reads on
/// return, and saves what waits before iOS suspends the app, asking iOS for the
/// few seconds that save needs.
@MainActor
private func follow(_ phase: ScenePhase, _ sync: CloudSync) {
    switch phase {
    case .active:
        Task { await sync.foreground() }
    case .background:
        let task = UIApplication.shared.beginBackgroundTask(withName: "Save the record")
        Task {
            await sync.background()
            UIApplication.shared.endBackgroundTask(task)
        }
    default:
        break
    }
}

/// The engine, the record and its sync, made once at launch and shared by every tab.
@MainActor
struct AppParts {
    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync

    init() throws {
        engine = try HealthEngine()
        let folder = try RecordStore.appFolder()
        store = try RecordStore(folder: folder, engine: engine, deviceId: RecordStore.deviceId(in: folder))
        sync = CloudSync(engine: engine, store: store, oauth: OAuthClient())
    }
}
