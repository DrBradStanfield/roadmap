import Foundation

/// The new-user flow (US-54): Apple Health, then four questions, then My plan.
/// Pure, so the rules are tested without screens (OnboardingStepsTests).
enum OnboardingStep: Int, CaseIterable, Comparable {
    case health, sex, birth, height, weight

    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    /// The four questions, for the progress bar.
    static let questions: [Self] = [.sex, .birth, .height, .weight]
}

enum OnboardingSteps {
    /// A record that lacks any of sex, birth year or height needs the flow (AC1).
    /// One that holds all three, an existing user's or a tester's, skips it.
    static func needsFlow(_ profile: MyData.Profile) -> Bool {
        profile.sex == nil || profile.birthYear == nil || profile.height == nil
    }

    /// The record was erased since the questions were finished, on this phone or any
    /// other (a higher erase count arrives through the cloud), and lost its answers:
    /// ask again (US-54 AC7, Brad 2026-10-22).
    static func erasedSince(_ onboardedEpoch: Int, epoch: Int?, profile: MyData.Profile) -> Bool {
        (epoch ?? 0) > onboardedEpoch && needsFlow(profile)
    }

    /// Where the flow starts. A first run starts at Apple Health; a resumed one
    /// (AC7), or one after "I already use Health Roadmap" (AC2), at the first
    /// question the record has not answered, else weight.
    static func start(_ profile: MyData.Profile, healthAsked: Bool) -> OnboardingStep {
        if !healthAsked { return .health }
        if profile.sex == nil { return .sex }
        if profile.birthYear == nil { return .birth }
        if profile.height == nil { return .height }
        return .weight
    }

    /// The step after `step`. After an "I already use it" connect only the
    /// missing questions are asked, weight included (AC2); a new user is offered weight last.
    static func next(after step: OnboardingStep, profile: MyData.Profile, hasWeight: Bool = false, onlyMissing: Bool) -> OnboardingStep? {
        for candidate in OnboardingStep.allCases where candidate > step {
            guard onlyMissing else { return candidate }
            switch candidate {
            case .health: continue
            case .sex where profile.sex != nil: continue
            case .birth where profile.birthYear != nil: continue
            case .height where profile.height != nil: continue
            case .weight where hasWeight: continue
            default: return candidate
            }
        }
        return nil
    }

    /// The unit choice to write for the phone's region (AC6): the US system for a US
    /// phone, metric for the rest. Only for a new record: never one with values, and
    /// never a record that came from the cloud (review R5). Nil: write nothing.
    static func regionUnits(hasValues: Bool, onlyMissing: Bool, current: String, system: Locale.MeasurementSystem) -> String? {
        guard !hasValues, !onlyMissing else { return nil }
        let units = system == .us ? "conventional" : "si"
        return units == current ? nil : units
    }
}

/// Sex and date of birth as Apple Health holds them (AC3), reduced to what the
/// record keeps: "female" or "male" (other or not set gives nothing) and the birth
/// month and year. The day of birth is never kept.
struct HealthCharacteristics: Equatable {
    var sex: String?
    var birthYear: Int?
    var birthMonth: Int?

    static let none = HealthCharacteristics()

    /// `sex` is HealthKit's biological sex as text ("female", "male", "other",
    /// "notSet"), so this stays free of HealthKit types for the tests.
    init(sex: String? = nil, birth: DateComponents? = nil) {
        self.sex = (sex == "female" || sex == "male") ? sex : nil
        if let year = birth?.year, let month = birth?.month, (1...12).contains(month) {
            birthYear = year
            birthMonth = month
        }
    }
}

/// A typed height or weight on its onboarding screen (US-54 AC6). Its unit switch is for
/// entry only: the box keeps its own text and units and never writes the record's, which
/// come from the region default and change in My data's Units row. Every conversion is the
/// engine's (`convertJson`, health-core's factors). Pure, so OnboardingStepsTests checks it.
struct TypedAnswer: Equatable {
    /// (value, metric, from, to): a value in the other units, "si" or "conventional".
    typealias Convert = (Double, String, String, String) -> HealthEngine.Conversion?

    /// "height" or "weight".
    let metric: String
    /// Centimetres, or the weight, as typed.
    var text = ""
    /// A US height's two boxes.
    var feet = ""
    var inches = ""
    var us = false
    /// The person typed here. A box filled from the record and left alone saves nothing,
    /// in any unit: compared by this, never by the text shown (Codex, adversary R1, R2).
    var edited = false

    static func system(_ us: Bool) -> String { us ? "conventional" : "si" }

    private var isHeight: Bool { metric == "height" }

    /// A US height as typed, nil until both read as whole numbers. Empty inches are 0:
    /// "5 ft" is a height.
    var feetInches: MyData.FeetInches? {
        guard let feet = Int(feet), let inches = inches.isEmpty ? 0 : Int(inches) else { return nil }
        return MyData.FeetInches(feet: feet, inches: inches)
    }

    /// The box's number in its own units (a US height in inches), nil until it reads as one.
    func value(read: (String) -> Double?) -> Double? {
        guard isHeight, us else { return read(text) }
        return feetInches.map { Double($0.feet * 12 + $0.inches) }
    }

    /// Shows `recorded`, the record's value in `recordUnits`, in the box's own units;
    /// empty boxes when there is none.
    mutating func show(_ recorded: Double?, recordUnits: String, convert: Convert) {
        let shown = recorded.flatMap { convert($0, metric, recordUnits, Self.system(us)) }
        fill(shown)
    }

    /// The other units. A box left alone shows the record's value again; a typed one is
    /// converted once, and stays the person's.
    mutating func switchUnits(toUS: Bool, recorded: Double?, recordUnits: String, read: (String) -> Double?, convert: Convert) {
        guard toUS != us else { return }
        let typed = edited ? value(read: read).flatMap { convert($0, metric, Self.system(us), Self.system(toUS)) } : nil
        us = toUS
        if !edited {
            show(recorded, recordUnits: recordUnits, convert: convert)
        } else if let typed {
            fill(typed)
        }
    }

    /// What to save, in `recordUnits` (the units the engine's edit reads), or nil when
    /// the person typed nothing here.
    func saved(recordUnits: String, read: (String) -> Double?, convert: Convert) -> Double? {
        guard edited, let typed = value(read: read) else { return nil }
        if Self.system(us) == recordUnits { return typed }
        return convert(typed, metric, Self.system(us), recordUnits)?.value
    }

    /// The typed value is `recorded` (in `recordUnits`) to within half the box's own step,
    /// 0.1 kg or a whole pound: compared in kilograms, never by the text shown (US-54 AC5).
    func repeats(_ recorded: Double?, recordUnits: String, read: (String) -> Double?, convert: Convert) -> Bool {
        guard let recorded, let typed = saved(recordUnits: "si", read: read, convert: convert),
              let kg = recordUnits == "si" ? recorded : convert(recorded, metric, recordUnits, "si")?.value,
              let halfStep = us ? convert(0.5, metric, "conventional", "si")?.value : 0.05 else { return false }
        return abs(typed - kg) < halfStep
    }

    private mutating func fill(_ shown: HealthEngine.Conversion?) {
        if isHeight, us {
            feet = shown?.feetInches.map { String($0.feet) } ?? ""
            inches = shown?.feetInches.map { String($0.inches) } ?? ""
        } else {
            text = shown?.text ?? ""
        }
    }
}
