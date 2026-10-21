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
        store = try RecordStore(folder: RecordStore.appFolder(), engine: engine, deviceId: Self.deviceId())
    }

    /// This install's id, stamped on what it writes so a merge can tell devices apart.
    private static func deviceId() -> String {
        let key = "deviceId"
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = "ios-" + UUID().uuidString.lowercased()
        UserDefaults.standard.set(id, forKey: key)
        return id
    }
}
