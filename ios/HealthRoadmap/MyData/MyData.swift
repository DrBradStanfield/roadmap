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
        /// "Do you drink alcohol?" (US-60); nil when not answered, from an older engine, or
        /// unreadable. Read leniently, so a value this app does not know never hides My data.
        var alcohol: Lenient<Alcohol>? = nil
    }

    /// The answer to "Do you drink alcohol?" (US-60), as the record stores it.
    enum Alcohol: String, Decodable, Sendable, CaseIterable {
        case noDrinking = "none"
        case drinks

        var label: String { self == .noDrinking ? "I don't drink" : "I drink" }
    }

    struct FeetInches: Decodable, Equatable, Hashable {
        let feet: Int
        let inches: Int
        var text: String { "\(feet) ft \(inches) in" }
    }

    /// "female" or "male" as the screens write it.
    static func sexLabel(_ sex: String) -> String { sex == "female" ? "Female" : "Male" }

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
        /// The newest days' values, oldest first, in the user's units (AC17d); nil from an older engine.
        let trend: [Double]?
        /// Whether this test has its own Metric/US choice (AC17e); nil from an older engine.
        let switchable: Bool?

        var id: String { metric }
    }

    /// "si" (metric) or "conventional" (US)
    let unitSystem: String
    /// Lp(a)'s unit, "nmol/L", "mg/dL" or "mg/L": the record's choice, as the web's control
    /// (US-05 AC2); nil from an older engine.
    let lpaUnit: String?
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
    /// The "about this measure" guides (US-58), by metric or medication key; nil from an older engine.
    let guides: MetricGuides?
    /// The VO2 max bands' row for the person's sex and age today (US-56 AC8); nil from an older
    /// engine, without sex or birth year, or outside 20 to 89. Read leniently.
    let vo2Bands: Lenient<Vo2MaxBands>?
    /// Each metric's input range by unit ("si", "conventional", Lp(a)'s own), what a typed
    /// "1,234" is read against (US-02 AC7); nil from an older engine. Read leniently.
    let inputRanges: Lenient<[String: [String: InputRange]]>?

    struct InputRange: Decodable, Sendable {
        let min: Double
        let max: Double
    }

    /// The range a value typed for `metric` in `unit` is read against; nil when unknown.
    func inputRange(_ metric: String, _ unit: String) -> ClosedRange<Double>? {
        inputRanges?.value?[metric]?[unit].flatMap { $0.min <= $0.max ? $0.min...$0.max : nil }
    }
}

/// The guides by key, read leniently (US-58 AC3): a malformed guide is left out, and a
/// malformed map reads as none, so a bad over-the-air guide never blanks My data.
struct MetricGuides: Decodable {
    private let byKey: [String: MetricGuide]

    init(_ byKey: [String: MetricGuide]) { self.byKey = byKey }

    init(from decoder: Decoder) throws {
        guard let json = try? decoder.container(keyedBy: AnyKey.self) else { byKey = [:]; return }
        var read: [String: MetricGuide] = [:]
        for key in json.allKeys {
            if let guide = try? json.decode(MetricGuide.self, forKey: key) { read[key.stringValue] = guide }
        }
        byKey = read
    }

    subscript(key: String) -> MetricGuide? { byKey[key] }
    var keys: Set<String> { Set(byKey.keys) }

    private struct AnyKey: CodingKey {
        let stringValue: String
        var intValue: Int? { nil }
        init?(stringValue: String) { self.stringValue = stringValue }
        init?(intValue: Int) { nil }
    }
}

/// One "about this measure" guide (US-58): health-core's METRIC_GUIDES, served by the engine,
/// so the words are never typed in Swift.
struct MetricGuide: Decodable {
    struct HowTo: Decodable {
        /// "How to measure", "How to prepare" or "How it works and side effects".
        let heading: String
        let points: [String]
    }

    let title: String
    let whatItIs: String
    let whyItMatters: String
    let howTo: HowTo
    /// evidence.ts's own references, each a DOI or stable URL.
    let sources: [Suggestion.Reference]

    /// A source's link: https only (US-58 AC4); any other scheme shows as plain text.
    static func link(_ source: Suggestion.Reference) -> URL? {
        source.url.scheme?.lowercased() == "https" ? source.url : nil
    }
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
    /// "Do you drink alcohol?" (US-60); nil is "Not answered", which clears it.
    case alcohol(MyData.Alcohol?)
    /// Lp(a)'s unit, written to the record as the web's three-unit control writes it (US-05 AC2).
    case lpaUnit(String)
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
        case kind, alcohol, sex, birthYear, birthMonth, height, heightFeet, heightInches, systolic, diastolic, replace, seenIds, unitSystem, unit, metric, value, day, id, extractionJson, refs, reportDay, samples
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
        case .alcohol(let answer):
            try json.encode("alcohol", forKey: .kind)
            try json.encode(answer?.rawValue, forKey: .alcohol)
        case .lpaUnit(let unit):
            try json.encode("lpaUnit", forKey: .kind)
            try json.encode(unit, forKey: .unit)
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
    /// In the cloud: the engine's stamp, set in Swift (`HealthEngine.stamp`).
    var order: Int? = nil
}
