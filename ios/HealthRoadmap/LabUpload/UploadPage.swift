import Foundation

/// health-core's UploadView (upload-view.ts) as the review page draws it (design PR 15, US-52 AC8c):
/// every word and count is the engine's. Swift decodes and draws; it computes nothing. Fields an
/// older engine may not send are optional, and the page draws without them.
struct UploadPage: Decodable, Equatable, Sendable {
    struct Progress: Decodable, Equatable, Sendable {
        let done: Int
        let total: Int
        let line: String
        let zip: String?
    }

    /// One read value: its test, the number and unit as printed, the extractor's question, a note
    /// when the unit was guessed, its own day (YYYY-MM-DD) when not the report's, the tick, and
    /// Replace (its word, its spoken name, the held row it corrects, and whether it is on).
    struct ValueRow: Decodable, Equatable, Sendable, Identifiable {
        let fileId: String
        let ref: String
        let label: String
        let value: String?
        let unit: String?
        let question: String?
        let unitNote: String?
        let day: String?
        /// The day it saves on, as the web writes dates; the held value it would replace.
        let dayLine: String?
        let held: String?
        let conflict: String?
        let ticked: Bool
        let error: String?
        let replace: String?
        let replaceLabel: String?
        let replaces: String?
        let replacing: Bool?
        /// An equal reading of this upload is on the same test and day: this one is not written and has no Replace.
        let copy: String?
        var id: String { "\(fileId):\(ref)" }
    }

    struct FileLine: Decodable, Equatable, Sendable, Identifiable {
        let fileId: String
        let name: String
        let line: String
        var id: String { "\(fileId):\(line)" }
    }

    /// A report with no full day: its picker opens from `choose`, and no day is assumed.
    struct Undated: Decodable, Equatable, Sendable {
        let fileId: String
        let title: String
        let label: String
        let name: String
        let choose: String?
        /// The day the person picked (YYYY-MM-DD): shown, to be changed.
        let chosen: String?
    }

    /// One section, in the order the view lists them. One this build does not know is `other`.
    enum Section: Decodable, Equatable, Sendable, Identifiable {
        case undated(Undated)
        case unsure(title: String, footer: String, rows: [ValueRow])
        case failed(title: String, rows: [FileLine], retry: String?)
        case notSaved(title: String, lines: [String], footer: String)
        case other

        /// Stable as files fill in, so a section's own controls keep their state.
        var id: String {
            switch self {
            case .undated(let undated): "undated:\(undated.fileId)"
            case .unsure: "unsure"
            case .failed: "failed"
            case .notSaved: "notSaved"
            case .other: "other"
            }
        }

        private enum Key: String, CodingKey { case kind, title, footer, rows, retry, lines }

        init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: Key.self)
            func text(_ key: Key) throws -> String { try c.decode(String.self, forKey: key) }
            switch try text(.kind) {
            case "undated": self = .undated(try Undated(from: decoder))
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
        let hide: String?
    }

    struct Document: Decodable, Equatable, Sendable, Identifiable {
        let fileId: String
        let title: String
        let kind: String
        let date: String
        let dateKnown: Bool
        /// The document type the kind choice sends, and the date as a calendar day.
        let kindKey: String?
        let day: String?
        var id: String { fileId }
    }

    struct Kind: Decodable, Equatable, Sendable, Identifiable {
        let key: String
        let word: String
        var id: String { key }
    }

    struct Documents: Decodable, Equatable, Sendable {
        let line: String
        let rows: [Document]
        let kinds: [Kind]?
        let setDate: String?
        let removeDate: String?
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
        /// Reviewed values another writer beat to their slot, in the web's words (US-12 AC6a).
        let skipped: [String]?
        /// Values the final commit refused (the record changed meanwhile), in the review's not-saved words.
        let notSaved: [String]?
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
    /// Values the record already holds, equal, counted ("2 already in your record").
    let alreadySaved: String?
    /// The machine's phase ("consent", "open", "saving", "saveFailed", "done", "failed"), a whole
    /// run's refusal, whether Close may leave, the word for Done, and the doors' words for a later
    /// call that answers nothing.
    let phase: String?
    let refused: String?
    let closeEnabled: Bool?
    let doneLabel: String?
    let engineError: String?
    /// The review's choices can be changed (not while saving).
    let editable: Bool?
    /// One value the page shows as to be written, opaque to the app: sent back on Save as drawn.
    struct Reviewed: Codable, Equatable, Sendable {
        let file: String
        let ref: String
        let lab: Bool
    }
    /// What this page would write (health-core `reviewedWrites`); nil from an older engine.
    let reviewed: [Reviewed]?

    /// The view's text decoded; nil when it does not read.
    static func decoded(_ text: String) -> UploadPage? {
        try? JSONDecoder().decode(UploadPage.self, from: Data(text.utf8))
    }

    /// The doors' engine-error words from a view that does not read as a whole, so the page never
    /// draws blank; nil when even those are not there.
    static func words(_ text: String) -> String? {
        struct Words: Decodable { let engineError: String }
        return try? JSONDecoder().decode(Words.self, from: Data(text.utf8)).engineError
    }
}

/// What a person does on the review page, as the engine's event (upload-flow.ts UploadEvent). The
/// page holds no rule: each tap is one event, and the engine decides what it changes.
enum UploadAction: Equatable, Sendable {
    case tick(fileId: String, ref: String, on: Bool)
    /// Replace on: the value saves as a correction of the held row `correctsId`; nil turns it off.
    case replace(fileId: String, ref: String, correctsId: String?)
    /// A report's day of the test, as a calendar day (YYYY-MM-DD).
    case testDay(fileId: String, day: String)
    case title(fileId: String, title: String)
    /// A document's kind, as the view's `kindKey`.
    case kind(fileId: String, key: String)
    /// A document's date, as a calendar day; nil removes it.
    case documentDate(fileId: String, day: String?)
    case retryAll
    case stop
    case save
    case close
    case discard

    /// Save, carrying what the page showed as to be written (the view's `reviewed`, untouched), so Save writes
    /// nothing else; nil from an older engine's view, when Save writes its own plan.
    static func saveEvent(promised: [UploadPage.Reviewed]?) -> String {
        guard let promised else { return EngineNatives.json(["type": "saveStarted"]) }
        return EngineNatives.json(["type": "saveStarted", "reviewed": promised.map { ["file": $0.file, "ref": $0.ref, "lab": $0.lab] as [String: Any] }])
    }

    /// The event's JSON; `now` stamps a choice (the engine refuses a document date in the future).
    func event(now: String) -> String {
        func chose(_ id: String, _ change: [String: Any]) -> String {
            EngineNatives.json(["type": "chose", "id": id, "change": change, "now": now])
        }
        switch self {
        case .tick(let id, let ref, let on): return chose(id, ["tick": ref, "on": on])
        case .replace(let id, let ref, let correctsId): return chose(id, ["replace": ref, "correctsId": correctsId as Any? ?? NSNull()])
        case .testDay(let id, let day): return chose(id, ["testDay": day])
        case .title(let id, let title): return chose(id, ["document": ["title": title]])
        case .kind(let id, let key): return chose(id, ["document": ["kind": key]])
        case .documentDate(let id, let day): return chose(id, ["document": ["date": day as Any? ?? NSNull()]])
        case .retryAll: return EngineNatives.json(["type": "retry", "id": "all"])
        case .stop: return EngineNatives.json(["type": "stop"])
        case .save: return EngineNatives.json(["type": "saveStarted"])
        case .close: return EngineNatives.json(["type": "close"])
        case .discard: return EngineNatives.json(["type": "discard"])
        }
    }
}
