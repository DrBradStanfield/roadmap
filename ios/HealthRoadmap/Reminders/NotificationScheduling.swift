import UserNotifications

/// The part of UNUserNotificationCenter the reminders use, behind a protocol so
/// the tests can run the scheduler against a fake (ReminderSchedulerTests).
/// What iOS allows. `notAsked` is not a refusal: Settings has no switch for the
/// app until it has asked, so the app asks again instead of pointing there.
enum NotificationPermission: Equatable {
    case allowed, denied, notAsked
}

@MainActor
protocol NotificationScheduling {
    /// Asks iOS for permission; true when granted.
    func requestPermission() async throws -> Bool
    /// What iOS allows now (the user can change it in Settings).
    func permission() async -> NotificationPermission
    func pendingIdentifiers() async -> [String]
    func removePending(_ identifiers: [String])
    func add(_ request: UNNotificationRequest) async throws
}

extension UNUserNotificationCenter: NotificationScheduling {
    func requestPermission() async throws -> Bool {
        try await requestAuthorization(options: [.alert, .sound])
    }

    func permission() async -> NotificationPermission {
        switch await notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: .allowed
        case .notDetermined: .notAsked
        default: .denied
        }
    }

    func pendingIdentifiers() async -> [String] {
        await pendingNotificationRequests().map(\.identifier)
    }

    func removePending(_ identifiers: [String]) {
        removePendingNotificationRequests(withIdentifiers: identifiers)
    }
}
