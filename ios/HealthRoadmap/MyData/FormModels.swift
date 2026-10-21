import Foundation

/// The medication and screening questions, as the engine describes them
/// (US-25 AC8). Each one is health-core's `input-form.ts`, the web form's own,
/// so the words, options and hints are never typed in Swift. The app renders
/// a section, sends back the answer, and the engine decides what is written.
struct FormSection: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    /// The lead paragraph: the web form's description under the card's title.
    let intro: String
    let groups: [FormGroup]
}

/// A block of questions under one heading (Colorectal, Lung…); untitled for a single drug.
struct FormGroup: Decodable, Identifiable, Equatable {
    let id: String
    let title: String
    /// Guidance lines, such as the age notes on screening.
    let notes: [String]
    let fields: [FormField]
}

struct FormOption: Decodable, Hashable {
    let value: String
    let label: String
    /// Shown only while it is the recorded value ("Not recorded", "Other (recorded)"); never pickable.
    let disabled: Bool?
}

/// One question. The engine's `kind` picks the control.
enum FormField: Decodable, Identifiable, Equatable {
    case choice(key: String, label: String, hint: String?, options: [FormOption], value: String)
    /// A month, YYYY-MM, past or future.
    case month(key: String, label: String, value: String, future: Bool)
    case number(key: String, label: String, hint: String?, value: String)
    /// A dated value kept as a measurement (PSA).
    case measurement(metric: String, label: String, hint: String?)

    var id: String {
        switch self {
        case .choice(let key, _, _, _, _), .month(let key, _, _, _), .number(let key, _, _, _): key
        case .measurement(let metric, _, _): "measurement:\(metric)"
        }
    }

    private enum Key: String, CodingKey { case kind, key, label, hint, options, value, when, metric }

    init(from decoder: Decoder) throws {
        let json = try decoder.container(keyedBy: Key.self)
        let label = try json.decode(String.self, forKey: .label)
        let hint = try json.decodeIfPresent(String.self, forKey: .hint)
        switch try json.decode(String.self, forKey: .kind) {
        case "choice":
            self = .choice(key: try json.decode(String.self, forKey: .key), label: label, hint: hint,
                           options: try json.decode([FormOption].self, forKey: .options), value: try json.decode(String.self, forKey: .value))
        case "month":
            self = .month(key: try json.decode(String.self, forKey: .key), label: label,
                          value: try json.decode(String.self, forKey: .value), future: try json.decode(String.self, forKey: .when) == "future")
        case "number":
            self = .number(key: try json.decode(String.self, forKey: .key), label: label, hint: hint, value: try json.decode(String.self, forKey: .value))
        default:
            self = .measurement(metric: try json.decode(String.self, forKey: .metric), label: label, hint: hint)
        }
    }
}

/// The supplements card (the web's renderSupplements).
struct SupplementsView: Decodable, Equatable {
    struct Row: Decodable, Identifiable, Equatable {
        let key: String
        let name: String
        let dose: Double?
        let unit: String?
        /// YYYY-MM-DD
        let startedDay: String
        var id: String { key }
    }

    /// One the user could add: featured ones are the web's quick-add chips.
    struct Choice: Decodable, Identifiable, Equatable {
        let key: String
        let name: String
        let featured: Bool
        let dose: Double?
        let unit: String?
        var id: String { key }
    }

    let intro: String
    let active: [Row]
    let stopped: [Row]
    let choices: [Choice]
    /// The dose units a row offers.
    let units: [String]
}

/// The months a screening date may name, YYYY-MM, oldest first.
struct ScreeningMonths: Decodable, Equatable {
    let past: [String]
    let future: [String]
}

/// Every value recorded for one metric, newest first (US-25 AC9).
struct MetricHistory: Decodable, Equatable {
    struct Row: Decodable, Identifiable, Equatable {
        let id: String
        let value: String
        /// YYYY-MM-DD
        let day: String
        /// "active" or "entered-in-error"
        let status: String
        /// The value the plan uses now.
        let current: Bool
        /// This row corrected an earlier one.
        let correction: Bool
        /// A blood pressure's halves; nil for a missing half or another metric (AC17).
        var systolic: String? = nil
        var diastolic: String? = nil
        /// A blood pressure's active row ids, sent back with a replace (AC17).
        var pairIds: [String]? = nil

        var isActive: Bool { status == "active" }
    }

    let metric: String
    let label: String
    let unit: String
    let rows: [Row]
    /// The plan set the current value aside (outside the range it accepts), so it does not use it.
    let excluded: Bool
}

/// An answer to a form question, or a supplement change (`FormEdit` and the
/// supplement edit in ios/engine/my-data.ts).
enum FormEdit: Encodable, Equatable {
    case medicationField(field: String, value: String)
    /// '' clears the answer.
    case screening(key: String, value: String)
    /// A supplement's current state; `stopped` is the soft stop, never a removal.
    case supplement(key: String, name: String, dose: Double?, unit: String?, stopped: Bool)
    /// A supplement typed by name; the engine makes its key.
    case customSupplement(name: String)

    private enum Key: String, CodingKey {
        case kind, field, value, key, supplementKey, supplementName, doseValue, doseUnit, status, name
    }

    func encode(to encoder: Encoder) throws {
        var json = encoder.container(keyedBy: Key.self)
        switch self {
        case .medicationField(let field, let value):
            try json.encode("medicationField", forKey: .kind)
            try json.encode(field, forKey: .field)
            try json.encode(value, forKey: .value)
        case .screening(let key, let value):
            try json.encode("screening", forKey: .kind)
            try json.encode(key, forKey: .key)
            try json.encode(value, forKey: .value)
        case .supplement(let key, let name, let dose, let unit, let stopped):
            try json.encode("supplement", forKey: .kind)
            try json.encode(key, forKey: .supplementKey)
            try json.encode(name, forKey: .supplementName)
            try json.encode(dose, forKey: .doseValue)
            try json.encode(unit, forKey: .doseUnit)
            try json.encode(stopped ? "stopped" : "active", forKey: .status)
        case .customSupplement(let name):
            try json.encode("customSupplement", forKey: .kind)
            try json.encode(name, forKey: .name)
        }
    }
}
