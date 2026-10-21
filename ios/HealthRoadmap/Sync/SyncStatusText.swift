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
        case .synced: "Synced with \(provider.label)"
        case .problem: "Not synced"
        }
    }

    /// The SF Symbol for the state: a phone when nothing is connected (never a
    /// struck-out iCloud, which read as "iCloud is off"), else a cloud that shows it.
    static func symbol(_ status: CloudSync.Status, provider: CloudProvider?) -> String {
        guard provider != nil else { return "iphone" }
        return switch status {
        case .onPhone: "iphone"
        case .connecting, .saving: "arrow.triangle.2.circlepath.icloud"
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
        case .synced, .onPhone: nil
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
