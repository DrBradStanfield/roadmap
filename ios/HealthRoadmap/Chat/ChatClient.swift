import Foundation

/// Sends one question to the server's chat (US-52 AC5) and streams the answer back
/// as events. The body is what the web widget sends (widget-src/src/lib/chat-api.ts):
/// the question, the conversation's earlier turns, and the record's chat context.
struct ChatClient: Sendable {
    struct Turn: Encodable, Sendable {
        let role: String
        let content: String
    }

    var attest: AppAttestClient = .shared

    /// The request body, as JSON. `contextJSON` is the engine's `chatContextOf` output, embedded as it is.
    static func body(message: String, conversationId: String, history: [Turn], contextJSON: String) throws -> Data {
        let context = try JSONSerialization.jsonObject(with: Data(contextJSON.utf8))
        let turns = history.map { ["role": $0.role, "content": $0.content] }
        return try JSONSerialization.data(withJSONObject: [
            "message": message,
            "conversationId": conversationId,
            "history": turns,
            "guestInputs": context,
            "stream": true,
        ])
    }

    /// The answer's events, line by line. Ends after the `done` line.
    func ask(body: Data) -> AsyncThrowingStream<ChatStreamEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    let (bytes, _) = try await attest.post("/api/app/v1/chat", body: body)
                    for try await line in bytes.lines {
                        guard let event = ChatStreamEvent.parse(line) else { continue }
                        continuation.yield(event)
                        if case .done = event { break }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
