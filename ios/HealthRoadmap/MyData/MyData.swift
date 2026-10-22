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
        /// A US height in feet and inches, by health-core's `cmToFeetInches`; nil in metric (AC17).
        let feetInches: FeetInches?
    }

    struct FeetInches: Decodable, Equatable, Hashable {
        let feet: Int
        let inches: Int
        var text: String { "\(feet) ft \(inches) in" }
    }

    /// The Vitals row that pairs systolic and diastolic (ios/engine/blood-pressure.ts).
    static let bloodPressure = "blood_pressure"

    /// One metric's row: the plan's current value, if there is one.
    struct Row: Decodable, Identifiable, Hashable {
        struct Latest: Decodable, Hashable {
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
    /// The record's erase count; nil from an engine older than US-54 AC7.
    let eraseEpoch: Int?
    let profile: Profile
    let vitals: [Row]
    let bloodTests: [Row]
    // US-25 AC8: health-core's form questions (FormModels.swift).
    let psa: Row
    let medications: [FormSection]
    let screenings: [FormSection]
    /// Why there are no screening questions; nil when there are.
    let screeningNote: String?
    let supplements: SupplementsView
    let months: ScreeningMonths
}

/// One change the My data tab asks for (`Edit` in ios/engine/my-data.ts).
/// Numbers are in the user's units; the engine stores SI.
enum RecordEdit: Encodable, Equatable {
    case profile(sex: String? = nil, birthYear: Int? = nil, birthMonth: Int? = nil, height: Double? = nil)
    /// A US height, whole feet and 0 to 11 inches; the engine converts it (AC17).
    case feetInches(feet: Int, inches: Int)
    /// Both halves for one day, or neither; `replace` corrects what the day holds and names
    /// the active rows the user saw (`seenIds`), so a change from elsewhere refuses it (AC17).
    case bloodPressure(systolic: Double, diastolic: Double, day: String, replace: Bool, seenIds: [String] = [])
    case units(String)
    /// A new value for a day, YYYY-MM-DD.
    case add(metric: String, value: Double, day: String)
    /// Replaces the value in row `id`: a FHIR correction, never a removal.
    case correct(id: String, value: Double)
    /// Readings from Apple Health; the engine decides what lands (US-25 AC13).
    case appleHealth([HealthSample])
    /// A medication, screening or supplement answer (FormModels.swift).
    case form(FormEdit)
    /// The ticked values of an uploaded lab report (US-52 AC8): the server's extraction
    /// as JSON text, the refs ticked, and the report's day.
    case labImport(extractionJSON: String, refs: [String], reportDay: String)

    private enum Key: String, CodingKey {
        case kind, sex, birthYear, birthMonth, height, heightFeet, heightInches, systolic, diastolic, replace, seenIds, unitSystem, metric, value, day, id, extractionJson, refs, reportDay, samples
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
        case .feetInches(let feet, let inches):
            try json.encode("profile", forKey: .kind)
            try json.encode(feet, forKey: .heightFeet)
            try json.encode(inches, forKey: .heightInches)
        case .bloodPressure(let systolic, let diastolic, let day, let replace, let seenIds):
            try json.encode("bloodPressure", forKey: .kind)
            try json.encode(systolic, forKey: .systolic)
            try json.encode(diastolic, forKey: .diastolic)
            try json.encode(day, forKey: .day)
            try json.encode(replace, forKey: .replace)
            if replace { try json.encode(seenIds, forKey: .seenIds) }
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
        case .form(let edit):
            try edit.encode(to: encoder)
        case .labImport(let extractionJSON, let refs, let reportDay):
            try json.encode("labImport", forKey: .kind)
            try json.encode(extractionJSON, forKey: .extractionJson)
            try json.encode(refs, forKey: .refs)
            try json.encode(reportDay, forKey: .reportDay)
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
    /// In the cloud (US-25 AC11): the erase the new record is at.
    var erase: String? = nil
}
