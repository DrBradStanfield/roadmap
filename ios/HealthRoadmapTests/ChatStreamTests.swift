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

    /// US-52 AC6g: the line under the conversation, step by step, in the web's words
    /// (ChatPendingReply.tsx, `status ? status… : Thinking…`, then "Answering…" once text arrives):
    /// "Thinking…" from Send; a status, with "…", keeps priority over thinking; "Answering…" until
    /// `done`. Draft notes never show.
    func testThePendingLineFollowsTheStream_US52_AC6g() {
        var transcript = ChatTranscript()
        let index = transcript.ask("Is my LDL OK?")
        XCTAssertEqual(transcript.pending?.words, "Thinking…", "from Send, before any event")
        let steps: [(ChatStreamEvent, String?)] = [
            (.thinking, "Thinking…"),
            (.status("Writing the answer"), "Writing the answer…"),
            (.thinking, "Writing the answer…"),
            (.thinking, "Writing the answer…"),
            (.text("Your LDL is above target."), "Answering…"),
            (.thinking, "Answering…"),
            (.done(content: "Your LDL is above target.", isFallback: false, error: nil), nil),
        ]
        for (event, words) in steps {
            transcript.stream(event, into: index)
            XCTAssertEqual(transcript.pending?.words, words, "after \(event)")
        }
        XCTAssertEqual(transcript.shown.map(\.text), ["Is my LDL OK?", "Your LDL is above target."], "no draft notes in the answer")
    }

    /// US-52 AC6g: a restart status goes back to its own words (with "…"), and a stopped or failed turn leaves no line.
    func testARestartShowsTheStatusAndAnEndedTurnClearsTheLine_US52_AC6g() {
        var transcript = streamed([.thinking, .text("Let me run those numbers. "), .status("Running your numbers through the roadmap")])
        XCTAssertEqual(transcript.pending?.words, "Running your numbers through the roadmap…")
        transcript.stream(.text("Your LDL"), into: transcript.lines.count - 1)
        XCTAssertEqual(transcript.pending?.words, "Answering…")
        _ = transcript.stop()
        XCTAssertNil(transcript.pending)

        var failed = streamed([.thinking])
        failed.fail(URLError(.timedOut))
        XCTAssertNil(failed.pending)
    }
}
