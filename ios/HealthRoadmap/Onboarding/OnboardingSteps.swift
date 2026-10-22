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
