import Foundation

/// The engine's "Delete all my data" doors (US-25 AC13, US-11): ios/engine/erase.ts
/// for the phone's own file, cloud.ts `cloudErase` with a cloud open. The erase is
/// health-core's; these only carry text across. DataEraser decides which to call.
extension HealthEngine {
    /// The phone's record erased, and the chat history tombstoned.
    struct PhoneErase: Decodable {
        /// The erased record, to write over the phone's file.
        let record: String
        /// False when the chat file could not be read; it is left as it was.
        let chatErased: Bool
        /// The tombstoned chat file to write; nil when there is none.
        let chatHistory: String?
    }

    /// Erases the phone's record. Throws, and nothing is erased, when the record
    /// cannot be read: an erase lists the rows it removes.
    func eraseOnPhone(recordJSON: String, historyJSON: String?, now: Date, deviceId: String) throws -> PhoneErase {
        try settled(PhoneErase.self, "erasePhoneJson", [recordJSON, historyJSON ?? NSNull(), now.formatted(Self.iso), deviceId])
    }

    /// What `cloudErase` answers.
    struct CloudErase: Decodable {
        /// The erase reached the cloud.
        let success: Bool
        /// Why not, in plain words, when it did not.
        let error: String?
        /// The session's working copy is the erased record, sent or not.
        let erased: Bool
        /// The chat tombstones were made and written (by `keepChat`).
        let chatErased: Bool
        /// The erased record to show, when `erased`.
        let view: CloudView?
    }

    /// Erases the open cloud record: the cloud file is read first, and one that
    /// cannot be read refuses with nothing changed, chat included. `keepChat` writes
    /// the tombstoned chat file inside the erase, after the read and before the
    /// record goes up (Codex R3); false when the phone refused it.
    @MainActor
    func cloudErase(historyJSON: String?, now: Date, keepChat: @escaping @MainActor (String) -> Bool) async throws -> CloudErase {
        let block: @convention(block) (String) -> String = { text in
            MainActor.assumeIsolated { keepChat(text) ? "" : "The chat history could not be written." }
        }
        let json = try await callAsync("cloudErase", [historyJSON ?? NSNull(), now.formatted(Self.iso), unsafeBitCast(block, to: AnyObject.self)])
        return try JSONDecoder().decode(CloudErase.self, from: Data(json.utf8))
    }
}
