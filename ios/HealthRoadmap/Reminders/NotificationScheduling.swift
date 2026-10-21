import UserNotifications

/// The part of UNUserNotificationCenter the reminders use, behind a protocol so
/// the tests can run the scheduler against a fake (ReminderSchedulerTests).
@MainActor
protocol NotificationScheduling {
    /// Asks iOS for permission; true when granted.
    func requestPermission() async throws -> Bool
    /// Whether iOS will show our notifications now (the user can turn them off in Settings).
    func isPermitted() async -> Bool
    func pendingIdentifiers() async -> [String]
    func removePending(_ identifiers: [String])
    func add(_ request: UNNotificationRequest) async throws
}

extension UNUserNotificationCenter: NotificationScheduling {
    func requestPermission() async throws -> Bool {
        try await requestAuthorization(options: [.alert, .sound])
    }

    func isPermitted() async -> Bool {
        let status = await notificationSettings().authorizationStatus
        return status == .authorized || status == .provisional || status == .ephemeral
    }

    func pendingIdentifiers() async -> [String] {
        await pendingNotificationRequests().map(\.identifier)
    }

    func removePending(_ identifiers: [String]) {
        removePendingNotificationRequests(withIdentifiers: identifiers)
    }
}
