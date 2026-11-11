import XCTest
@testable import HealthRoadmap

/// US-52 AC6f: a status line that restarts the answer clears what streamed before it,
/// as on the web (US-15 AC38). In a run_roadmap round the first call may stream a
/// preamble, then the server sends its roadmap status, then the real answer streams.
final class ChatStreamTests: XCTestCase {
    private func streamed(_ events: [ChatStreamEvent]) -> ChatTranscript {
        var transcript = ChatTranscript()
        let index = transcript.ask("Is my LDL OK?")
        for event in events { transcript.stream(event, into: index) }
        return transcript
    }

    func testARestartingStatusClearsThePreambleBeforeDone_US52_AC6f() {
        let transcript = streamed([
            .status("Writing the answer"),
            .text("Let me run those numbers. "),
            .status("Running your numbers through the roadmap"),
            .text("Your LDL is "),
            .text("above target."),
        ])
        XCTAssertEqual(transcript.shown.map(\.text), ["Is my LDL OK?", "Your LDL is above target."])
    }

    func testATurnWithNoRestartKeepsEveryStreamedWord_US52_AC6f() {
        let transcript = streamed([.status("Reading your question"), .status("Writing the answer"), .text("ApoB counts "), .text("particles.")])
        XCTAssertEqual(transcript.shown.map(\.text), ["Is my LDL OK?", "ApoB counts particles."])
    }

    func testTheArticlesReadSurviveARestart_US52_AC6f() {
        let transcript = streamed([.sources(["ApoB explained"]), .text("Preamble"), .status("Running your numbers through the roadmap"), .text("Answer")])
        XCTAssertEqual(transcript.lines.last?.sources, ["ApoB explained"])
        XCTAssertEqual(transcript.lines.last?.text, "Answer")
    }
}
