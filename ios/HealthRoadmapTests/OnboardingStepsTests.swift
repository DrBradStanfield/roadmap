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

    /// An erase on any device raises the record's erase count; with the answers gone,
    /// the questions come back. A higher count with the answers still there does not.
    func testAnEraseAnywhereBringsTheQuestionsBack_AC7() {
        XCTAssertTrue(OnboardingSteps.erasedSince(0, epoch: 1, profile: profile()))
        XCTAssertFalse(OnboardingSteps.erasedSince(1, epoch: 1, profile: profile()), "the erase already answered")
        XCTAssertFalse(OnboardingSteps.erasedSince(0, epoch: nil, profile: profile()), "an older engine")
        XCTAssertFalse(OnboardingSteps.erasedSince(0, epoch: 2, profile: profile(sex: "male", year: 1980, height: "180")), "answers already back")
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

    func testANewRecordTakesThePhonesRegionUnits_AC6() async {
        XCTAssertEqual(OnboardingSteps.regionUnits(hasValues: false, onlyMissing: false, current: "si", system: .us), "conventional")
        XCTAssertEqual(OnboardingSteps.regionUnits(hasValues: false, onlyMissing: false, current: "conventional", system: .metric), "si")
        XCTAssertEqual(OnboardingSteps.regionUnits(hasValues: false, onlyMissing: false, current: "conventional", system: .uk), "si")
        XCTAssertNil(OnboardingSteps.regionUnits(hasValues: false, onlyMissing: false, current: "si", system: .metric), "already right: nothing written")
    }

    func testARecordWithValuesOrFromTheCloudKeepsItsUnits_AC6() async {
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

    // US-54 AC6: the height and weight unit switches are for entry only. These run the
    // real engine's conversion (convertJson), as the screens do.
    private let engine = try! HealthEngine()
    private func convert(_ value: Double, _ metric: String, _ from: String, _ to: String) async -> HealthEngine.Conversion? {
        try? await engine.convert(value, metric: metric, from: from, to: to)
    }

    /// A prefilled weight left alone saves nothing, however its unit is switched: Codex's
    /// 70 kg case and the adversary's 70.5 kg one.
    func testAPrefilledWeightSwitchedToLbAndBackSavesNothing_AC6() async {
        for recorded in [70.0, 70.5] {
            var weight = TypedAnswer(metric: "weight")
            await weight.show(recorded, recordUnits: "si", convert: convert)
            XCTAssertEqual(weight.text, String(format: "%.1f", recorded))
            await weight.switchUnits(toUS: true, recorded: recorded, recordUnits: "si", convert: convert)
            XCTAssertEqual(weight.text, recorded == 70 ? "154" : "155", "the record's weight in lb")
            let answer1 = await weight.saved(recordUnits: "si", convert: convert)
            XCTAssertNil(answer1, "in lb, untouched")
            await weight.switchUnits(toUS: false, recorded: recorded, recordUnits: "si", convert: convert)
            XCTAssertEqual(weight.text, String(format: "%.1f", recorded), "back in kg, re-read from the record, not from 154 lb")
            let answer2 = await weight.saved(recordUnits: "si", convert: convert)
            XCTAssertNil(answer2, "no weight row added")
        }
    }

    /// Codex (re-check): with a typed weight, lb then kg tapped before the lb conversion
    /// lands. The last tap wins: the late lb conversion never lands over kg.
    func testTheLastUnitTapWinsOverALateConversion_AC6() async {
        var box = TypedAnswer(metric: "weight")
        box.text = "80"
        box.edited = true
        let slow: TypedAnswer.Convert = { [convert] value, metric, from, to in
            try? await Task.sleep(for: .milliseconds(200))
            return await convert(value, metric, from, to)
        }
        let lbStart = box.tapped()
        let kgStart = box.tapped()
        var lb = lbStart, kg = kgStart
        await kg.switchUnits(toUS: false, recorded: nil, recordUnits: "si", convert: slow)
        box.land(kg, from: kgStart)
        await lb.switchUnits(toUS: true, recorded: nil, recordUnits: "si", convert: slow)
        XCTAssertTrue(lb.us, "the lb conversion ran")
        box.land(lb, from: lbStart)
        XCTAssertFalse(box.us, "kg, the last tap")
        XCTAssertEqual(box.text, "80")
    }

    /// A weight typed in lb is saved as the right number in the units the edit reads.
    func testATypedWeightIsSavedInTheEditsUnits_AC6() async {
        var weight = TypedAnswer(metric: "weight", us: true)
        weight.text = "220"
        weight.edited = true
        let answer3 = await weight.saved(recordUnits: "si", convert: convert)
        XCTAssertEqual(answer3 ?? 0, 99.79, accuracy: 0.01, "220 lb on a metric record")
        let answer4 = await weight.saved(recordUnits: "conventional", convert: convert)
        XCTAssertEqual(answer4, 220, "as typed on a US one")
        await weight.switchUnits(toUS: false, recorded: nil, recordUnits: "si", convert: convert)
        XCTAssertEqual(weight.text, "99.8", "a typed weight is converted once and stays the person's")
        XCTAssertTrue(weight.edited)
    }

    /// A height typed in feet and inches or centimetres is the right height, in either record's units.
    func testATypedHeightIsSavedInTheEditsUnits_AC6() async {
        var height = TypedAnswer(metric: "height")
        height.text = "170"
        height.edited = true
        let answer5 = await height.saved(recordUnits: "si", convert: convert)
        XCTAssertEqual(answer5, 170)
        let answer6 = await height.saved(recordUnits: "conventional", convert: convert)
        XCTAssertEqual(answer6 ?? 0, 66.93, accuracy: 0.01, "170 cm in inches on a US record")
        await height.switchUnits(toUS: true, recorded: nil, recordUnits: "si", convert: convert)
        XCTAssertEqual(height.feetInches, MyData.FeetInches(feet: 5, inches: 7), "170 cm is 5 ft 7 in")
        await height.switchUnits(toUS: false, recorded: nil, recordUnits: "si", convert: convert)
        XCTAssertEqual(height.text, "170")
    }

    /// A prefilled height switched to feet and inches shows the record's height there and saves nothing;
    /// the weight's box and meaning are its own.
    func testAHeightSwitchLeavesTheWeightAlone_AC6() async {
        var height = TypedAnswer(metric: "height")
        var weight = TypedAnswer(metric: "weight")
        await height.show(178, recordUnits: "si", convert: convert)
        await weight.show(70, recordUnits: "si", convert: convert)
        await height.switchUnits(toUS: true, recorded: 178, recordUnits: "si", convert: convert)
        XCTAssertEqual(height.feetInches, MyData.FeetInches(feet: 5, inches: 10))
        let answer7 = await height.saved(recordUnits: "si", convert: convert)
        XCTAssertNil(answer7)
        XCTAssertFalse(weight.us, "weight stays in kg")
        weight.text = "72"
        weight.edited = true
        let answer8 = await weight.saved(recordUnits: "si", convert: convert)
        XCTAssertEqual(answer8, 72, "72 kg is saved as 72 kg")
    }
    /// US-54 AC5: a weight equal to the record's latest writes nothing, even typed again, on
    /// today's row or an earlier day's; a different one is written. The latest comes from the
    /// real engine's My data, as the screen reads it.
    func testRetypingTheRecordsWeightWritesNothing_AC5() async throws {
        let now = try Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
        let empty = try engine.blocking { try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        for day in ["2026-10-21", "2026-09-02"] {
            let saved = try XCTUnwrap(engine.blocking { try $0.apply(.add(metric: "weight", value: 70, day: day), to: empty, now: now, deviceId: "test") }.record, day)
            let latest = try engine.blocking { try $0.myData(recordJSON: saved, now: now, deviceId: "test") }.vitals.first { $0.metric == "weight" }?.latest
            let recorded = try XCTUnwrap(latest.flatMap { Double($0.value) }, day)
            func typed(_ text: String, us: Bool = false) -> TypedAnswer {
                var weight = TypedAnswer(metric: "weight", us: us)
                weight.text = text
                weight.edited = true
                return weight
            }
            let answer9 = await typed("70").repeats(recorded, recordUnits: "si", convert: convert)
            XCTAssertTrue(answer9, "\(day): 70 on 70.0 kg writes nothing")
            let answer10 = await typed("154", us: true).repeats(recorded, recordUnits: "si", convert: convert)
            XCTAssertTrue(answer10, "\(day): 154 lb is 70 kg to the pound")
            let answer11 = await typed("70.2").repeats(recorded, recordUnits: "si", convert: convert)
            XCTAssertFalse(answer11, "\(day): 70.2 is written")
            let answer12 = await typed("156", us: true).repeats(recorded, recordUnits: "si", convert: convert)
            XCTAssertFalse(answer12, "\(day): 156 lb is written")
            let answer13 = await typed("70").repeats(nil, recordUnits: "si", convert: convert)
            XCTAssertFalse(answer13, "no weight yet: written")
        }
    }
}
