import Foundation
import Observation

/// The chat history file, `chat-history.json`, beside the record in the app's own
/// storage (US-52 AC6). Every change is health-core's `ChatSession` rule, run in the
/// engine; this type only reads and writes the file. The web twin keeps the same
/// file in the user's cloud or the browser (widget-src/src/lib/chat-sync.ts).
@MainActor
@Observable
final class ChatHistoryStore {
    private(set) var conversations: [ChatConversation] = []

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
    private func text() -> String? {
        try? String(contentsOf: file, encoding: .utf8)
    }

    func refresh() {
        conversations = (try? engine.chatConversations(historyJSON: text(), now: .now, deviceId: deviceId)) ?? []
    }

    func messages(_ conversationId: String) -> [ChatMessage] {
        (try? engine.chatMessages(historyJSON: text(), conversationId: conversationId, now: .now, deviceId: deviceId)) ?? []
    }

    /// Saves one exchange. A failure is dropped: the answer is already on screen.
    func record(_ exchange: ChatExchange) {
        guard let next = try? engine.recordChatExchange(historyJSON: text(), exchange: exchange, now: .now, deviceId: deviceId) else { return }
        write(next)
    }

    func delete(_ conversationId: String) {
        guard let next = try? engine.deleteChat(historyJSON: text(), conversationId: conversationId, now: .now, deviceId: deviceId) else { return }
        write(next)
    }

    private func write(_ json: String) {
        try? Data(json.utf8).write(to: file, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        refresh()
    }
}
