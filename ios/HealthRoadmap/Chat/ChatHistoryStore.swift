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
    /// Moves the moment an erase writes the chat file (`writeErased`), in either mode.
    /// An answer asked for before it is never saved after it (re-check N1): a new
    /// conversation has no tombstone of its own to refuse it, and the record erase
    /// that moves RecordStore.erasures may still be uploading. Read and moved on any
    /// thread: a cloud erase writes the file on the engine's queue (`writeErased`).
    nonisolated static var erasures: Int { erased.withLock { $0 } }
    private nonisolated static let erased = OSAllocatedUnfairLock(initialState: 0)

    private let engine: HealthEngine
    private let file: URL
    private let deviceId: String

    /// Empty until the first `refresh`.
    init(engine: HealthEngine, folder: URL, deviceId: String) {
        self.engine = engine
        self.deviceId = deviceId
        file = folder.appending(path: "chat-history.json")
    }

    /// The file's text, or nil when there is none yet (or it cannot be read: history
    /// is best effort, as on the web, and never stops a question being asked).
    private nonisolated static func text(_ file: URL) -> String? {
        try? String(contentsOf: file, encoding: .utf8)
    }

    /// Reads the list again, on the engine's queue. A newer refresh wins over an older one.
    func refresh() async {
        refreshes += 1
        let (file, deviceId, mine) = (file, deviceId, refreshes)
        let read = await engine.perform { (try? $0.chatConversations(historyJSON: Self.text(file), now: .now, deviceId: deviceId)) ?? [] }
        if mine == refreshes { conversations = read.filter { !deleting.contains($0.id) } }
    }

    @ObservationIgnored private var refreshes = 0
    /// Swiped conversations whose tombstones are not yet written: a list read before
    /// then (an earlier delete's refresh) never shows them again (re-check N3).
    @ObservationIgnored private var deleting: Set<String> = []

    func messages(_ conversationId: String) async -> [ChatMessage] {
        let (file, deviceId) = (file, deviceId)
        return await engine.perform { (try? $0.chatMessages(historyJSON: Self.text(file), conversationId: conversationId, now: .now, deviceId: deviceId)) ?? [] }
    }

    /// A saved conversation's messages for the screen, read by the engine. Nil when the
    /// screen moved on while they were read (New chat, `leave`, or another `open`): a late
    /// load never replaces what the screen shows then (Codex). Its turn is taken in the tap.
    func open(_ conversationId: String) -> Task<[ChatMessage]?, Never> {
        opens += 1
        let mine = opens
        return Task {
            let read = await messages(conversationId)
            return mine == opens ? read : nil
        }
    }

    /// New chat: a conversation still loading is dropped.
    func leave() {
        opens += 1
    }

    @ObservationIgnored private var opens = 0

    /// Saves one exchange. A failure is dropped: the answer is already on screen.
    /// `askedAt` is `erasures` when the question was sent; an erase since refuses it.
    /// Read, changed and written in one step on the engine's queue, where an erase writes
    /// its tombstones (`writeErased`), so neither can land between the other's read and write.
    func record(_ exchange: ChatExchange, askedAt: Int) async {
        let (file, deviceId) = (file, deviceId)
        let wrote = await engine.perform { engine -> Bool in
            guard askedAt == Self.erasures,
                  let next = try? engine.recordChatExchange(historyJSON: Self.text(file), exchange: exchange, now: .now, deviceId: deviceId)
            else { return false }
            Self.write(next, to: file)
            return true
        }
        if wrote { await refresh() }
    }

    /// Swipe to delete: the row leaves the list at once (R9), and a read of the list under
    /// way is dropped, and any read before its write leaves it out; then the engine writes the
    /// tombstone and the list is read again, so a delete that failed shows its row once more.
    @discardableResult
    func delete(_ conversationId: String) -> Task<Void, Never> {
        conversations.removeAll { $0.id == conversationId }
        deleting.insert(conversationId)
        refreshes += 1
        let (file, deviceId) = (file, deviceId)
        return Task {
            await engine.perform { engine in
                guard let next = try? engine.deleteChat(historyJSON: Self.text(file), conversationId: conversationId, now: .now, deviceId: deviceId) else { return }
                Self.write(next, to: file)
            }
            deleting.remove(conversationId)
            await refresh()
        }
    }

    /// The file's text for "Delete all my data"; nil when there is none. Throws when
    /// it is there but cannot be read, so the erase never claims a history it missed.
    func textForErase() throws -> String? {
        guard FileManager.default.fileExists(atPath: file.path(percentEncoded: false)) else { return nil }
        return try String(contentsOf: file, encoding: .utf8)
    }

    /// Keeps the tombstoned file the engine made for an erase (US-11 AC2); nil: none to
    /// write. False when the phone refused the write, so the erase can say so. Called on
    /// the engine's queue (either erase), which never waits on the main thread. Refresh after.
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
