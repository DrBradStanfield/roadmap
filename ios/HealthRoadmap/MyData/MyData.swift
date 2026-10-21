import Foundation

/// What the My data tab shows (US-25 AC5), as the engine writes it
/// (`MyData` in ios/engine/my-data.ts). Values are already in the user's units.
struct MyData: Decodable {
    struct Profile: Decodable {
        /// "male" or "female"
        let sex: String?
        let birthYear: Int?
        let birthMonth: Int?
        /// Height in the user's units, formatted by the engine.
        let height: String?
        let heightUnit: String
    }

    /// One metric's row: the plan's current value, if there is one.
    struct Row: Decodable, Identifiable {
        struct Latest: Decodable {
            /// The row id a correction names.
            let id: String
            let value: String
            /// YYYY-MM-DD
            let day: String
        }

        let metric: String
        let label: String
        let unit: String
        let latest: Latest?

        var id: String { metric }
    }

    /// "si" (metric) or "conventional" (US)
    let unitSystem: String
    let profile: Profile
    let vitals: [Row]
    let bloodTests: [Row]
}

/// One change the My data tab asks for (`Edit` in ios/engine/my-data.ts).
/// Numbers are in the user's units; the engine stores SI.
enum RecordEdit: Encodable, Equatable {
    case profile(sex: String? = nil, birthYear: Int? = nil, birthMonth: Int? = nil, height: Double? = nil)
    case units(String)
    /// A new value for a day, YYYY-MM-DD.
    case add(metric: String, value: Double, day: String)
    /// Replaces the value in row `id`: a FHIR correction, never a removal.
    case correct(id: String, value: Double)
    /// Readings from Apple Health; the engine decides what lands (US-25 AC8).
    case appleHealth([HealthSample])

    private enum Key: String, CodingKey {
        case kind, sex, birthYear, birthMonth, height, unitSystem, metric, value, day, id, samples
    }

    func encode(to encoder: Encoder) throws {
        var json = encoder.container(keyedBy: Key.self)
        switch self {
        case .profile(let sex, let birthYear, let birthMonth, let height):
            try json.encode("profile", forKey: .kind)
            try json.encodeIfPresent(sex, forKey: .sex)
            try json.encodeIfPresent(birthYear, forKey: .birthYear)
            try json.encodeIfPresent(birthMonth, forKey: .birthMonth)
            try json.encodeIfPresent(height, forKey: .height)
        case .units(let unitSystem):
            try json.encode("units", forKey: .kind)
            try json.encode(unitSystem, forKey: .unitSystem)
        case .add(let metric, let value, let day):
            try json.encode("add", forKey: .kind)
            try json.encode(metric, forKey: .metric)
            try json.encode(value, forKey: .value)
            try json.encode(day, forKey: .day)
        case .correct(let id, let value):
            try json.encode("correct", forKey: .kind)
            try json.encode(id, forKey: .id)
            try json.encode(value, forKey: .value)
        case .appleHealth(let samples):
            try json.encode("appleHealth", forKey: .kind)
            try json.encode(samples, forKey: .samples)
        }
    }
}

/// The engine's answer to an edit: the new record, or why it refused.
struct EditOutcome: Decodable {
    let ok: Bool
    /// The new record, as JSON text, when `ok`.
    let record: String?
    /// The engine's reason code, such as "out-of-range" or "slot-occupied".
    let reason: String?
    /// The engine's own words for a refusal.
    let message: String?
    /// On "slot-occupied": the row that already holds that day.
    let existingId: String?
}
