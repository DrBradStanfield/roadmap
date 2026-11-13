import XCTest
@testable import HealthRoadmap

/// US-54: what the onboarding page shows after a save (`OnboardingView.landing`), and the
/// bugs the S6 survey found. A test named "Today" pins today's buggy behaviour; the fix
/// (S6 PR b) flips it.
final class OnboardingLandingTests: XCTestCase {
    private let saved = RecordStore.ApplyResult.saved()
    private func refused(_ words: String, _ id: String? = nil) -> RecordStore.ApplyResult {
        .refused(message: words, existingId: id)
    }

    func testAnUnchangedOrSavedAnswerMovesOn_AC1() {
        XCTAssertEqual(OnboardingView.landing(.unchanged, step: .sex), .advance)
        XCTAssertEqual(OnboardingView.landing(.applied(saved), step: .birth), .advance)
        XCTAssertEqual(OnboardingView.landing(.replaced(saved), step: .weight), .advance)
    }

    func testARefusalShowsTheEnginesWords_AC5() {
        XCTAssertEqual(OnboardingView.landing(.applied(refused("Too tall.")), step: .height), .words("Too tall."))
        // Only a weight asks to replace; another step's row id is just words.
        XCTAssertEqual(OnboardingView.landing(.applied(refused("Taken.", "row-1")), step: .height), .words("Taken."))
        // "Replace it" refused never asks again.
        XCTAssertEqual(OnboardingView.landing(.replaced(refused("Taken.", "row-1")), step: .weight), .words("Taken."))
    }

    func testTodaysWeightAsksBeforeReplacing_AC5() {
        XCTAssertEqual(OnboardingView.landing(.applied(refused("Today already has a weight.", "row-1")), step: .weight),
                       .askReplace(id: "row-1"))
    }

    /// Bug C: an answer it cannot write (`stay`) unlocks the page and says nothing.
    func testTodayStaySetsNoWords_BugC() {
        for step in OnboardingStep.questions {
            XCTAssertEqual(OnboardingView.landing(.stay, step: step), .stay, "\(step): no words")
        }
    }

    /// Bug A: "Replace it" reads the typed weight a second time. A weight from Apple Health
    /// (the stale-weight path) was never typed, so that read is nil and Replace does nothing.
    func testTodayReplaceOnAHealthWeightDoesNothing_BugA() async {
        var fromHealth = TypedAnswer(metric: "weight")
        fromHealth.text = "80"
        let reread = await fromHealth.saved(recordUnits: "si") { _, _, _, _ in nil }
        XCTAssertNil(reread, "an untyped weight has no value to replace with")
        XCTAssertEqual(OnboardingView.landing(.replaced(nil), step: .weight), .stay, "no step, no words")
    }

    /// Bug D1: Allow starts its connect in a Task, so `connecting` (which disables the
    /// button) is set only once the Task runs: a second tap before then starts a second connect.
    @MainActor func testTodayADoubleTapOnAllowStartsTwoConnects_BugD1() async {
        let connects = Connects()
        let tap = OnboardingView.allowTap { connects.started += 1 }
        tap()
        XCTAssertEqual(connects.started, 0, "the first connect has not begun, so nothing is disabled yet")
        tap()
        for _ in 0..<100 where connects.started < 2 { await Task.yield() }
        XCTAssertEqual(connects.started, 2)
    }
}

@MainActor private final class Connects {
    var started = 0
}
