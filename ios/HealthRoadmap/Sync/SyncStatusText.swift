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
    static func myDataFooter(provider: CloudProvider?) -> String {
        guard let provider else {
            return "Saved only on this iPhone and left out of its backups. Connect Dropbox or Google Drive in Sync to use it on the web or a new phone."
        }
        return "Saved in your \(provider.label), the file the website uses, and on this iPhone, left out of its backups."
    }

    /// The plan's privacy line (architecture.md D9). True to the code: the plan is
    /// worked out here, and the record goes only to the cloud the user connected.
    static func planPrivacy(provider: CloudProvider?) -> String {
        guard let provider else { return "No health data left your device." }
        return "Your record goes only to the \(provider.label) you connected, never to Dr Brad's server."
    }
}
