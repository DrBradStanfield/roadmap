import XCTest
@testable import HealthRoadmap

/// US-52 AC6d: a chat answer that fails or is stopped never loses the question,
/// is never sent back as history, never piles up, and is told in plain words.
final class ChatFailureTests: XCTestCase {
    private func answered(_ question: String, _ answer: String, in transcript: inout ChatTranscript) {
        let index = transcript.ask(question)
        transcript.lines[index].text = answer
    }

    func testAFailedAnswerKeepsTheQuestionForTryAgain_US52_AC6d() {
        var transcript = ChatTranscript()
        _ = transcript.ask("What is ApoB?")
        transcript.fail(URLError(.notConnectedToInternet))
        XCTAssertEqual(transcript.lines.map(\.text), ["What is ApoB?"], "the question stays; no empty answer bubble")
        XCTAssertEqual(transcript.retryQuestion, "What is ApoB?")
        XCTAssertEqual(transcript.error, "The chat could not be reached. Check your connection, then try again.")
    }

    func testAFailedTurnIsNeverSentAsHistory_US52_AC6d() {
        var transcript = ChatTranscript()
        answered("Q0", "A0", in: &transcript)
        _ = transcript.ask("Q1")
        transcript.fail(URLError(.networkConnectionLost))
        XCTAssertEqual(transcript.history.map(\.content), ["Q0", "A0"])
        XCTAssertEqual(transcript.history.map(\.role), ["user", "assistant"])
    }

    func testAPartAnswerStaysOnScreenButIsNotHistory_US52_AC6d() {
        var transcript = ChatTranscript()
        let index = transcript.ask("Q1")
        transcript.lines[index].text = "ApoB counts the"
        transcript.fail(AppAttestClient.Failure.server(status: 0, message: "The answer was cut off."))
        XCTAssertEqual(transcript.lines.map(\.text), ["Q1", "ApoB counts the"])
        XCTAssertEqual(transcript.history.count, 0)
        XCTAssertEqual(transcript.retryQuestion, "Q1")
    }

    func testFailedTurnsNeverPileUp_US52_AC6d() {
        var transcript = ChatTranscript()
        answered("Q0", "A0", in: &transcript)
        _ = transcript.ask("Q1")
        transcript.fail(URLError(.timedOut))
        _ = transcript.ask("Q1")
        transcript.fail(URLError(.timedOut))
        XCTAssertEqual(transcript.lines.map(\.text), ["Q0", "A0", "Q1"], "the retry replaced the failed turn")
        answered("Q2", "A2", in: &transcript)
        XCTAssertEqual(transcript.lines.map(\.text), ["Q0", "A0", "Q2", "A2"], "a new question replaces it too")
        XCTAssertNil(transcript.error)
        XCTAssertNil(transcript.retryQuestion)
    }

    func testStopTakesTheTurnOffAndHandsBackTheQuestion_US52_AC6d() {
        var transcript = ChatTranscript()
        answered("Q0", "A0", in: &transcript)
        let index = transcript.ask("Q1")
        transcript.lines[index].text = "Part"
        XCTAssertEqual(transcript.stop(), "Q1")
        XCTAssertEqual(transcript.lines.map(\.text), ["Q0", "A0"])
        XCTAssertNil(transcript.error)
        var empty = ChatTranscript()
        XCTAssertNil(empty.stop(), "nothing in flight, nothing handed back")
    }

    /// Review R3: once `done` arrives the answer is in and is saved to history, so Stop is too
    /// late. It must not take the answer off or hand the question back: reopening the
    /// conversation would then send a "stopped" turn, and sending it again would save it twice.
    func testStopIsTooLateOnceTheAnswerIsIn_US52_AC6d() {
        var transcript = ChatTranscript()
        let index = transcript.ask("Q1")
        transcript.lines[index].text = "streamed"
        XCTAssertFalse(transcript.finished, "an answer still streaming can be stopped")
        XCTAssertEqual(transcript.finish(index, content: "final"), "final", "the final reply replaces what streamed")
        XCTAssertTrue(transcript.finished)
        XCTAssertNil(transcript.stop(), "nothing handed back")
        XCTAssertEqual(transcript.lines.map(\.text), ["Q1", "final"], "the answer stays up")
        XCTAssertEqual(transcript.history.map(\.content), ["Q1", "final"])
        _ = transcript.ask("Q2")
        XCTAssertFalse(transcript.finished, "the next question can be stopped again")
        XCTAssertEqual(transcript.stop(), "Q2")
        XCTAssertEqual(transcript.finish(1, content: nil), "final", "no final reply keeps what streamed")
    }

    /// While waiting, no empty grey answer bubble: the answer shows once its first words arrive.
    func testNoEmptyAnswerBubbleWhileWaiting_US52_AC6d() {
        var transcript = ChatTranscript()
        let index = transcript.ask("Q1")
        XCTAssertEqual(transcript.shown.map(\.text), ["Q1"])
        transcript.lines[index].text = "ApoB"
        XCTAssertEqual(transcript.shown.map(\.text), ["Q1", "ApoB"])
    }

    func testErrorsAreToldInPlainWords_US52_AC6d() {
        XCTAssertEqual(ChatTranscript.words(for: URLError(.timedOut)), "The chat took too long to answer. Please try again.")
        XCTAssertEqual(ChatTranscript.words(for: URLError(.networkConnectionLost)), "The connection dropped before the answer finished. Please try again.")
        XCTAssertEqual(ChatTranscript.words(for: URLError(.notConnectedToInternet)), "The chat could not be reached. Check your connection, then try again.")
        XCTAssertEqual(ChatTranscript.words(for: AppAttestClient.Failure.server(status: 429, message: "Daily chat limit reached.")), "Daily chat limit reached.", "the server's own words are kept")
        let other = ChatTranscript.words(for: NSError(domain: "JSContext", code: 7, userInfo: [NSLocalizedDescriptionKey: "TypeError: undefined is not an object"]))
        XCTAssertEqual(other, "Something went wrong, so this question has no answer. Please try again.")
    }

    /// The break-it pass's 502: an HTML page, no JSON error. No status code reaches the screen.
    func testAGatewayErrorPageIsToldInPlainWords_US52_AC6d() async {
        StubHTTP.handler = { _ in StubHTTP.Answer(status: 502, headers: ["Content-Type": "text/html"], body: Data("<html><body>Bad gateway</body></html>".utf8)) }
        let client = AppAttestClient(session: StubHTTP.session())
        do {
            _ = try await client.post("/api/app/v1/chat", body: Data("{}".utf8))
            XCTFail("a 502 throws")
        } catch {
            let words = ChatTranscript.words(for: error)
            XCTAssertEqual(words, "The server could not answer just now. Please try again later.")
            XCTAssertFalse(words.contains("502"))
        }
    }

    /// Stop: cancelling the turn ends the stream at once and cancels the request,
    /// even one whose server never answers.
    func testStoppingCancelsARequestThatHangs_US52_AC6d() async throws {
        StubHTTP.handler = { _ in StubHTTP.Answer(hang: true) }
        let stoppedBefore = StubHTTP.stopped
        let chat = ChatClient(attest: AppAttestClient(session: StubHTTP.session()))
        let turn = Task { () -> Bool in
            do {
                for try await _ in chat.ask(body: Data("{}".utf8)) {}
                return true
            } catch { return true }
        }
        try await Task.sleep(for: .milliseconds(300))
        let started = Date()
        turn.cancel()
        let ended = await turn.value
        XCTAssertTrue(ended)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "the stream ended at once")
        for _ in 0..<20 where StubHTTP.stopped == stoppedBefore { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertGreaterThan(StubHTTP.stopped, stoppedBefore, "the request was cancelled, not left running")
    }
}
