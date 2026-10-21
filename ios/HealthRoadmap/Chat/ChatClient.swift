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

    /// The chat context's largest size: years of dated values fit in far less.
    static let maxContextBytes = 512 * 1024

    /// The top-level keys health-core's `chatContextOf` produces (chat-context.ts): every
    /// `HealthInputs` field (types.ts) plus its own four. Anything else is dropped.
    /// ios/engine/chat-context-keys.test.ts fails if health-core's set drifts from this.
    static let contextKeys: Set<String> = [
        "heightCm", "weightKg", "waistCm", "sex", "birthYear", "birthMonth",
        "hba1c", "ldlC", "totalCholesterol", "hdlC", "triglycerides", "apoB", "creatinine", "psa", "lpa",
        "systolicBp", "diastolicBp", "unitSystem",
        "medications", "screenings", "measurementHistory",
    ]

    /// The engine's chat context was not the shape the server expects.
    struct ContextRefused: LocalizedError {
        var errorDescription: String? { "Your record could not be prepared for the chat." }
    }

    /// The request body, as JSON. `contextJSON` is the engine's `chatContextOf` output, embedded as it is.
    static func body(message: String, conversationId: String, history: [Turn], contextJSON: String) throws -> Data {
        // The engine can be updated over the air (US-25 AC18), so the one thing it hands
        // to our server is checked here: a JSON object with a unit system, under a cap,
        // and only the keys chatContextOf produces leave the phone (Codex R3).
        guard contextJSON.utf8.count <= maxContextBytes,
              let whole = try JSONSerialization.jsonObject(with: Data(contextJSON.utf8)) as? [String: Any],
              whole["unitSystem"] is String
        else { throw ContextRefused() }
        let context = whole.filter { contextKeys.contains($0.key) }
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
