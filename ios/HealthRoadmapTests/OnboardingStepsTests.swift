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

    /// AC3b (Brad 2026-10-26): what Apple Health supplied is not asked again; the summary
    /// comes last, and only when something was supplied.
    func testHealthsAnswersAreNotAskedAgain_AC3b() {
        let all: Set<OnboardingStep> = [.sex, .birth, .height, .weight]
        XCTAssertEqual(OnboardingSteps.next(after: .health, profile: profile(), onlyMissing: false, skip: all), .review, "the sheet, then the summary")
        XCTAssertNil(OnboardingSteps.next(after: .review, profile: profile(), onlyMissing: false, skip: all), "Continue opens My plan")
        var step = OnboardingStep.health
        var seen = [step]
        while let next = OnboardingSteps.next(after: step, profile: profile(), onlyMissing: false, skip: [.sex, .height]) {
            seen.append(next)
            step = next
        }
        XCTAssertEqual(seen, [.health, .birth, .weight, .review], "only what Health did not give")
    }

    /// AC3b (a): a weight more than a year old is asked again; a newer one is supplied.
    func testAWeightOlderThanAYearIsAskedAgain_AC3b() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        let now = Date(timeIntervalSince1970: 1_792_972_800) // 2026-10-26
        let health: Set<OnboardingStep> = [.sex, .weight]
        let held = profile(sex: "female", height: "170")
        XCTAssertEqual(OnboardingSteps.supplied(fromHealth: health, profile: held, weightDay: "2025-10-26", now: now, calendar: utc), health, "a year to the day is fresh")
        XCTAssertEqual(OnboardingSteps.supplied(fromHealth: health, profile: held, weightDay: "2025-10-25", now: now, calendar: utc), [.sex], "older: asked again")
        XCTAssertEqual(OnboardingSteps.supplied(fromHealth: health, profile: held, weightDay: nil, now: now, calendar: utc), [.sex])
        XCTAssertEqual(OnboardingSteps.supplied(fromHealth: [.height], profile: held, weightDay: "2026-10-01", now: now, calendar: utc), [.height], "a weight Health did not give stays out")
        XCTAssertEqual(OnboardingSteps.supplied(fromHealth: [.sex, .birth, .height], profile: profile(), weightDay: nil, now: now, calendar: utc), [],
                       "only what the record holds: an erase since leaves nothing skipped")
    }

    /// AC3b, adversary R1 and Codex R2: once the stale weight is confirmed (today's row), it is
    /// supplied, so Back from the summary skips it and an untouched Continue writes nothing.
    func testBackToAConfirmedStaleWeightDoesNotLoop_AC3b() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        let now = Date(timeIntervalSince1970: 1_792_972_800) // 2026-10-26
        let held = profile(sex: "female", year: 1985, month: 3, height: "170")
        let fromHealth: Set<OnboardingStep> = [.sex, .birth, .height, .weight]
        let before = OnboardingSteps.supplied(fromHealth: fromHealth, profile: held, weightDay: "2024-01-01", now: now, calendar: utc)
        XCTAssertFalse(before.contains(.weight), "stale: asked")
        let after = OnboardingSteps.supplied(fromHealth: fromHealth, profile: held, weightDay: "2026-10-26", now: now, calendar: utc)
        XCTAssertTrue(after.contains(.weight), "confirmed today: no longer stale")
        XCTAssertEqual(OnboardingSteps.next(after: .weight, profile: held, hasWeight: true, onlyMissing: false, skip: after), .review)
        XCTAssertEqual(OnboardingSteps.previous(before: .review, onlyMissing: false, skip: after), .health, "Back skips the confirmed weight")
    }

    /// AC3b, adversary R2: a relaunch keeps both guards. Which steps came from Health is kept
    /// (step names only, no values); what is supplied is worked out again from the record.
    func testARelaunchKeepsBothGuards_AC3b() {
        let fromHealth: Set<OnboardingStep> = [.sex, .birth, .height, .weight]
        XCTAssertEqual(OnboardingSteps.decode(OnboardingSteps.encode(fromHealth)), fromHealth)
        XCTAssertEqual(OnboardingSteps.decode(""), [])
        XCTAssertEqual(OnboardingSteps.decode("9,x,1"), [.sex], "unknown entries are dropped")
        let held = profile(sex: "female", year: 1985, month: 3, height: "170")
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        let now = Date(timeIntervalSince1970: 1_792_972_800) // 2026-10-26
        XCTAssertEqual(OnboardingSteps.start(held, healthAsked: true, skip: fromHealth, weightDay: "2026-09-01", now: now, calendar: utc), .review,
                       "everything from Health: the summary again")
        XCTAssertEqual(OnboardingSteps.start(held, healthAsked: true, skip: [.sex, .birth, .height], weightDay: "2024-01-01", now: now, calendar: utc), .weight,
                       "a stale weight: asked again")
        XCTAssertEqual(OnboardingSteps.start(profile(sex: "female"), healthAsked: true, skip: [.sex]), .birth)
    }

    /// AC3b, Codex R1 (2026-10-26): sex, birth and height came from Health and the weight was
    /// typed by hand; a relaunch then resumes at the summary, not the weight question again.
    /// A weight more than a year old is still asked.
    func testARelaunchAfterATypedWeightResumesAtTheSummary_AC3b() {
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = .gmt
        let now = Date(timeIntervalSince1970: 1_792_972_800) // 2026-10-26
        let held = profile(sex: "female", year: 1985, month: 3, height: "170")
        let fromHealth: Set<OnboardingStep> = [.sex, .birth, .height]
        let skip = OnboardingSteps.supplied(fromHealth: fromHealth, profile: held, weightDay: "2026-10-26", now: now, calendar: utc)
        XCTAssertFalse(skip.contains(.weight), "typed, not from Health")
        XCTAssertEqual(OnboardingSteps.start(held, healthAsked: true, skip: skip, weightDay: "2026-10-26", now: now, calendar: utc), .review)
        XCTAssertEqual(OnboardingSteps.start(held, healthAsked: true, skip: skip, weightDay: "2025-01-01", now: now, calendar: utc), .weight, "stale: asked")
        XCTAssertEqual(OnboardingSteps.start(held, healthAsked: true, skip: skip, weightDay: nil, now: now, calendar: utc), .weight)
        XCTAssertEqual(OnboardingSteps.start(held, healthAsked: true, skip: [], weightDay: "2026-10-26", now: now, calendar: utc), .weight, "no Health: no summary")
    }

    /// AC3b, review E3/A4: Health's sex and birth go in one profile edit, only what the record lacks.
    func testHealthsSexAndBirthAreOneEdit_AC3b() {
        let given = HealthCharacteristics(sex: "female", birth: DateComponents(year: 1985, month: 3, day: 9))
        XCTAssertEqual(OnboardingSteps.healthEdit(given, profile: profile()), .profile(sex: "female", birthYear: 1985, birthMonth: 3))
        XCTAssertEqual(OnboardingSteps.healthEdit(given, profile: profile(sex: "male")), .profile(birthYear: 1985, birthMonth: 3), "the record's sex stays")
        XCTAssertEqual(OnboardingSteps.healthEdit(HealthCharacteristics(sex: "other"), profile: profile()), nil, "nothing to save")
        XCTAssertEqual(OnboardingSteps.healthEdit(given, profile: profile(sex: "male", year: 1970, month: 1)), nil)
    }

    /// AC3b, review: the summary's height reads as words to VoiceOver.
    func testTheSummaryHeightIsSpokenInWords_AC3b() {
        let us = MyData.Profile(sex: "male", birthYear: 1970, birthMonth: 12, height: "70", heightUnit: "in", feetInches: MyData.FeetInches(feet: 5, inches: 10))
        XCTAssertEqual(OnboardingSteps.spoken(.height, text: "5 ft 10 in", profile: us), "Height, 5 feet 10 inches")
        XCTAssertEqual(OnboardingSteps.spoken(.height, text: "170 cm", profile: profile(height: "170")), "Height, 170 cm")
        XCTAssertEqual(OnboardingSteps.spoken(.sex, text: "Male", profile: us), "Sex, Male")
        XCTAssertEqual(OnboardingSteps.spoken(.weight, text: "150 lb", profile: us), "Weight, 150 lb")
        XCTAssertEqual(OnboardingStep.birth.name, "Birth month and year", "the Edit button's name too")
        XCTAssertEqual(MyData.sexLabel("female"), "Female")
    }

    /// AC3b (b): each summary line in the record's own words and units.
    func testTheSummaryLinesSayWhatHealthGave_AC3b() {
        let metric = profile(sex: "female", year: 1985, month: 3, height: "170")
        XCTAssertEqual(OnboardingSteps.summary(.sex, profile: metric, weight: nil), "Female")
        XCTAssertEqual(OnboardingSteps.summary(.birth, profile: metric, weight: nil), "Born March 1985")
        XCTAssertEqual(OnboardingSteps.summary(.height, profile: metric, weight: nil), "170 cm")
        XCTAssertEqual(OnboardingSteps.summary(.weight, profile: metric, weight: (value: "68", unit: "kg")), "68 kg")
        let us = MyData.Profile(sex: "male", birthYear: 1970, birthMonth: 12, height: "70", heightUnit: "in", feetInches: MyData.FeetInches(feet: 5, inches: 10))
        XCTAssertEqual(OnboardingSteps.summary(.sex, profile: us, weight: nil), "Male")
        XCTAssertEqual(OnboardingSteps.summary(.height, profile: us, weight: nil), "5 ft 10 in")
        XCTAssertEqual(OnboardingSteps.summary(.weight, profile: us, weight: (value: "150", unit: "lb")), "150 lb")
        XCTAssertNil(OnboardingSteps.summary(.weight, profile: us, weight: nil))
    }

    /// AC3b: Back skips the supplied steps; from the summary it reaches the last question asked.
    func testBackSkipsWhatHealthSupplied_AC3b() {
        XCTAssertEqual(OnboardingSteps.previous(before: .review, onlyMissing: false, skip: [.sex, .birth, .height, .weight]), .health)
        XCTAssertEqual(OnboardingSteps.previous(before: .review, onlyMissing: false, skip: [.sex, .weight]), .height)
        XCTAssertEqual(OnboardingSteps.previous(before: .height, onlyMissing: false, skip: [.birth]), .sex)
        XCTAssertEqual(OnboardingSteps.previous(before: .sex, onlyMissing: false, skip: []), .health)
        XCTAssertNil(OnboardingSteps.previous(before: .sex, onlyMissing: true, skip: []), "no Apple Health page after a cloud connect")
    }

    /// Brad 2026-10-25: the hint above "Connect Apple Health", short and in plain words.
    func testTheAppleHealthHintSaysWhatToTap_AC3() {
        XCTAssertEqual(OnboardingView.appleAsksNextWords, "Next, Apple asks for access. Turn everything on, then tap **Allow**.",
                       "version-neutral: iOS 27's sheet says Select All, older ones Turn On All (2026-10-26)")
    }
}
