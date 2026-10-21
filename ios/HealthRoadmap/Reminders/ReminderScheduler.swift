import Foundation
import Observation
import UserNotifications

/// Keeps the phone's pending notifications equal to what the engine says is due
/// (US-25 AC9, ios/architecture.md D7). No server and no email: iOS delivers them.
///
/// Every refresh rebuilds from scratch: remove our pending ones, add the engine's
/// soonest batch (iOS holds 64). The app refreshes on launch, on return to the
/// foreground and on every change to the record, so the batch refills itself.
///
/// The opt-in is this phone's, kept in UserDefaults with the record's erase epoch
/// at the time. An erase moves the epoch, which ends the opt-in and cancels every
/// reminder, so an erased record never notifies (US-11). It is not written to the
/// record: the record's `reminderOptIn` is the web's email enrolment, with a server
/// token and an address, and a phone's notification permission is not one (D7).
@MainActor
@Observable
final class ReminderScheduler {
    /// What the engine last said; nil when the record could not be read.
    private(set) var reminders: PhoneReminders?
    /// Whether iOS lets us notify; false until known.
    private(set) var permitted = false
    var optedIn: Bool { optedInEpoch != nil }

    /// Our notifications, and only ours, start with this.
    nonisolated static let prefix = "reminder."
    /// iOS keeps at most 64 pending notifications per app.
    static let limit = 64
    /// The hour, on the phone's clock, a reminder shows on its day.
    static let hour = 9
    private static let epochKey = "reminders.optedInEpoch"

    private let center: NotificationScheduling
    private let defaults: UserDefaults
    private let compute: @MainActor () throws -> PhoneReminders
    /// Refreshes run one after another, so two never interleave their removes and adds.
    private var last: Task<Void, Never>?

    init(center: NotificationScheduling, defaults: UserDefaults = .standard, compute: @escaping @MainActor () throws -> PhoneReminders) {
        self.center = center
        self.defaults = defaults
        self.compute = compute
    }

    private var optedInEpoch: Int? {
        get { defaults.object(forKey: Self.epochKey) as? Int }
        set { defaults.set(newValue, forKey: Self.epochKey) }
    }

    /// Recomputes and reschedules.
    func refresh() async {
        let previous = last
        let task = Task { await previous?.value; await reschedule() }
        last = task
        await task.value
    }

    /// Asks iOS for permission, and on a yes turns reminders on under the record's current epoch.
    func optIn() async -> Bool {
        let granted = (try? await center.requestPermission()) ?? false
        if granted, let epoch = (try? compute())?.eraseEpoch { optedInEpoch = epoch }
        await refresh()
        return optedIn
    }

    func optOut() async {
        optedInEpoch = nil
        await refresh()
    }

    private func reschedule() async {
        let next = try? compute()
        reminders = next
        // An erase since the opt-in ends it.
        if let epoch = optedInEpoch, epoch != next?.eraseEpoch { optedInEpoch = nil }
        permitted = await center.isPermitted()

        let ours = await center.pendingIdentifiers().filter { $0.hasPrefix(Self.prefix) }
        center.removePending(ours)
        guard let next, optedIn, permitted else { return }
        for notification in next.notifications.prefix(Self.limit) {
            try? await center.add(Self.request(for: notification))
        }
    }

    /// The notification for one day. The lock screen can be read by anyone holding
    /// the phone, so it says only that a check-up is due; which one is inside the app (D7).
    static func request(for notification: PhoneReminders.Notification) -> UNNotificationRequest {
        let content = UNMutableNotificationContent()
        content.title = "Health Roadmap"
        content.body = "A check-up is due. Open the app to see which."
        content.sound = .default
        let parts = notification.fireDay.split(separator: "-").compactMap { Int($0) }
        let day = DateComponents(year: parts.first, month: parts.dropFirst().first, day: parts.dropFirst(2).first, hour: hour)
        let trigger = UNCalendarNotificationTrigger(dateMatching: day, repeats: false)
        return UNNotificationRequest(identifier: notification.id, content: content, trigger: trigger)
    }
}
