import Foundation

/// What "Delete all my data" says, before and after (US-25 AC16, US-11 AC5: the
/// caveats belong in the confirmation, where they are still a decision). The web's
/// words are HealthTool.tsx `ERASE_CONFIRM`; the app has fewer copies to name: no
/// documents, no command-line backups, and Dr Brad's server keeps no app chat (D8).
enum EraseText {
    static let title = "Delete all my data"
    static let finalTitle = "Delete everything?"
    static let finalMessage = "This cannot be undone."
    static let deleteButton = "Delete everything"

    /// The first step: what goes, where, and what the erase cannot reach.
    static func confirm(provider: CloudProvider?, earlier: CloudProvider?, appleHealth: Bool = false) -> String {
        var text = "This deletes your health record, your chat history and your reminders on this iPhone."
        if appleHealth {
            text += " It also deletes the readings this app wrote to Apple Health. Readings from other apps and devices stay in Apple Health."
        }
        if let provider {
            text += " It also erases your record in \(provider.label). The file stays there with your values erased from it, so your other devices erase their copies when they next sync."
            text += "\n\nA value another device has not synced yet is kept, and arrives later."
        } else if let earlier {
            // A later connect lifts this erase up: its higher epoch and its list of rows win
            // there too (US-09 AC23), so the words never promise that copy survives (review R3).
            text += " Your record's copy in \(earlier.label), from before you disconnected, is not changed now. If you connect \(earlier.label) again, the values erased here are erased there too."
        }
        let history = provider.map { " \($0.label)'s version history of the file," } ?? ""
        text += "\n\nThis cannot reach copies you exported or shared,\(history) or chat questions already sent: Dr Brad's server keeps none, but Anthropic may keep them for a limited time."
        return text
    }

    /// The erase reached everywhere it was meant to.
    static func done(provider: CloudProvider?, chatErased: Bool) -> String {
        var text = chatErased
            ? "Your health record, chat history and reminders are deleted."
            : "Your health record and reminders are deleted. Your chat history could not be deleted, so it is still on this iPhone. Try again to delete it."
        if let provider { text += " Your other devices erase their copies when they next sync with \(provider.label)." }
        return text
    }

    /// Erased here, but the cloud has not taken it yet: the app sends it later.
    static func notSent(provider: CloudProvider, chatErased: Bool) -> String {
        var text = "Your record is erased on this iPhone, but \(provider.label) could not take the erase just now. The app sends it when \(provider.label) answers; until then the copy there is unchanged."
        text += chatErased ? " Your chat history and reminders are deleted." : " Your reminders are deleted. Your chat history could not be deleted, so it is still on this iPhone."
        return text
    }

    /// The engine refused: its own words, unless they are the plain "could not be reached".
    static func refusal(_ engineWords: String?, provider: CloudProvider) -> String {
        guard let engineWords, !engineWords.contains("could not be reached") else { return unreachable(provider) }
        return "Nothing was deleted. \(engineWords)"
    }

    /// The erase failed (an engine error). The chat history may already be gone (re-check N2).
    static func failed(_ reason: String, chatErased: Bool) -> String {
        chatErased
            ? "Your record was not erased. \(reason) Your chat history was deleted."
            : "Nothing was deleted. \(reason)"
    }

    /// Apple Health refused to delete the app's samples: the record erase still stands.
    static let healthNotErased = " The readings this app wrote to Apple Health could not be deleted. You can delete them in the Health app."

    static func unreachable(_ provider: CloudProvider) -> String {
        "\(provider.label) could not be reached, so nothing was deleted. An erase must read the record it erases. Try again once you are online."
    }

    /// Nothing is erased; the one way left is named (review R4).
    static let unreadable = "Your record on this iPhone could not be read, so nothing was deleted. Deleting the app removes everything it keeps on this iPhone."

    /// The phone refused to write the erased record.
    static func notWritten(_ reason: String, chatErased: Bool) -> String {
        "Your record could not be erased: \(reason)" + (chatErased ? " Your chat history was deleted." : "")
    }
}
