#if DEBUG
import Foundation
import UserNotifications

/// DEBUG only, never in a release build: with `--demo-record`, the app runs on a sample
/// record in Application Support/Demo, so Chat can be filmed on a real iPhone without its
/// owner's record. Nothing reads or writes the Record folder, the cloud's Keychain tokens,
/// Apple Health, the kept Health readings or the phone's notifications, and the app's settings
/// (first-run flags, AI consent, units, prompts) live in their own defaults (UserDefaults.app),
/// so the phone's own are never written. TipKit keeps its store in the Demo folder.
enum DemoRecord {
    static let argument = "--demo-record"
    /// Read once per launch; a test sets it.
    nonisolated(unsafe) static var isOn = ProcessInfo.processInfo.arguments.contains(argument)

    /// Application Support/Demo in demo mode, else the record's own folder.
    nonisolated static func recordFolder(in base: URL = .applicationSupportDirectory) throws -> URL {
        try RecordStore.appFolder(in: base, named: isOn ? "Demo" : "Record")
    }

    static let suite = "demo-record"
    /// UserDefaults.app in demo mode: welcome and questions done, every settings write kept here.
    static var defaults: UserDefaults {
        let defaults = UserDefaults(suiteName: suite)!
        defaults.register(defaults: ["welcomed": true, "onboarded": true])
        return defaults
    }

    /// A Keychain service no sign-in ever wrote: the cloud's tokens are never read.
    static let tokens = TokenStore(service: "com.drstanfield.healthroadmap.oauth.demo")
}

/// Apple Health, absent: AppleHealthSync shows it unavailable and never observes, reads or writes.
@MainActor
final class NoHealth: HealthStoreClient {
    let isAvailable = false
    func requestAuthorization() async throws {}
    func samples(of kind: HealthKind, after anchor: Data?) async throws -> HealthBatch { HealthBatch(samples: [], anchor: nil) }
    func canWrite(_ kind: HealthKind) -> Bool { false }
    func save(_ write: HealthWrite) async throws {}
    func observe(_ kinds: [HealthKind], onChange: @escaping @MainActor () async -> Void) {}
    func deleteOwnSamples() async throws {}
    func characteristics() -> HealthCharacteristics { .none }
}

/// US-56's cards, absent: LiveHealth is unavailable, so it reads no kept file and queries nothing.
struct NoLiveHealth: LiveHealthStore {
    let isAvailable = false
    func needsRequest() async throws -> Bool { false }
    func points(_ metric: LiveMetric, from start: Date, to end: Date, every component: Calendar.Component) async throws -> [LivePoint] { [] }
    func latest(_ metric: LiveMetric) async throws -> (value: Double?, date: Date)? { nil }
    func sleep(from start: Date, to end: Date) async throws -> [SleepSegment] { [] }
}

/// Notifications, absent: the phone's pending reminders are never listed, removed or added.
@MainActor
final class NoNotifications: NotificationScheduling {
    func requestPermission() async throws -> Bool { false }
    func permission() async -> NotificationPermission { .denied }
    func pendingIdentifiers() async -> [String] { [] }
    func removePending(_ identifiers: [String]) {}
    func add(_ request: UNNotificationRequest) async throws {}
}
#endif
