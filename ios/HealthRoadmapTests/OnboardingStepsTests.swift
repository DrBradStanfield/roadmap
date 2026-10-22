import XCTest
@testable import HealthRoadmap

/// US-54: which questions a record needs, where the flow starts and resumes, and
/// what Apple Health's sex and date of birth become.
final class OnboardingStepsTests: XCTestCase {
    private func profile(sex: String? = nil, year: Int? = nil, month: Int? = nil, height: String? = nil) -> MyData.Profile {
        MyData.Profile(sex: sex, birthYear: year, birthMonth: month, height: height, heightUnit: "cm", feetInches: nil)
    }

    func testRecordWithSexBirthAndHeightSkipsTheFlow_AC1() {
        XCTAssertFalse(OnboardingSteps.needsFlow(profile(sex: "female", year: 1980, month: 3, height: "165")))
        XCTAssertTrue(OnboardingSteps.needsFlow(profile()))
        XCTAssertTrue(OnboardingSteps.needsFlow(profile(sex: "male", height: "180")), "no birth year")
        XCTAssertTrue(OnboardingSteps.needsFlow(profile(sex: "male", year: 1970)), "no height")
    }

    func testFirstRunStartsAtAppleHealth_AC1() {
        XCTAssertEqual(OnboardingSteps.start(profile(), healthAsked: false), .health)
    }

    func testResumeStartsAtTheFirstUnansweredQuestion_AC7() {
        XCTAssertEqual(OnboardingSteps.start(profile(), healthAsked: true), .sex)
        XCTAssertEqual(OnboardingSteps.start(profile(sex: "female"), healthAsked: true), .birth)
        XCTAssertEqual(OnboardingSteps.start(profile(sex: "female", year: 1980), healthAsked: true), .height)
        XCTAssertEqual(OnboardingSteps.start(profile(sex: "female", year: 1980, height: "165"), healthAsked: true), .weight)
    }

    func testTheFullFlowGoesThroughEveryStep_AC1() {
        var step = OnboardingStep.health
        var seen = [step]
        while let next = OnboardingSteps.next(after: step, profile: profile(), onlyMissing: false) {
            seen.append(next)
            step = next
        }
        XCTAssertEqual(seen, [.health, .sex, .birth, .height, .weight])
    }

    func testAfterAConnectOnlyMissingQuestionsAreAsked_AC2() {
        let cloud = profile(sex: "male", height: "180")
        XCTAssertEqual(OnboardingSteps.next(after: .health, profile: cloud, onlyMissing: true), .birth)
        XCTAssertEqual(OnboardingSteps.next(after: .birth, profile: cloud, onlyMissing: true), .weight)
        XCTAssertNil(OnboardingSteps.next(after: .birth, profile: cloud, hasWeight: true, onlyMissing: true), "a weight in the record is not asked again")
        XCTAssertNil(OnboardingSteps.next(after: .weight, profile: cloud, onlyMissing: true))
        XCTAssertEqual(OnboardingSteps.next(after: .height, profile: profile(), hasWeight: true, onlyMissing: false), .weight, "a new user is offered weight")
    }

    func testANewRecordTakesThePhonesRegionUnits_AC6() {
        XCTAssertEqual(OnboardingSteps.regionUnits(hasValues: false, onlyMissing: false, current: "si", system: .us), "conventional")
        XCTAssertEqual(OnboardingSteps.regionUnits(hasValues: false, onlyMissing: false, current: "conventional", system: .metric), "si")
        XCTAssertEqual(OnboardingSteps.regionUnits(hasValues: false, onlyMissing: false, current: "conventional", system: .uk), "si")
        XCTAssertNil(OnboardingSteps.regionUnits(hasValues: false, onlyMissing: false, current: "si", system: .metric), "already right: nothing written")
    }

    func testARecordWithValuesOrFromTheCloudKeepsItsUnits_AC6() {
        XCTAssertNil(OnboardingSteps.regionUnits(hasValues: true, onlyMissing: false, current: "conventional", system: .metric))
        XCTAssertNil(OnboardingSteps.regionUnits(hasValues: false, onlyMissing: true, current: "conventional", system: .metric), "a web user's choice is never overwritten")
    }

    func testHealthSexOtherOrNotSetPreselectsNothing_AC3() {
        XCTAssertEqual(HealthCharacteristics(sex: "female").sex, "female")
        XCTAssertEqual(HealthCharacteristics(sex: "male").sex, "male")
        XCTAssertNil(HealthCharacteristics(sex: "other").sex)
        XCTAssertNil(HealthCharacteristics(sex: "notSet").sex)
        XCTAssertNil(HealthCharacteristics(sex: nil).sex)
    }

    func testHealthBirthKeepsMonthAndYearOnly_AC3() {
        let given = HealthCharacteristics(birth: DateComponents(year: 1978, month: 4, day: 23))
        XCTAssertEqual(given.birthYear, 1978)
        XCTAssertEqual(given.birthMonth, 4)
        XCTAssertFalse(String(describing: given).contains("23"), "the day of birth is not kept")
        XCTAssertNil(HealthCharacteristics(birth: DateComponents(year: 1978)).birthYear, "a year without a month is not used")
        XCTAssertNil(HealthCharacteristics(birth: nil).birthYear)
    }
}
