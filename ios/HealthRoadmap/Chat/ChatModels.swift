import Foundation

/// A conversation in `chat-history.json`, as the list shows it (health-core `ChatConversationSummary`).
struct ChatConversation: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let createdAt: String
    let updatedAt: String
}

/// One saved message (health-core `ChatFileMessage`).
struct ChatMessage: Decodable, Identifiable, Equatable, Sendable {
    let id: String
    let role: String
    let content: String
    let createdAt: String
    let isFallback: Bool?
}

/// One question and its answer, for `ChatSession.recordExchange`.
struct ChatExchange: Encodable, Sendable {
    let conversationId: String
    let isNew: Bool
    let userText: String
    let assistantText: String
    let isFallback: Bool
}

/// One line of the server's NDJSON answer (US-15 AC16, the web's events).
enum ChatStreamEvent: Equatable, Sendable {
    case status(String)
    case text(String)
    case sources([String])
    /// The final reply: the whole answer, which replaces what streamed.
    case done(content: String?, isFallback: Bool, error: String?)
    /// A line this app does not use (thinking, and anything newer): skipped.
    case other

    /// Reads one line; nil if it is not JSON with a `type`.
    static func parse(_ line: String) -> ChatStreamEvent? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String
        else { return nil }
        switch type {
        case "status": return .status(object["text"] as? String ?? "")
        case "text": return .text(object["text"] as? String ?? "")
        case "sources": return .sources((object["titles"] as? [Any] ?? []).compactMap { $0 as? String })
        case "done":
            let success = object["success"] as? Bool ?? false
            return .done(
                content: success ? object["content"] as? String : nil,
                isFallback: object["isFallback"] as? Bool ?? false,
                error: success ? nil : (object["error"] as? String ?? "The answer could not be finished.")
            )
        default: return .other
        }
    }
}
