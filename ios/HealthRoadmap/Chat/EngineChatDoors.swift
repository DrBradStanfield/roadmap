import Foundation

/// The engine doors chat and lab upload use (US-52; ios/engine/app-doors.ts).
/// Each is health-core's own function, run in JavaScriptCore like the plan.
extension HealthEngine {
    /// What the chat sends with a question: the web widget's `chatContextOf`, built from the record.
    func chatContext(recordJSON: String, now: Date, deviceId: String) throws -> String {
        try doorChatContextJson(recordJson: recordJSON, nowIso: now.formatted(Self.iso), deviceId: deviceId)
    }

    /// The live conversations in `chat-history.json`, newest first.
    func chatConversations(historyJSON: String?, now: Date, deviceId: String) throws -> [ChatConversation] {
        try doorChatListJson([ChatConversation].self, historyText: historyJSON, nowIso: now.formatted(Self.iso), deviceId: deviceId)
    }

    /// One conversation's messages, in reading order.
    func chatMessages(historyJSON: String?, conversationId: String, now: Date, deviceId: String) throws -> [ChatMessage] {
        try doorChatMessagesJson([ChatMessage].self, historyText: historyJSON, conversationId: conversationId, nowIso: now.formatted(Self.iso), deviceId: deviceId)
    }

    /// Records one question and answer by the web's rule (title, cap, tombstones). Returns the new file's text.
    func recordChatExchange(historyJSON: String?, exchange: ChatExchange, now: Date, deviceId: String) throws -> String {
        let exchangeJSON = String(decoding: try JSONEncoder().encode(exchange), as: UTF8.self)
        return try doorChatRecordExchangeJson(String.self, historyText: historyJSON, exchangeJson: exchangeJSON, nowIso: now.formatted(Self.iso), deviceId: deviceId)
    }

    /// Deletes a conversation (a tombstone, as on the web). Returns the new file's text.
    func deleteChat(historyJSON: String?, conversationId: String, now: Date, deviceId: String) throws -> String {
        try doorChatDeleteJson(String.self, historyText: historyJSON, conversationId: conversationId, nowIso: now.formatted(Self.iso), deviceId: deviceId)
    }

    /// What a chat reply's edits come to against `recordJSON` (US-67): the engine parses
    /// the server's proposals, converts each from its stated unit and words the lines in
    /// `units` (the per-test choices). Nothing is written here.
    func chatEdits(recordJSON: String, edits: OpaqueJSON, now: Date, deviceId: String, today: String, units: String) throws -> ChatEditsPreview {
        let json = try doorChatEditsJson(recordJson: recordJSON, editsJson: edits.text, nowIso: now.formatted(Self.iso), deviceId: deviceId, today: today, unitsJson: units)
        return try JSONDecoder().decode(ChatEditsPreview.self, from: Data(json.utf8))
    }
}
