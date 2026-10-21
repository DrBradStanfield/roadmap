import Foundation

/// What the engine says is due, and the days to notify (US-25 AC12). The slice of
/// `remindersJson` (ios/engine/reminders.ts) the app reads. Swift decides none of
/// it: the schedule is health-core's `computeReminderSchedule`, the one the web
/// pushes for its reminder emails.
struct PhoneReminders: Decodable, Equatable {
    /// One thing due: "Colonoscopy", due 2027-03-01. Shown only inside the app.
    struct Item: Decodable, Equatable {
        let category: String
        let group: String
        let label: String
        /// YYYY-MM-DD.
        let dueAt: String
        /// Due today or earlier, by the engine's reading of the phone's day.
        let overdue: Bool
        /// "Mar 2027", health-core's `formatReminderDate`, as the web's emails write it.
        let dueText: String
    }

    /// One notification to schedule on `fireDay`, the phone's own calendar day; one a day.
    struct Notification: Decodable, Equatable {
        /// `reminder.<day>`, stable across refills, so a re-add replaces rather than doubles.
        let id: String
        let fireDay: String
        /// What falls due that day. Never put on the lock screen.
        let categories: [String]
    }

    /// The record's erase epoch. When it moves, the user erased their data.
    let eraseEpoch: Int
    /// Soonest first.
    let upcoming: [Item]
    /// Soonest first, at most iOS's 64.
    let notifications: [Notification]
}

extension HealthEngine {
    /// The record's reminders, from the engine.
    func reminders(recordJSON: String, now: Date, deviceId: String) throws -> PhoneReminders {
        let json = try call("remindersJson", [recordJSON, now.formatted(Self.iso), deviceId])
        return try JSONDecoder().decode(PhoneReminders.self, from: Data(json.utf8))
    }
}
