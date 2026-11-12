import Foundation

/// What the Sync screen and My data say about where the record is (US-25 AC11e,
/// AC11f). Pure, so a test pins the words.
enum SyncStatusText {
    /// The status line's headline.
    static func headline(_ status: CloudSync.Status, provider: CloudProvider?) -> String {
        guard let provider else { return "On this iPhone only" }
        return switch status {
        case .onPhone: "On this iPhone only"
        case .connecting: "Connecting to \(provider.label)…"
        case .saving: "Saving to \(provider.label)…"
        case .synced: "Synced to \(provider.label)"
        case .problem: "Not synced"
        case .disconnecting: "Disconnecting…"
        }
    }

    /// The SF Symbol for the state: a phone when nothing is connected (never a
    /// struck-out iCloud, which read as "iCloud is off"), else a cloud that shows it.
    static func symbol(_ status: CloudSync.Status, provider: CloudProvider?) -> String {
        guard provider != nil else { return "iphone" }
        return switch status {
        case .onPhone: "iphone"
        case .connecting, .saving, .disconnecting: "arrow.triangle.2.circlepath.icloud"
        case .synced: "checkmark.icloud.fill"
        case .problem: "exclamationmark.icloud.fill"
        }
    }

    /// The sentence under the headline; nil when the headline says it all.
    /// The synced time is drawn by the view, which keeps it current.
    static func detail(_ status: CloudSync.Status, provider: CloudProvider?) -> String? {
        guard let provider else {
            return "Connect Dropbox or Google Drive to use the same record on the website and on a new phone."
        }
        return switch status {
        case .problem(let problem): problem.words(provider)
        case .connecting, .saving: "Your changes are on this iPhone while they go up."
        case .synced, .onPhone, .disconnecting: nil
        }
    }

    /// A Disconnect that could not remove the cloud's file on this iPhone: still connected (US-25 AC11m).
    static func disconnectFailed(_ provider: CloudProvider) -> String {
        "Couldn't disconnect from \(provider.label). Try again."
    }

    /// The switch row, and its dialog's title with a "?" (US-25 AC11n, owner-approved words).
    static func switchRow(_ provider: CloudProvider) -> String {
        "Switch to \(provider.label)"
    }

    /// The switch dialog's message, read as it shows: `current` is the cloud the record is in, and
    /// `recordOpen` (`CloudSync.recordOpen`) whether its session is open. With none open the
    /// engine's close answers 'none' and nothing is copied, so the words promise no copy.
    static func switchMessage(from current: CloudProvider, to provider: CloudProvider, recordOpen: Bool) -> String {
        recordOpen
            ? "Your record in \(current.label) stays there as it is. This iPhone copies it, connects \(provider.label), and saves there from now on."
            : "Your record in \(current.label) stays there as it is. This iPhone connects \(provider.label) and saves there from now on."
    }

    /// What the screen's alert says once a switch from `old` to `new` ends; nil: nothing.
    /// `connected`: the cloud connected now. The on-the-phone sentence is said only while none
    /// is, since a sign-in race may have connected one (US-25 AC11n).
    static func switchEnded(_ outcome: CloudSync.SwitchOutcome, from old: CloudProvider, to new: CloudProvider, connected: CloudProvider?) -> String? {
        switch outcome {
        case .stopped(.unreachable):
            return "\(old.label) could not be reached, so your record there could not be copied to this iPhone. Try again once it answers."
        case .stopped(.failed): return disconnectFailed(old)
        // Refused by the state (a second tap, a Disconnect closing): silent, as Disconnect's is.
        case .stopped, .moved: return nil
        case .failed(let error):
            let cancelled = error as? OAuthClient.Failure == .cancelled
            guard connected == nil else { return cancelled ? nil : error.localizedDescription }
            let sentence = "\(old.label) is disconnected and \(new.label) did not connect. Your record is on this iPhone only."
            return cancelled ? sentence : error.localizedDescription + " " + sentence
        }
    }

    /// The footer under My data: where the record is kept, and nothing more.
    /// `earlier`: the cloud it was synced with before a Disconnect, whose copy stays.
    static func myDataFooter(provider: CloudProvider?, earlier: CloudProvider?) -> String {
        if let provider {
            return "Saved in your \(provider.label), the file the website uses, and on this iPhone, left out of its backups."
        }
        if let earlier {
            return "Kept on this iPhone and left out of its backups. A copy you synced earlier stays in your \(earlier.label)."
        }
        return "Saved only on this iPhone and left out of its backups. Connect Dropbox or Google Drive in Sync to use it on the web or a new phone."
    }
}
