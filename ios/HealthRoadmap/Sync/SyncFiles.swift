import Foundation

/// The small files sync keeps beside the record (US-25 AC11). They sit in the
/// Record folder, which backups leave out (D5), so a phone restored from a
/// backup comes back unconnected, as its this-device-only Keychain tokens do.
/// None holds a health value.
struct SyncFiles {
    /// The connected cloud's id ("dropbox", "google-drive").
    let provider: URL
    /// The connected account's id, so "Sign in again" as someone else is refused.
    let account: URL
    /// That account's email, which Sync shows; absent when the provider gave none.
    /// Removed on Disconnect and on "Delete all my data".
    let email: URL
    /// The last cloud the record was synced with. Kept after Disconnect: the
    /// copy there stays, and the app's words say so (review A3).
    let history: URL
    /// Present while the phone holds changes the cloud lacks (US-09 AC4).
    let pending: URL

    init(folder: URL) {
        provider = folder.appending(path: "sync-provider")
        account = folder.appending(path: "sync-account")
        email = folder.appending(path: "sync-account-email")
        history = folder.appending(path: "sync-history")
        pending = folder.appending(path: "sync-pending")
    }

    func read(_ file: URL) -> String? {
        try? String(contentsOf: file, encoding: .utf8)
    }

    func write(_ text: String, to file: URL) throws {
        try Data(text.utf8).write(to: file, options: .atomic)
    }

    func remove(_ file: URL) {
        try? FileManager.default.removeItem(at: file)
    }

    func exists(_ file: URL) -> Bool {
        FileManager.default.fileExists(atPath: file.path(percentEncoded: false))
    }
}
