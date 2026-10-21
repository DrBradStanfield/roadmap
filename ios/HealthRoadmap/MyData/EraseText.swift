import Foundation

/// What "Delete all my data" says, before and after (US-25 AC13, US-11 AC5: the
/// caveats belong in the confirmation, where they are still a decision). The web's
/// words are HealthTool.tsx `ERASE_CONFIRM`; the app has fewer copies to name: no
/// documents, no command-line backups, and Dr Brad's server keeps no app chat (D8).
enum EraseText {
    static let title = "Delete all my data"
    static let finalTitle = "Delete everything?"
    static let finalMessage = "This cannot be undone."
    static let deleteButton = "Delete everything"

    /// The first step: what goes, where, and what the erase cannot reach.
    // When Apple Health lands (D6), the samples this app wrote join the list here.
    static func confirm(provider: CloudProvider?, earlier: CloudProvider?) -> String {
        var text = "This deletes your health record, your chat history and your reminders on this iPhone."
        if let provider {
            text += " It also erases your record in \(provider.label). The file stays there, empty, so your other devices erase their copies when they next sync."
            text += "\n\nA value another device has not synced yet is kept, and arrives later."
        } else if let earlier {
            text += " Your record's copy in \(earlier.label), from before you disconnected, is not changed. To erase it too, connect \(earlier.label) first."
        }
        let history = provider.map { " \($0.label)'s version history of the file," } ?? ""
        text += "\n\nThis cannot reach copies you exported or shared,\(history) or chat questions already sent: Dr Brad's server keeps none, but Anthropic may keep them for a limited time."
        return text
    }

    /// The erase reached everywhere it was meant to.
    static func done(provider: CloudProvider?, chatErased: Bool) -> String {
        var text = chatErased
            ? "Your health record, chat history and reminders are deleted."
            : "Your health record and reminders are deleted. Your chat history could not be read, so it is still on this iPhone. Try again to delete it."
        if let provider { text += " Your other devices erase their copies when they next sync with \(provider.label)." }
        return text
    }

    /// Erased here, but the cloud has not taken it yet: the app sends it later.
    static func notSent(provider: CloudProvider, chatErased: Bool) -> String {
        var text = "Your record is erased on this iPhone, but \(provider.label) could not take the erase just now. The app sends it when \(provider.label) answers; until then the copy there is unchanged."
        text += chatErased ? " Your chat history and reminders are deleted." : " Your reminders are deleted. Your chat history could not be read, so it is still on this iPhone."
        return text
    }

    static func unreachable(_ provider: CloudProvider) -> String {
        "\(provider.label) could not be reached, so nothing was deleted. An erase must read the record it erases. Try again once you are online."
    }

    static let unreadable = "Your record on this iPhone could not be read, so nothing was deleted."

    /// The phone refused to write the erased record.
    static func notWritten(_ reason: String, chatErased: Bool) -> String {
        "Your record could not be erased: \(reason)" + (chatErased ? " Your chat history was deleted." : "")
    }
}
