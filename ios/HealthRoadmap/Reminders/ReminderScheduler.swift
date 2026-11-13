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
    /// The erase epoch of the last good read, kept through failed ones: the ask falls back to it.
    private var lastEpoch: Int?
    /// What iOS allows; nil until first asked.
    private(set) var permission: NotificationPermission?
    /// Off, asking iOS, or on under the record's erase epoch at the time (AC12b). Stored, so
    /// SwiftUI sees it change; only `on` is saved to `optInFile`, so a launch mid-ask starts off.
    private var mode: ReminderMode = .off {
        didSet { save() }
    }
    var optedIn: Bool { if case .on = mode { true } else { false } }
    /// Mints each ask's attempt, so a late answer to an older one is known: a token, not a mode.
    private var attempts = 0

    /// Our notifications, and only ours, start with this.
    nonisolated static let prefix = "reminder."
    /// iOS keeps at most 64 pending notifications per app.
    static let limit = 64
    /// The hour, on the phone's clock, a reminder shows on its day.
    static let hour = 9

    private let center: NotificationScheduling
    private let optInFile: URL
    /// US-17 AC15: the engine's first-seen day per follow-up reminder, beside the opt-in.
    /// Never sent anywhere; kept only while reminders are scheduled.
    private let firstSeenFile: URL
    private let compute: @MainActor (_ firstSeen: [String: String]) async throws -> PhoneReminders
    /// Refreshes run one after another, so two never interleave their removes and adds.
    private var last: Task<Void, Never>?

    /// `folder` is the record's (RecordStore.appFolder), left out of backups.
    init(center: NotificationScheduling, folder: URL, compute: @escaping @MainActor (_ firstSeen: [String: String]) async throws -> PhoneReminders) {
        self.center = center
        self.compute = compute
        optInFile = folder.appending(path: "reminders-opt-in")
        firstSeenFile = folder.appending(path: "reminders-first-seen")
        mode = (try? String(contentsOf: optInFile, encoding: .utf8)).flatMap { Int($0) }.map { .on(epoch: $0) } ?? .off
    }

    private func save() {
        if case .on(let epoch) = mode {
            try? Data(String(epoch).utf8).write(to: optInFile, options: .atomic)
        } else {
            try? FileManager.default.removeItem(at: optInFile)
        }
    }

    private func firstSeen() -> [String: String] {
        (try? Data(contentsOf: firstSeenFile)).flatMap { try? JSONDecoder().decode([String: String].self, from: $0) } ?? [:]
    }

    private func keepFirstSeen(_ seen: [String: String]) {
        if seen.isEmpty { try? FileManager.default.removeItem(at: firstSeenFile) }
        else if let data = try? JSONEncoder().encode(seen) { try? data.write(to: firstSeenFile, options: .atomic) }
    }

    /// Recomputes and reschedules.
    func refresh() async {
        let previous = last
        let task = Task { await previous?.value; await reschedule() }
        last = task
        await task.value
    }

    /// Asks iOS for permission, and on a yes turns reminders on under the record's current epoch.
    /// A tap while an ask is out asks nothing more (AC12b).
    func optIn() async -> Bool {
        attempts += 1
        await run(send(.tappedOn(attempt: attempts)))
        return optedIn
    }

    func optOut() async {
        await run(send(.tappedOff))
    }

    private func send(_ event: ReminderEvent) -> ReminderEffect? {
        let (next, effect) = ReminderMode.transition(mode, event)
        if next != mode { mode = next }
        return effect
    }

    private func run(_ effect: ReminderEffect?) async {
        switch effect {
        case .askPermission(let attempt):
            let askedAt = (try? await compute(firstSeen()))?.eraseEpoch
            let lastRead = lastEpoch
            let granted = (try? await center.requestPermission()) ?? false
            let epoch = granted ? (try? await compute(firstSeen()))?.eraseEpoch : nil
            await run(send(.asked(attempt: attempt, granted: granted, epoch: epoch, askedAt: askedAt, lastRead: lastRead)))
        case .refresh: await refresh()
        case nil: break
        }
    }

    private func reschedule() async {
        let next = try? await compute(firstSeen())
        reminders = next
        if let next { lastEpoch = next.eraseEpoch }
        // An erase since the opt-in ends it. A failed read is not an erase: it only
        // cancels this round, and the next good read schedules again.
        _ = send(.read(epoch: next?.eraseEpoch))
        permission = await center.permission()
        // Off, refused or erased: the first-seen days go whatever the engine answered (or if it
        // failed), so turning reminders on again fires each follow-up on its first morning.
        if !optedIn || permission != .allowed { keepFirstSeen([:]) } else if let seen = next?.firstSeen { keepFirstSeen(seen) }

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
        // The engine's day is Gregorian. Without a calendar iOS reads it in the phone's,
        // so a Buddhist phone never fired and a Japanese one fired 2000 years late (as DayText).
        // A calendar keeps the zone it was made in after the phone moves; following the
        // phone's zone keeps 9:00 on the phone's clock.
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = .autoupdatingCurrent
        let day = DateComponents(calendar: gregorian, year: parts.first, month: parts.dropFirst().first,
                                 day: parts.dropFirst(2).first, hour: hour)
        let trigger = UNCalendarNotificationTrigger(dateMatching: day, repeats: false)
        return UNNotificationRequest(identifier: notification.id, content: content, trigger: trigger)
    }
}
