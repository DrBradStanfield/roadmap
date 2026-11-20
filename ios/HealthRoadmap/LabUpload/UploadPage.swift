import Foundation

/// health-core's UploadView (upload-view.ts) as the review page draws it (design PR 15, US-52 AC8c):
/// every word and count is the engine's. Swift decodes and draws; it computes nothing.
struct UploadPage: Decodable, Equatable, Sendable {
    struct Progress: Decodable, Equatable, Sendable {
        let done: Int
        let total: Int
        let line: String
        let zip: String?
    }

    struct ValueRow: Decodable, Equatable, Sendable, Identifiable {
        let fileId: String
        let ref: String
        let label: String
        let conflict: String?
        let ticked: Bool
        let error: String?
        var id: String { "\(fileId):\(ref)" }
    }

    struct FileLine: Decodable, Equatable, Sendable, Identifiable {
        let fileId: String
        let name: String
        let line: String
        var id: String { "\(fileId):\(line)" }
    }

    /// One section, in the order the view lists them. One this build does not know is `other`.
    enum Section: Decodable, Equatable, Sendable, Identifiable {
        case undated(fileId: String, title: String, label: String, name: String)
        case unsure(title: String, footer: String, rows: [ValueRow])
        case failed(title: String, rows: [FileLine], retry: String?)
        case notSaved(title: String, lines: [String], footer: String)
        case other

        /// Stable as files fill in, so a section's own controls keep their state.
        var id: String {
            switch self {
            case .undated(let fileId, _, _, _): "undated:\(fileId)"
            case .unsure: "unsure"
            case .failed: "failed"
            case .notSaved: "notSaved"
            case .other: "other"
            }
        }

        private enum Key: String, CodingKey { case kind, fileId, title, label, name, footer, rows, retry, lines }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            func text(_ key: Key) throws -> String { try c.decode(String.self, forKey: key) }
            switch try text(.kind) {
            case "undated": self = .undated(fileId: try text(.fileId), title: try text(.title), label: try text(.label), name: try text(.name))
            case "unsure": self = .unsure(title: try text(.title), footer: try text(.footer), rows: try c.decode([ValueRow].self, forKey: .rows))
            case "failed": self = .failed(title: try text(.title), rows: try c.decode([FileLine].self, forKey: .rows), retry: try c.decodeIfPresent(String.self, forKey: .retry))
            case "notSaved": self = .notSaved(title: try text(.title), lines: try c.decode([String].self, forKey: .lines), footer: try text(.footer))
            default: self = .other
            }
        }
    }

    struct Sure: Decodable, Equatable, Sendable {
        let line: String
        let showAll: String
        let rows: [ValueRow]
    }

    struct Document: Decodable, Equatable, Sendable, Identifiable {
        let fileId: String
        let title: String
        let kind: String
        let date: String
        let dateKnown: Bool
        var id: String { fileId }
    }

    struct Documents: Decodable, Equatable, Sendable {
        let line: String
        let rows: [Document]
    }

    struct FileRow: Decodable, Equatable, Sendable, Identifiable {
        let fileId: String
        let name: String
        let status: String
        var id: String { fileId }
    }

    struct Files: Decodable, Equatable, Sendable {
        let row: String
        let rows: [FileRow]
    }

    struct Save: Decodable, Equatable, Sendable {
        let label: String
        let enabled: Bool
        let why: String?
        let error: String?
    }

    struct Stop: Decodable, Equatable, Sendable { let label: String }

    struct Done: Decodable, Equatable, Sendable {
        let line: String
        let archived: String?
        let unstored: String?
    }

    let progress: Progress?
    let summary: String
    let sections: [Section]
    let sure: Sure?
    let documents: Documents?
    let files: Files
    let notices: [FileLine]
    let save: Save
    let stop: Stop?
    let done: Done?

    /// The view's text decoded; nil when it does not read.
    static func decoded(_ text: String) -> UploadPage? {
        try? JSONDecoder().decode(UploadPage.self, from: Data(text.utf8))
    }
}

/// What a person does on the review page, as the engine's event (upload-flow.ts UploadEvent). The
/// page holds no rule: each tap is one event, and the engine decides what it changes.
enum UploadAction: Equatable, Sendable {
    case tick(fileId: String, ref: String, on: Bool)
    /// A report's day of the test, as a calendar day (YYYY-MM-DD).
    case testDay(fileId: String, day: String)
    case title(fileId: String, title: String)
    /// A document's date, as a calendar day.
    case documentDate(fileId: String, day: String)
    case retryAll
    case stop
    case save
    case close
    case discard

    /// The event's JSON; `now` stamps a choice (the engine refuses a document date in the future).
    func event(now: String) -> String {
        func chose(_ id: String, _ change: [String: Any]) -> String {
            EngineNatives.json(["type": "chose", "id": id, "change": change, "now": now])
        }
        switch self {
        case .tick(let id, let ref, let on): return chose(id, ["tick": ref, "on": on])
        case .testDay(let id, let day): return chose(id, ["testDay": day])
        case .title(let id, let title): return chose(id, ["document": ["title": title]])
        case .documentDate(let id, let day): return chose(id, ["document": ["date": day]])
        case .retryAll: return EngineNatives.json(["type": "retry", "id": "all"])
        case .stop: return EngineNatives.json(["type": "stop"])
        case .save: return EngineNatives.json(["type": "saveStarted"])
        case .close: return EngineNatives.json(["type": "close"])
        case .discard: return EngineNatives.json(["type": "discard"])
        }
    }
}
