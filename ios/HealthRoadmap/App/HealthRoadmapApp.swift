import SwiftUI
import UIKit
import UserNotifications

@main
struct HealthRoadmapApp: App {
    @State private var parts = Result { try AppParts() }
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            switch parts {
            case .success(let parts):
                RootView(engine: parts.engine, store: parts.store, sync: parts.sync)
                    .environment(parts.reminders).environment(parts.reminderTaps).environment(parts.health).environment(parts.eraser)
                    .task { await parts.sync.start() }
                    .onChange(of: scenePhase) { _, phase in follow(phase, parts.sync, parts.updater) }
            case .failure(let error):
                ContentUnavailableView("The app could not start", systemImage: "exclamationmark.triangle", description: Text(error.localizedDescription))
            }
        }
    }
}

/// Cloud sync follows the app on and off the screen (US-25 AC11c): it re-reads on
/// return, and saves what waits before iOS suspends the app, asking iOS for the
/// few seconds that save needs. Coming on screen (launch included) also looks for
/// a newer engine, at most once in 6 hours (US-25 AC18).
@MainActor
private func follow(_ phase: ScenePhase, _ sync: CloudSync, _ updater: EngineUpdater?) {
    switch phase {
    case .active:
        Task { await sync.foreground() }
        Task { await updater?.checkIfDue() }
    case .background:
        let task = BackgroundTask()
        Task {
            await sync.background()
            task.end()
        }
    default:
        break
    }
}

/// iOS's few seconds to finish a save after the app leaves the screen. If they run
/// out first, iOS calls the expiration handler, which must end the task or iOS
/// kills the app. Nothing is lost then: the edit is on the phone, marked pending,
/// and the next open sends it (review A7).
@MainActor
private final class BackgroundTask {
    private var id = UIBackgroundTaskIdentifier.invalid

    init() {
        id = UIApplication.shared.beginBackgroundTask(withName: "Save the record") { [weak self] in
            MainActor.assumeIsolated { self?.end() }
        }
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}

/// The engine, the record and its sync, made once at launch and shared by every tab.
@MainActor
struct AppParts {
    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync
    let reminders: ReminderScheduler
    let reminderTaps = ReminderTaps()
    /// Apple Health in and out (ios/architecture.md D6). Started at launch, so its
    /// observers are in place when iOS wakes the app for new Health data.
    let health: AppleHealthSync
    let eraser: DataEraser
    /// Over-the-air engine updates (US-25 AC18); nil if their folder cannot be made.
    let updater: EngineUpdater?

    init() throws {
        // The newest verified downloaded engine, or the bundled one (ios/architecture.md D3).
        // A background launch (a Health delivery) never tries a new engine.
        let bundled = try BundledEngine()
        let engineFolder = try? EngineFolder.live()
        let foreground = UIApplication.shared.applicationState != .background
        engine = try EngineBoot(folder: engineFolder, bundled: bundled, foreground: foreground).start().engine
        updater = engineFolder.map { EngineUpdater(folder: $0, bundled: bundled.facts) }
        let folder = try RecordStore.appFolder()
        store = try RecordStore(folder: folder, engine: engine, deviceId: RecordStore.deviceId(in: folder))
        sync = CloudSync(engine: engine, store: store, oauth: OAuthClient())
        let (engine, store) = (engine, store)
        reminders = ReminderScheduler(center: UNUserNotificationCenter.current(), folder: folder) {
            try await engine.reminders(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId)
        }
        // Before launch finishes, so a tap that starts the app still reaches My plan.
        UNUserNotificationCenter.current().delegate = reminderTaps
        let sync = self.sync
        health = AppleHealthSync(store: store, engine: engine, client: HealthKitClient()) { await sync.syncNow() }
        health.start()
        let chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: store.deviceId)
        eraser = DataEraser(engine: engine, store: store, sync: sync, chat: chat, reminders: reminders, health: health)
    }
}
