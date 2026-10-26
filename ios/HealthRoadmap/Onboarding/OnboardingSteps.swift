import Foundation

/// The new-user flow (US-54): Apple Health, then four questions, less those Health
/// answered, which the last step lists (AC3b), then My plan.
/// Pure, so the rules are tested without screens (OnboardingStepsTests).
enum OnboardingStep: Int, CaseIterable, Comparable {
    case health, sex, birth, height, weight, review

    static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }

    /// The four questions, for the progress bar.
    static let questions: [Self] = [.sex, .birth, .height, .weight]

    /// A question's name, as VoiceOver reads it on the summary (AC3b).
    var name: String {
        switch self {
        case .sex: "Sex"
        case .birth: "Birth month and year"
        case .height: "Height"
        case .weight: "Weight"
        case .health, .review: ""
        }
    }
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
    /// The summary comes back when Health supplied answers (`skip`, AC3b) and the record holds a
    /// weight from the last year, from Health or typed (Codex R1); a stale one is asked again.
    static func start(_ profile: MyData.Profile, healthAsked: Bool, skip: Set<OnboardingStep> = [],
                      weightDay: String? = nil, now: Date = .now, calendar: Calendar = .current) -> OnboardingStep {
        if !healthAsked { return .health }
        if profile.sex == nil { return .sex }
        if profile.birthYear == nil { return .birth }
        if profile.height == nil { return .height }
        return !skip.isEmpty && fresh(weightDay, now: now, calendar: calendar) ? .review : .weight
    }

    /// A weight day within the last year (AC3b, guard a).
    static func fresh(_ day: String?, now: Date, calendar: Calendar) -> Bool {
        let yearAgo = calendar.date(byAdding: .year, value: -1, to: now).map { DayText.iso($0, calendar: calendar) } ?? ""
        return day.map { $0 >= yearAgo } ?? false
    }

    /// The step after `step`. After an "I already use it" connect only the
    /// missing questions are asked, weight included (AC2); a new user is offered weight last.
    /// `skip`: what Apple Health supplied (AC3b), not asked; the summary of it comes last,
    /// and only when there is one.
    static func next(after step: OnboardingStep, profile: MyData.Profile, hasWeight: Bool = false, onlyMissing: Bool,
                     skip: Set<OnboardingStep> = []) -> OnboardingStep? {
        for candidate in OnboardingStep.allCases where candidate > step && !skip.contains(candidate) {
            if candidate == .review { return skip.isEmpty ? nil : .review }
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

    /// Back: the step before `step`, leaving out what Health supplied (AC3b) and, after a
    /// cloud connect, the Apple Health page (AC2).
    static func previous(before step: OnboardingStep, onlyMissing: Bool, skip: Set<OnboardingStep>) -> OnboardingStep? {
        OnboardingStep.allCases.last { $0 < step && !skip.contains($0) && !(onlyMissing && $0 == .health) }
    }

    /// What Apple Health supplied (AC3b): the steps it filled in that the record still holds,
    /// less a weight whose newest day is more than a year before today (guard a), which is
    /// asked again. Worked out from the record each time, so a relaunch keeps it (adversary R2).
    static func supplied(fromHealth: Set<OnboardingStep>, profile: MyData.Profile, weightDay: String?, now: Date, calendar: Calendar = .current) -> Set<OnboardingStep> {
        let held: [OnboardingStep: Bool] = [.sex: profile.sex != nil, .birth: profile.birthYear != nil, .height: profile.height != nil,
                                            .weight: fresh(weightDay, now: now, calendar: calendar)]
        return fromHealth.filter { held[$0] == true }
    }

    /// The steps Apple Health filled in, kept as their names only, never a value (adversary R2).
    static func encode(_ steps: Set<OnboardingStep>) -> String { steps.map { String($0.rawValue) }.sorted().joined(separator: ",") }
    static func decode(_ text: String) -> Set<OnboardingStep> {
        Set(text.split(separator: ",").compactMap { Int($0).flatMap(OnboardingStep.init(rawValue:)) }.filter(OnboardingStep.questions.contains))
    }

    /// Health's sex and birth month and year as one profile edit, only what the record lacks
    /// (AC3b, AC5); nil when there is nothing to save.
    static func healthEdit(_ given: HealthCharacteristics, profile: MyData.Profile) -> RecordEdit? {
        let sex = profile.sex == nil ? given.sex : nil
        let birth = profile.birthYear == nil ? given.birthYear : nil
        guard sex != nil || birth != nil else { return nil }
        return .profile(sex: sex, birthYear: birth, birthMonth: birth == nil ? nil : given.birthMonth)
    }

    /// Health's year-old weight, confirmed in onboarding, as today's Apple Health reading
    /// (AC3b, orchestrator 2026-10-26): an `apple_health` row, so it is never written back.
    static func confirmedWeight(kilograms: Double, now: Date, timeZone: TimeZone = .current) -> RecordEdit {
        .appleHealth([HealthSample(id: UUID(), metric: "weight", value: kilograms, at: now, timeZone: timeZone)])
    }

    /// A row's stored value, in SI (kilograms for weight), from the record itself: the
    /// screens' values are rounded for display, so 72.57 kg would come back as 160 lb.
    static func kilograms(rowId: String, recordJSON: String) -> Double? {
        EngineSelfTest.rows(recordJSON, "measurements")?.first { $0["id"] as? String == rowId }?["value"] as? Double
    }

    /// What VoiceOver reads for a summary line: its name, then the answer, a US height in words.
    static func spoken(_ step: OnboardingStep, text: String, profile: MyData.Profile) -> String {
        let words = step == .height ? profile.feetInches.map { "\($0.feet) feet \($0.inches) inches" } : nil
        return "\(step.name), \(words ?? text)"
    }

    /// A summary line (AC3b): the record's answer in its own words and units.
    static func summary(_ step: OnboardingStep, profile: MyData.Profile, weight: (value: String, unit: String)?) -> String? {
        switch step {
        case .sex: profile.sex.map(MyData.sexLabel)
        case .birth: profile.birthYear.map { year in profile.birthMonth.map { "Born \(DayText.monthName($0)) \(year)" } ?? "Born \(year)" }
        case .height: profile.feetInches?.text ?? profile.height.map { "\($0) \(profile.heightUnit)" }
        case .weight: weight.map { "\($0.value) \($0.unit)" }
        case .health, .review: nil
        }
    }

    /// The unit choice to write for the phone's region (AC6): the US system for a US
    /// phone, metric for the rest. Only for a new record: never one with values, and
    /// never a record that came from the cloud (review R5). Nil: write nothing.
    static func regionUnits(hasValues: Bool, onlyMissing: Bool, current: String, system: Locale.MeasurementSystem) -> String? {
        guard !hasValues, !onlyMissing else { return nil }
        let units = TypedAnswer.system(system == .us)
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
