import XCTest
@testable import HealthRoadmap

/// US-54: what the onboarding page shows after a save (`OnboardingFlow.landing`), and the
/// bugs the S6 survey found in it. The flow's table is OnboardingFlowTests.
@MainActor
final class OnboardingLandingTests: XCTestCase {
    private let saved = RecordStore.ApplyResult.saved()
    private func refused(_ words: String, _ id: String? = nil) -> RecordStore.ApplyResult {
        .refused(message: words, existingId: id)
    }

    func testAnUnchangedOrSavedAnswerMovesOn_AC1() {
        XCTAssertEqual(OnboardingFlow.landing(.unchanged, step: .sex), .advance)
        XCTAssertEqual(OnboardingFlow.landing(.applied(saved), step: .birth), .advance)
        XCTAssertEqual(OnboardingFlow.landing(.replaced(saved), step: .weight), .advance)
    }

    func testARefusalShowsTheEnginesWords_AC5() {
        XCTAssertEqual(OnboardingFlow.landing(.applied(refused("Too tall.")), step: .height), .words("Too tall."))
        // Only a weight asks to replace; another step's row id is just words.
        XCTAssertEqual(OnboardingFlow.landing(.applied(refused("Taken.", "row-1"), typed: 80), step: .height), .words("Taken."))
        // "Replace it" refused never asks again.
        XCTAssertEqual(OnboardingFlow.landing(.replaced(refused("Taken.", "row-1")), step: .weight), .words("Taken."))
    }

    func testTodaysWeightAsksBeforeReplacing_AC5() {
        XCTAssertEqual(OnboardingFlow.landing(.applied(refused("Today already has a weight.", "row-1"), typed: 80), step: .weight),
                       .askReplace(OnboardingFlow.Replace(id: "row-1", value: 80)))
    }

    /// Bug C: an answer it cannot write (`stay`) says so on the page (`unwritten`: the engine's
    /// own fallback words, OnboardingFlowTests), instead of unlocking the page in silence.
    func testAnAnswerItCannotWriteSaysSo_BugC() {
        for step in OnboardingStep.questions {
            XCTAssertEqual(OnboardingFlow.landing(.stay, step: step), .unwritten("That could not be saved."), "\(step)")
        }
    }

    /// S6 bug A ("Replace it" does nothing on Apple Health's weight) cannot happen: the
    /// stale-weight path confirms Health's weight as an `appleHealth` import, and the
    /// engine's import never refuses naming a row (ios/engine/my-data.ts, case
    /// 'appleHealth'), even when today already holds a typed weight. So it never asks.
    func testAConfirmedHealthWeightNeverAsksToReplace_BugA() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Onboarding \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try RecordStore(folder: folder, engine: try HealthEngine(), deviceId: "test")
        let twoYearsAgo = Date.now.addingTimeInterval(-2 * 366 * 86_400)
        let old = HealthSample(id: UUID(), metric: "weight", value: 80, at: twoYearsAgo, timeZone: .current)
        let imported = await store.apply(.appleHealth([old]))
        XCTAssertEqual(imported, saved, "Health's year-old weight")
        let typed = await store.apply(.add(metric: "weight", value: 81, day: DayText.iso(.now)))
        XCTAssertEqual(typed, saved, "today's typed weight")

        let confirmed = await store.apply(OnboardingSteps.confirmedWeight(kilograms: 80, now: .now))

        XCTAssertEqual(confirmed, saved, "the import names no row")
        XCTAssertEqual(OnboardingFlow.landing(.applied(confirmed), step: .weight), .advance)
        // And were a refusal ever to name a row there, no weight was typed: words, never the question.
        XCTAssertEqual(OnboardingFlow.landing(.applied(refused("Taken.", "row-1")), step: .weight), .words("Taken."))
    }

    /// The owner's ruling on PR 1570: after a sync moves the record under an open page, the
    /// refusal ("Your record changed...") keeps the page's pin, so the next tap is refused
    /// again instead of saving into a record the page never showed (US-25 AC11g, US-54 AC5d).
    func testAfterASyncTheNextTapIsRefusedAgain_US54_AC5d() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Onboarding \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        store.pinScreen()  // the height page shows the phone's record
        defer { store.unpinScreen() }
        let cloudRecord = try engine.blocking { try $0.newRecord(now: .now, deviceId: "web") }
        await store.showCloud(HealthEngine.CloudView(record: cloudRecord, erase: "e1", session: 1)).value

        var mode = OnboardingFlow.Mode.page(.init(step: .height), .editing(message: nil))
        for attempt in 1...2 {
            let (claimed, claim) = OnboardingFlow.transition(mode, .tapped)
            XCTAssertEqual(claim, [.save(.height)], "try \(attempt) saves")
            let result = await store.apply(.profile(height: 180))
            XCTAssertEqual(result, refused(RecordStore.recordChanged), "try \(attempt) is refused")
            let landing = OnboardingFlow.landing(.applied(result), step: .height)
            XCTAssertEqual(landing, .unwritten(RecordStore.recordChanged))
            let (next, effects) = OnboardingFlow.transition(claimed, .landed(landing, next: .weight))
            XCTAssertEqual(effects, [], "no repin, so the pin is still the record the page showed")
            XCTAssertEqual(next.save?.message, RecordStore.recordChanged)
            mode = next
        }
        XCTAssertNil(store.myData?.profile.height, "nothing written into the record the page never showed")
    }
}
