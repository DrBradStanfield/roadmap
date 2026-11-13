import Foundation

/// My health's rows and forms (US-25 AC5, US-73), as the engine writes it
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

    /// A US height, whole feet and inches: generated (HeightFeetInches, Engine/Generated).
    typealias FeetInches = HeightFeetInches

    /// A value's grade, as the engine words it (health-core's GradeStatus).
    enum Grade: String, Decodable, Sendable {
        case ok, warn, bad
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
        /// The target the value is read against, as the web's row prints it under the name
        /// ("Optimal <1.4"; health-core's rowTarget, US-62 AC9); nil when none, or from an older engine.
        var target: String? = nil
        /// The value before the latest, in the same units, shown in brackets (US-62 AC8); nil
        /// with one reading, or from an older engine.
        var previous: String? = nil
        /// The value's grade, as the web's row colours it (health-core's valueStatus, US-62 AC8):
        /// "warn" amber, "bad" red, "ok" plain; nil when ungraded, or from an older engine.
        var status: String? = nil
        /// `status` as a grade; nil for an unknown word from a newer engine, so it never blanks My data.
        var grade: Grade? { status.flatMap(Grade.init(rawValue:)) }
        /// The grade as VoiceOver says it after an off-target value ("above optimal", health-core's
        /// gradeWords); nil on target, ungraded, or from an older engine.
        var gradeWords: String? = nil
        /// "Printed as a limit, so the plan cannot grade it against its cutoff.": a latest value printed
        /// as a limit the rule leaves ungraded (US-12 AC21), said where the grade would be; nil otherwise,
        /// or from an older engine.
        var note: String? = nil

        /// "lab" on a lab test's row (US-25 AC25): its page, history and adds are the lab test's,
        /// whatever its name ("Weight" filed as a lab test is no core weight). Nil on a core row.
        var series: String? = nil

        /// Distinct for a lab test named like a core metric: "lab:weight" beside "weight".
        var id: String { series.map { "\($0):\(metric)" } ?? metric }
    }

    /// "si" (metric) or "conventional" (US)
    let unitSystem: String
    /// Lp(a)'s unit, "nmol/L", "mg/dL" or "mg/L": the record's choice, as the web's control
    /// (US-05 AC2); nil from an older engine.
    let lpaUnit: String?
    /// The record's erase count; nil from an engine older than US-54 AC7.
    let eraseEpoch: Int?
    /// US-65: how many entries the engine could not read and kept unchanged, as one line;
    /// nil when there are none, or from an older engine.
    var unreadableNote: String? = nil
    let profile: Profile
    let vitals: [Row]
    let bloodTests: [Row]
    // US-25 AC8: health-core's form questions (FormModels.swift).
    let psa: Row
    /// The lab tests beyond the core ones, one row per series, as the web's Blood tests rows list
    /// them (US-62 AC8): `metric` is the series key; nil from an older engine.
    var labTests: [Row]? = nil
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
    /// The letters and scan results listed at the foot of My health (US-73 AC12); nil from an
    /// older engine, which lists none. Read leniently, so a bad list never blanks My data.
    var documents: Lenient<Documents>? = nil

    /// The engine's `documentShelf` (ios/engine/documents.ts): scan results, then letters and
    /// every other document, each newest first; never a lab report's archive row.
    /// Read row by row: a row this app cannot read drops only itself (review R1).
    struct Documents: Decodable, Sendable {
        let scans: [Document]
        let others: [Document]
        var isEmpty: Bool { scans.isEmpty && others.isEmpty }

        private enum CodingKeys: String, CodingKey { case scans, others }

        init(from decoder: Decoder) throws {
            let list = try decoder.container(keyedBy: CodingKeys.self)
            scans = (try? list.decode([Lenient<Document>].self, forKey: .scans))?.compactMap(\.value) ?? []
            others = (try? list.decode([Lenient<Document>].self, forKey: .others))?.compactMap(\.value) ?? []
        }
    }

    struct Document: Decodable, Sendable, Identifiable, Hashable {
        struct Original: Decodable, Sendable, Hashable {
            /// The file's name in the cloud, "2026-09-14 Cardiology follow-up.pdf".
            let name: String
            let mimeType: String
        }

        let id: String
        let title: String
        /// "Clinic Letter", as the web's badge says it.
        let typeLabel: String
        /// YYYY-MM-DD; nil when the document gave none.
        let day: String?
        /// The extracted markdown.
        let content: String
        let sourceFileName: String?
        /// The original in the person's cloud; nil for a text-only row.
        let original: Original?

        /// The day as the row shows it, kept on one line (at large text "14 / Sep 2026" broke
        /// mid-date), or the web's "Date unknown".
        var dayText: String { day.map { DayText.short($0).replacingOccurrences(of: " ", with: "\u{00A0}") } ?? "Date unknown" }
    }

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
    /// Replaces the value in row `id`: a FHIR correction, never a removal. A lab value's too,
    /// in the unit its row is stored in (US-25 AC25).
    case correct(id: String, value: Double)
    /// A lab value's correction (US-25 AC25): the engine's `correct`, in the unit its row is stored
    /// in, so the record's units never refuse it (review R7).
    case labCorrect(id: String, value: Double)
    /// A new value for a lab test the record holds, by its series key, in the unit the sheet showed,
    /// on a day, YYYY-MM-DD: health-core's lab add, the web's too (US-25 AC25).
    case labAdd(series: String, value: Double, day: String, unit: String)
    /// A value for any blood test by name (US-73 AC8), the add sheet's: the engine finds a core or
    /// catalogue test by the name or keeps a new one in `unit`, as the web's general add does.
    case labAddName(name: String, value: Double, day: String, unit: String)
    /// Readings from Apple Health; the engine decides what lands (US-25 AC13).
    case appleHealth([HealthSample])
    /// Lab results from Health Records, as they came; the engine decides what lands (US-72).
    case healthRecords([HealthRecord])
    /// A medication, screening or supplement answer (FormModels.swift).
    case form(FormEdit)
    /// The ticked values of an uploaded lab report (US-52 AC8): the server's extraction
    /// as JSON text, the refs ticked, and the report's day.
    case labImport(extractionJSON: String, refs: [String], reportDay: String)
    /// A chat reply's edits (US-67): the server's proposals as received, never read here, and
    /// the phone's local day. The engine parses, converts and writes `part` of them. `seen`:
    /// the review preview's own token, passed back on Save as it came (nil: none).
    case chatEdits(part: ChatEditPart, edits: OpaqueJSON, today: String, seen: OpaqueJSON? = nil)
    /// An edit the engine made itself (a chat medication change's Undo), passed back as it came.
    case engineEdit(OpaqueJSON)

    /// Which part of a chat reply's edits an edit writes (US-67 AC3).
    enum ChatEditPart: String {
        /// Saved at once, with Undo, as on the web.
        case medications
        /// Values, height and sex: saved only on Save.
        case review
    }

    /// A new birth year. A stored month that would then be in the future moves back to the
    /// latest one in the same edit, as onboarding's wheel does (US-54 AC5b, review R4).
    static func birthYear(_ year: Int, storedMonth: Int?, now: Date) -> RecordEdit {
        let latest = DayText.latestBirthMonth(year: year, now: now)
        guard let storedMonth, storedMonth > latest else { return .profile(birthYear: year) }
        return .profile(birthYear: year, birthMonth: latest)
    }

    /// The wire edit (Engine/Generated/EngineContract.swift), generated from ios/engine/contract.ts.
    func encode(to encoder: Encoder) throws {
        switch self {
        // The engine's own edit is its JSON exactly, passed back as it came.
        case .engineEdit(let edit): try edit.encode(to: encoder)
        case .profile(let sex, let birthYear, let birthMonth, let height):
            try EngineEdit.profile(sex: sex, birthYear: birthYear.map(Double.init), birthMonth: birthMonth.map(Double.init), height: height).encode(to: encoder)
        case .feetInches(let feet, let inches):
            try EngineEdit.profile(heightFeet: Double(feet), heightInches: Double(inches)).encode(to: encoder)
        case .bloodPressure(let systolic, let diastolic, let day, let replace, let seenIds):
            try EngineEdit.bloodPressure(systolic: systolic, diastolic: diastolic, day: day, replace: replace, seenIds: replace ? seenIds : nil).encode(to: encoder)
        case .units(let unitSystem): try EngineEdit.units(unitSystem: unitSystem).encode(to: encoder)
        case .alcohol(let answer): try EngineEdit.alcohol(alcohol: answer?.rawValue).encode(to: encoder)
        case .lpaUnit(let unit): try EngineEdit.lpaUnit(unit: unit).encode(to: encoder)
        case .add(let metric, let value, let day): try EngineEdit.add(metric: metric, value: value, day: day).encode(to: encoder)
        case .correct(let id, let value), .labCorrect(let id, let value): try EngineEdit.correct(id: id, value: value).encode(to: encoder)
        case .labAdd(let series, let value, let day, let unit): try EngineEdit.labAdd(series: series, value: value, day: day, unit: unit).encode(to: encoder)
        // The engine's labAddName. The one place that builds it.
        case .labAddName(let name, let value, let day, let unit): try EngineEdit.labAddName(name: name, value: value, unit: unit, day: day).encode(to: encoder)
        case .appleHealth(let samples): try EngineEdit.appleHealth(samples: samples).encode(to: encoder)
        case .healthRecords(let records): try EngineEdit.healthRecords(records: records).encode(to: encoder)
        case .form(let edit): try edit.wire.encode(to: encoder)
        case .labImport(let extractionJSON, let refs, let reportDay):
            try EngineEdit.labImport(extractionJson: extractionJSON, refs: refs, reportDay: reportDay).encode(to: encoder)
        case .chatEdits(let part, let edits, let today, let seen):
            try EngineEdit.chatEdits(part: part.rawValue, edits: edits, today: today, seen: seen).encode(to: encoder)
        }
    }
}

extension HeightFeetInches {
    var text: String { "\(feet) ft \(inches) in" }
}

// EditOutcome, the engine's answer to an edit, is generated (Engine/Generated/EngineContract.swift).
