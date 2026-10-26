import SwiftUI
import UIKit
import UserNotifications

@main
struct HealthRoadmapApp: App {
    @State private var launch = Launch()
    @Environment(\.scenePhase) private var scenePhase

    var body: some Scene {
        WindowGroup {
            switch launch.parts {
            case nil:
                LaunchView()
            case .success(let parts)?:
                RootView(engine: parts.engine, store: parts.store, sync: parts.sync, chat: parts.chat)
                    .environment(parts.reminders).environment(parts.reminderTaps).environment(parts.health).environment(parts.eraser).environment(parts.live)
                    .task { await parts.sync.start() }
                    // Initial: the app may have come on screen while its parts were built.
                    .onChange(of: scenePhase, initial: true) { _, phase in follow(phase, parts) }
                    #if DEBUG
                    .onAppear { LaunchClock.mark("app shown") }
                    #endif
            case .failure(let error)?:
                ContentUnavailableView("The app could not start", systemImage: "exclamationmark.triangle", description: Text(error.localizedDescription))
            }
        }
    }
}

/// Builds the app's parts as the process starts, without holding the main thread
/// (US-25 AC21): the launch view shows until they are ready. Started from the app's
/// init, not a view, so a background launch (a Health delivery) builds them too.
@MainActor
@Observable
final class Launch {
    /// Nil while the parts are built.
    private(set) var parts: Result<AppParts, Error>?

    init() {
        #if DEBUG
        MainThreadWatchdog.start()
        LaunchClock.mark("app init")
        LiveHealthSeed.runIfAsked()
        #endif
        // TipKit before any view asks for a tip (US-57 AC10).
        TourSetup.configure()
        // Before launch finishes, so a tap that starts the app still reaches My plan.
        let reminderTaps = ReminderTaps()
        UNUserNotificationCenter.current().delegate = reminderTaps
        let health = HealthKitClient()
        let building = Task { try await AppParts.build(reminderTaps: reminderTaps, health: health) }
        // Now, in the app's init, which runs as the process starts: Apple wants Health's
        // observer queries in place before launch finishes, or a background wake for new
        // Health data can be missed. The parts are still being built, so a delivery
        // awaits them before it refreshes (adversary R1).
        AppleHealthSync.observeAtLaunch(client: health) { try? await building.value.health }
        Task {
            do {
                parts = .success(try await building.value)
            } catch {
                parts = .failure(error)
            }
            #if DEBUG
            LaunchClock.mark("parts built")
            #endif
        }
    }
}

/// Cloud sync follows the app on and off the screen (US-25 AC11c): it re-reads on
/// return, and saves what waits before iOS suspends the app, asking iOS for the
/// few seconds that save needs. Coming on screen (launch included, so the app is
/// caught up if it became active while its parts were built) also reads what is new
/// in Apple Health and looks for a newer engine, at most once in 6 hours (US-25 AC18).
@MainActor
private func follow(_ phase: ScenePhase, _ parts: AppParts) {
    switch phase {
    case .active:
        Task { await parts.sync.foreground() }
        Task { await parts.health.refresh() }
        Task { await parts.updater?.checkIfDue() }
    case .background:
        let task = BackgroundTask()
        Task {
            await parts.sync.background()
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
            // UIKit calls the expiration handler on the main thread.
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
    let reminderTaps: ReminderTaps
    /// Apple Health in and out (ios/architecture.md D6). Started at launch, so its
    /// observers are in place when iOS wakes the app for new Health data.
    let health: AppleHealthSync
    /// US-56: heart rate, resting heart rate, sleep, VO2 max and steps, read live from Health and never kept.
    /// One calendar, following the phone's zone, for the store's day anchor and the app's days (adversary R2).
    let live: LiveHealth = {
        let calendar = Calendar.autoupdatingCurrent
        return LiveHealth(store: LiveHealthKitStore(calendar: calendar), calendar: calendar)
    }()
    /// The chat history file: Chat's list and the eraser's tombstones, one store.
    let chat: ChatHistoryStore
    let eraser: DataEraser
    /// Over-the-air engine updates (US-25 AC18); nil if their folder cannot be made.
    let updater: EngineUpdater?

    /// What takes time runs off the main thread, in this order: the files, the engine (its
    /// checks and load), then the phone's record, read and drawn once (US-25 AC21).
    static func build(reminderTaps: ReminderTaps, health: HealthStoreClient) async throws -> AppParts {
        // A background launch (a Health delivery) never tries a new engine.
        let foreground = UIApplication.shared.applicationState != .background
        let files = try await LaunchFiles.read()
        // The newest verified downloaded engine, or the bundled one (ios/architecture.md D3).
        let engine = try await EngineBoot(folder: files.engineFolder, bundled: files.bundled, foreground: foreground).start().engine
        let store = try await RecordStore.open(folder: files.record, engine: engine, deviceId: files.deviceId)
        return AppParts(engine: engine, store: store, files: files, reminderTaps: reminderTaps, health: health)
    }

    private init(engine: HealthEngine, store: RecordStore, files: LaunchFiles, reminderTaps: ReminderTaps, health client: HealthStoreClient) {
        self.engine = engine
        self.store = store
        self.reminderTaps = reminderTaps
        updater = files.engineFolder.map { EngineUpdater(folder: $0, bundled: files.bundled.facts) }
        let folder = files.record
        sync = CloudSync(engine: engine, store: store, oauth: OAuthClient())
        let (engine, store) = (engine, store)
        reminders = ReminderScheduler(center: UNUserNotificationCenter.current(), folder: folder) {
            try await engine.reminders(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId)
        }
        let sync = self.sync
        health = AppleHealthSync(store: store, engine: engine, client: client, live: live) { await sync.syncNow() }
        health.start()
        chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: store.deviceId)
        eraser = DataEraser(store: store, sync: sync, chat: chat, reminders: reminders, health: health)
    }
}

/// The launch's file reads, off the main thread: the bundled engine's source, the
/// downloaded engines' folder, the record's folder and this install's id.
private struct LaunchFiles: Sendable {
    let bundled: BundledEngine
    let engineFolder: EngineFolder?
    let record: URL
    let deviceId: String

    @concurrent
    static func read() async throws -> LaunchFiles {
        let record = try RecordStore.appFolder()
        return LaunchFiles(bundled: try BundledEngine(), engineFolder: try? EngineFolder.live(), record: record, deviceId: try RecordStore.deviceId(in: record))
    }
}

/// What shows while the parts are built (about 100 ms on an iPhone 15 Pro Max): My data's
/// plain background, also the system launch screen's colour (`LaunchBackground`), so
/// nothing changes on screen until My data appears (US-25 AC21b, Brad 2026-10-26).
struct LaunchView: View {
    var body: some View {
        Color(.systemGroupedBackground)
            .ignoresSafeArea()
            .accessibilityElement()
            .accessibilityLabel("Loading")
            #if DEBUG
            .onAppear { LaunchClock.mark("launch view shown") }
            #endif
    }
}
