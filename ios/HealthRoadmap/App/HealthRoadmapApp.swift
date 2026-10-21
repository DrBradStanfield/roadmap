import SwiftUI

@main
struct HealthRoadmapApp: App {
    @State private var parts = Result { try AppParts() }

    var body: some Scene {
        WindowGroup {
            switch parts {
            case .success(let parts):
                RootView(engine: parts.engine, store: parts.store)
            case .failure(let error):
                ContentUnavailableView("The app could not start", systemImage: "exclamationmark.triangle", description: Text(error.localizedDescription))
            }
        }
    }
}

/// The engine and the record, made once at launch and shared by every tab.
@MainActor
struct AppParts {
    let engine: HealthEngine
    let store: RecordStore

    init() throws {
        engine = try HealthEngine()
        let folder = try RecordStore.appFolder()
        store = try RecordStore(folder: folder, engine: engine, deviceId: RecordStore.deviceId(in: folder))
    }
}
