import Foundation
import Observation
import os

/// The chat history file, `chat-history.json`, beside the record in the app's own
/// storage (US-52 AC6). Every change is health-core's `ChatSession` rule, run in the
/// engine; this type only reads and writes the file. The web twin keeps the same
/// file in the user's cloud or the browser (widget-src/src/lib/chat-sync.ts).
@MainActor
@Observable
final class ChatHistoryStore {
    private(set) var conversations: [ChatConversation] = []
    /// Moves the moment an erase writes the chat file (`keepErased`), in either mode.
    /// An answer asked for before it is never saved after it (re-check N1): a new
    /// conversation has no tombstone of its own to refuse it, and the record erase
    /// that moves RecordStore.erasures may still be uploading. Read and moved on any
    /// thread: a cloud erase writes the file on the engine's queue (`writeErased`).
    nonisolated static var erasures: Int { erased.withLock { $0 } }
    private nonisolated static let erased = OSAllocatedUnfairLock(initialState: 0)

    private let engine: HealthEngine
    private let file: URL
    private let deviceId: String

    init(engine: HealthEngine, folder: URL, deviceId: String) {
        self.engine = engine
        self.deviceId = deviceId
        file = folder.appending(path: "chat-history.json")
        refresh()
    }

    /// The file's text, or nil when there is none yet (or it cannot be read: history
    /// is best effort, as on the web, and never stops a question being asked).
    private nonisolated static func text(_ file: URL) -> String? {
        try? String(contentsOf: file, encoding: .utf8)
    }

    func refresh() {
        let (file, deviceId) = (file, deviceId)
        conversations = engine.blocking { (try? $0.chatConversations(historyJSON: Self.text(file), now: .now, deviceId: deviceId)) ?? [] }
    }

    func messages(_ conversationId: String) -> [ChatMessage] {
        let (file, deviceId) = (file, deviceId)
        return engine.blocking { (try? $0.chatMessages(historyJSON: Self.text(file), conversationId: conversationId, now: .now, deviceId: deviceId)) ?? [] }
    }

    /// Saves one exchange. A failure is dropped: the answer is already on screen.
    /// `askedAt` is `erasures` when the question was sent; an erase since refuses it.
    /// Read, changed and written on the engine's queue, where a cloud erase writes
    /// its tombstones, so neither can land between the other's read and write.
    func record(_ exchange: ChatExchange, askedAt: Int) {
        let (file, deviceId) = (file, deviceId)
        let wrote = engine.blocking { engine -> Bool in
            guard askedAt == Self.erasures,
                  let next = try? engine.recordChatExchange(historyJSON: Self.text(file), exchange: exchange, now: .now, deviceId: deviceId)
            else { return false }
            Self.write(next, to: file)
            return true
        }
        if wrote { refresh() }
    }

    func delete(_ conversationId: String) {
        let (file, deviceId) = (file, deviceId)
        let wrote = engine.blocking { engine -> Bool in
            guard let next = try? engine.deleteChat(historyJSON: Self.text(file), conversationId: conversationId, now: .now, deviceId: deviceId) else { return false }
            Self.write(next, to: file)
            return true
        }
        if wrote { refresh() }
    }

    /// The file's text for "Delete all my data"; nil when there is none. Throws when
    /// it is there but cannot be read, so the erase never claims a history it missed.
    func textForErase() throws -> String? {
        guard FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else { return nil }
        return try String(contentsOf: file, encoding: .utf8)
    }

    /// Keeps the tombstoned file the engine made for an erase (US-11 AC2); nil: none to
    /// write. False when the phone refused the write, so the erase can say so.
    func keepErased(_ json: String?) -> Bool {
        defer { refresh() }
        return writeErased(json)
    }

    /// `keepErased` without the redraw, for any thread: a cloud erase calls it on the
    /// engine's queue, which never waits on the main thread. Refresh after.
    nonisolated var writeErased: @Sendable (String?) -> Bool {
        let file = file
        return { json in
            ChatHistoryStore.erased.withLock { $0 += 1 }
            guard let json else { return true }
            return ChatHistoryStore.write(json, to: file)
        }
    }

    @discardableResult
    private nonisolated static func write(_ json: String, to file: URL) -> Bool {
        (try? Data(json.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])) != nil
    }
}
