import SwiftUI
import UserNotifications

@main
struct HealthRoadmapApp: App {
    @State private var parts = Result { try AppParts() }

    var body: some Scene {
        WindowGroup {
            switch parts {
            case .success(let parts):
                RootView(engine: parts.engine, store: parts.store)
                    .environment(parts.reminders).environment(parts.reminderTaps)
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
    let reminders: ReminderScheduler
    let reminderTaps = ReminderTaps()

    init() throws {
        engine = try HealthEngine()
        let folder = try RecordStore.appFolder()
        store = try RecordStore(folder: folder, engine: engine, deviceId: RecordStore.deviceId(in: folder))
        let (engine, store) = (engine, store)
        reminders = ReminderScheduler(center: UNUserNotificationCenter.current(), folder: folder) {
            try engine.reminders(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId)
        }
        // Before launch finishes, so a tap that starts the app still reaches My plan.
        UNUserNotificationCenter.current().delegate = reminderTaps
    }
}
