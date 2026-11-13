/// The reminders switch, as one named mode (US-25 AC12b, iPhone survey S7), changed only by
/// `transition`. Off, asking iOS (under the attempt that asked), or on under the record's
/// erase epoch. iOS's permission is not a mode: iOS owns it and the user changes it in
/// Settings with no word to us, so it stays a value read from iOS.
///
/// Only `on` is kept across a launch (`ReminderScheduler` saves its epoch); a launch mid-ask
/// starts off. While asking, a second tap asks nothing more, and an answer that lands after
/// the user turned reminders off, or for an attempt not current, is dropped.
enum ReminderMode: Equatable {
    case off
    case asking(attempt: Int)
    case on(epoch: Int)

    nonisolated static func transition(_ mode: ReminderMode, _ event: ReminderEvent) -> (ReminderMode, ReminderEffect?) {
        switch (mode, event) {
        // An erase on this phone, even one held with no record to read: the opt-in ends (US-11).
        case (_, .erased): (.off, nil)
        case (.off, .tappedOn(let attempt)): (.asking(attempt: attempt), .askPermission(attempt: attempt))
        case (.off, .tappedOff), (.off, .asked), (.off, .read): (.off, nil)

        case (.asking, .tappedOn): (mode, nil)
        case (.asking, .tappedOff): (.off, .refresh)
        case (.asking(let current), .asked(let attempt, let granted, let epoch, let askedAt, let lastRead)):
            if attempt != current { (mode, nil) }
            // An erase while iOS answered moved the epoch: the grant was for the record before
            // it (US-11). A failed read before the ask falls back to the last good read; with
            // none ever, an erase cannot be told, so the grant does not count.
            else if granted, let epoch, let before = askedAt ?? lastRead, before >= epoch { (.on(epoch: epoch), .refresh) }
            else { (.off, .refresh) }
        case (.asking, .read): (mode, nil)

        // "Allow notifications" asks again; the answer only changes what is scheduled.
        case (.on, .tappedOn(let attempt)): (mode, .askPermission(attempt: attempt))
        case (.on, .tappedOff): (.off, .refresh)
        case (.on, .asked): (mode, .refresh)
        // An erase moved the epoch: the opt-in ends. A failed read (nil) is not an erase.
        case (.on(let epoch), .read(let read)): (read == nil || read == epoch ? mode : .off, nil)
        }
    }
}

enum ReminderEvent: Equatable {
    /// The switch turned on, or "Allow notifications"; the attempt is the scheduler's token.
    case tappedOn(attempt: Int)
    case tappedOff
    /// iOS's answer to an attempt, with the record's erase epoch read after a grant, the one
    /// read as the ask began (nil when the record could not be read), and the last good read's
    /// before the ask (nil when the record was never read).
    case asked(attempt: Int, granted: Bool, epoch: Int?, askedAt: Int?, lastRead: Int?)
    /// A refresh read the record: its erase epoch, or nil when it could not be read.
    case read(epoch: Int?)
    /// The record was erased on this phone since the last refresh, drawn or not (S52).
    case erased
}

enum ReminderEffect: Equatable {
    case askPermission(attempt: Int)
    /// Rebuild the pending notifications from the mode: add when on and allowed, else only remove.
    case refresh
}
