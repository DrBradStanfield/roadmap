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

    private func store() throws -> RecordStore {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Onboarding \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return try RecordStore(folder: folder, engine: try HealthEngine(), deviceId: "test")
    }

    /// The owner's condition on (c): only a moved record restarts. A validation refusal, a day
    /// already holding a weight, or a write failure, on the record the page shows, never does.
    func testOnlyAMovedRecordRestarts_US54_AC5d() async throws {
        let store = try store()
        store.pinScreen()
        defer { store.unpinScreen() }
        let tooShort = await store.apply(.profile(height: 5))
        guard case .refused(let words, _) = tooShort else { return XCTFail("5 cm is refused") }
        XCTAssertTrue(store.pinStillShown)
        XCTAssertEqual(OnboardingFlow.landing(.applied(tooShort), step: .height, moved: !store.pinStillShown), .words(words))
        // Pure: a duplicate asks, a write failure shows its words; neither restarts while the record holds.
        XCTAssertEqual(OnboardingFlow.landing(.applied(refused("Taken.", "row-1"), typed: 80), step: .weight, moved: false),
                       .askReplace(OnboardingFlow.Replace(id: "row-1", value: 80)))
        XCTAssertEqual(OnboardingFlow.landing(.applied(refused("The disk is full.")), step: .height, moved: false), .words("The disk is full."))
        XCTAssertEqual(OnboardingFlow.landing(.applied(saved), step: .height, moved: true), .advance, "a save never restarts")
    }
}
