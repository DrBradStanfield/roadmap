import Observation
import UserNotifications

/// Hears taps on reminder notifications and asks the app to show My plan, where
/// the detail is (US-25 AC12). Set as the notification center's delegate at
/// launch, before the app finishes launching, so a tap that cold-starts the app
/// still lands. RootView switches tab when `planRequests` moves.
@MainActor
@Observable
final class ReminderTaps: NSObject, UNUserNotificationCenterDelegate {
    /// Counts taps; RootView watches it.
    private(set) var planRequests = 0

    // The completion-handler forms, answered at once: the async forms have been
    // reported to finish off the main thread, which UIKit refuses.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let ours = response.notification.request.identifier.hasPrefix(ReminderScheduler.prefix)
        if ours { Task { @MainActor in self.planRequests += 1 } }
        completionHandler()
    }

    /// With the app open, still show it: the words are generic, and the user may be on another tab.
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }
}
