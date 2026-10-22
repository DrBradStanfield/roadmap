import Foundation

/// The engine doors chat and lab upload use (US-52; ios/engine/app-doors.ts).
/// Each is health-core's own function, run in JavaScriptCore like the plan.
extension HealthEngine {
    /// What the chat sends with a question: the web widget's `chatContextOf`, built from the record.
    func chatContext(recordJSON: String, now: Date, deviceId: String) throws -> String {
        try call("chatContextJson", [recordJSON, now.formatted(Self.iso), deviceId])
    }

    /// The live conversations in `chat-history.json`, newest first.
    func chatConversations(historyJSON: String?, now: Date, deviceId: String) throws -> [ChatConversation] {
        try settled([ChatConversation].self, "chatListJson", [historyJSON ?? NSNull(), now.formatted(Self.iso), deviceId])
    }

    /// One conversation's messages, in reading order.
    func chatMessages(historyJSON: String?, conversationId: String, now: Date, deviceId: String) throws -> [ChatMessage] {
        try settled([ChatMessage].self, "chatMessagesJson", [historyJSON ?? NSNull(), conversationId, now.formatted(Self.iso), deviceId])
    }

    /// Records one question and answer by the web's rule (title, cap, tombstones). Returns the new file's text.
    func recordChatExchange(historyJSON: String?, exchange: ChatExchange, now: Date, deviceId: String) throws -> String {
        let exchangeJSON = String(decoding: try JSONEncoder().encode(exchange), as: UTF8.self)
        return try settled(String.self, "chatRecordExchangeJson", [historyJSON ?? NSNull(), exchangeJSON, now.formatted(Self.iso), deviceId])
    }

    /// Deletes a conversation (a tombstone, as on the web). Returns the new file's text.
    func deleteChat(historyJSON: String?, conversationId: String, now: Date, deviceId: String) throws -> String {
        try settled(String.self, "chatDeleteJson", [historyJSON ?? NSNull(), conversationId, now.formatted(Self.iso), deviceId])
    }

    /// Calls an async door, then reads its answer. JavaScriptCore runs pending promise
    /// work before a call returns, so the answer is there; "pending" would mean it was not.
    func settled<T: Decodable>(_ type: T.Type, _ name: String, _ arguments: [Any]) throws -> T {
        _ = try call(name, arguments)
        let answer = try JSONDecoder().decode(Settled<T>.self, from: Data(call("settledJson", []).utf8))
        guard answer.ok, let value = answer.value else { throw EngineError.callFailed(answer.message ?? "no answer") }
        return value
    }
}

private struct Settled<T: Decodable>: Decodable {
    let ok: Bool
    let value: T?
    let message: String?
}
