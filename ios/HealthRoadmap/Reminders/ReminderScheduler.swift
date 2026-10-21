import Foundation
import Observation
import UserNotifications

/// Keeps the phone's pending notifications equal to what the engine says is due
/// (US-25 AC12, ios/architecture.md D7). No server and no email: iOS delivers them.
///
/// Every refresh rebuilds from scratch: remove our pending ones, add the engine's
/// soonest batch (iOS holds 64). The app refreshes on launch, on return to the
/// foreground and on every change to the record, so the batch refills itself.
///
/// The opt-in is this phone's: a small file beside the record, in the folder backups
/// leave out (D5), holding the record's erase epoch at the time. A restored phone
/// starts a new record, so it starts with reminders off. An erase moves the epoch,
/// which ends the opt-in and cancels every reminder, so an erased record never
/// notifies (US-11). It is not written to the
/// record: the record's `reminderOptIn` is the web's email enrolment, with a server
/// token and an address, and a phone's notification permission is not one (D7).
@MainActor
@Observable
final class ReminderScheduler {
    /// What the engine last said; nil when the record could not be read.
    private(set) var reminders: PhoneReminders?
    /// What iOS allows; nil until first asked.
    private(set) var permission: NotificationPermission?
    /// The record's erase epoch when the user turned reminders on; nil when off.
    /// Stored, so SwiftUI sees it change; saved to `optInFile` on every change.
    private var optedInEpoch: Int? {
        didSet { save() }
    }
    var optedIn: Bool { optedInEpoch != nil }

    /// Our notifications, and only ours, start with this.
    nonisolated static let prefix = "reminder."
    /// iOS keeps at most 64 pending notifications per app.
    static let limit = 64
    /// The hour, on the phone's clock, a reminder shows on its day.
    static let hour = 9

    private let center: NotificationScheduling
    private let optInFile: URL
    private let compute: @MainActor () throws -> PhoneReminders
    /// Refreshes run one after another, so two never interleave their removes and adds.
    private var last: Task<Void, Never>?

    /// `folder` is the record's (RecordStore.appFolder), left out of backups.
    init(center: NotificationScheduling, folder: URL, compute: @escaping @MainActor () throws -> PhoneReminders) {
        self.center = center
        self.compute = compute
        optInFile = folder.appending(path: "reminders-opt-in")
        optedInEpoch = (try? String(contentsOf: optInFile, encoding: .utf8)).flatMap { Int($0) }
    }

    private func save() {
        if let optedInEpoch {
            try? Data(String(optedInEpoch).utf8).write(to: optInFile, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: optInFile)
        }
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
        // An erase since the opt-in ends it. A failed read is not an erase: it only
        // cancels this round, and the next good read schedules again.
        if let epoch = optedInEpoch, let next, epoch != next.eraseEpoch { optedInEpoch = nil }
        permission = await center.permission()

        let ours = await center.pendingIdentifiers().filter { $0.hasPrefix(Self.prefix) }
        center.removePending(ours)
        guard let next, optedIn, permission == .allowed else { return }
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
