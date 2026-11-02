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
    /// The final reply: the whole answer, which replaces what streamed. `edits`: the
    /// server's `proposedEdits` (US-67), as received; the engine alone reads them.
    case done(content: String?, isFallback: Bool, error: String?, edits: OpaqueJSON? = nil)
    /// A line this app does not use (thinking, and anything newer): skipped.
    case other

    /// Reads one line; nil if it is not JSON with a `type`.
    static func parse(_ line: String) -> ChatStreamEvent? {
        guard let data = line.data(using: .utf8),
              let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = object["type"] as? String ?? (object["success"] != nil ? "done" : nil)
        else { return nil }
        // With CHAT_STREAMING=false the server answers one JSON reply with no type: read it as `done`.
        switch type {
        case "status": return .status(object["text"] as? String ?? "")
        case "text": return .text(object["text"] as? String ?? "")
        case "sources": return .sources((object["titles"] as? [Any] ?? []).compactMap { $0 as? String })
        case "done":
            let success = object["success"] as? Bool ?? false
            return .done(
                content: success ? object["content"] as? String : nil,
                isFallback: object["isFallback"] as? Bool ?? false,
                error: success ? nil : (object["error"] as? String ?? "The answer could not be finished."),
                edits: success ? OpaqueJSON.list(object["proposedEdits"]) : nil
            )
        default: return .other
        }
    }
}

/// JSON carried and never read (US-67): the server's chat proposals and the engine's own
/// Undo edit pass through Swift as they came. The engine alone parses, converts and checks
/// them; Swift never interprets an edit's values.
indirect enum OpaqueJSON: Codable, Equatable, Sendable {
    case null, bool(Bool), number(Double), string(String), array([OpaqueJSON]), object([String: OpaqueJSON])

    /// A non-empty JSON array from a parsed reply, else nil.
    static func list(_ value: Any?) -> OpaqueJSON? {
        guard let items = value as? [Any], !items.isEmpty,
              let data = try? JSONSerialization.data(withJSONObject: items) else { return nil }
        return try? JSONDecoder().decode(OpaqueJSON.self, from: data)
    }

    /// As JSON text, for an engine door.
    var text: String { String(decoding: (try? JSONEncoder().encode(self)) ?? Data("null".utf8), as: UTF8.self) }

    init(from decoder: Decoder) throws {
        let value = try decoder.singleValueContainer()
        if value.decodeNil() { self = .null }
        else if let flag = try? value.decode(Bool.self) { self = .bool(flag) }
        else if let number = try? value.decode(Double.self) { self = .number(number) }
        else if let string = try? value.decode(String.self) { self = .string(string) }
        else if let items = try? value.decode([OpaqueJSON].self) { self = .array(items) }
        else { self = .object(try value.decode([String: OpaqueJSON].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var value = encoder.singleValueContainer()
        switch self {
        case .null: try value.encodeNil()
        case .bool(let flag): try value.encode(flag)
        case .number(let number): try value.encode(number)
        case .string(let string): try value.encode(string)
        case .array(let items): try value.encode(items)
        case .object(let fields): try value.encode(fields)
        }
    }
}

/// What a chat reply's edits come to, from the engine's `chatEditsJson` (US-67 AC3): the
/// medication part, written at once with its Undo, and the part that waits for Save. Each
/// line is the engine's own words, in the person's units.
struct ChatEditsPreview: Decodable, Equatable, Sendable {
    struct Line: Decodable, Equatable, Sendable {
        let text: String
        /// The value it replaces, as the engine words it; nil for a new one.
        let replaces: String?

        init(text: String, replaces: String? = nil) {
            self.text = text
            self.replaces = replaces
        }
    }

    struct Medications: Decodable, Equatable, Sendable {
        let lines: [Line]
        /// The edit that puts the medications back, passed back to the engine as it came.
        let undo: OpaqueJSON
    }

    struct Review: Decodable, Equatable, Sendable {
        let lines: [Line]
        /// Why none of it can be saved, in the engine's words; then there is no Save.
        let refusal: String?
        /// What the preview was made against, passed back on Save as it came; absent from an older engine.
        let seen: OpaqueJSON?
    }

    let medications: Medications?
    let review: Review?
}
