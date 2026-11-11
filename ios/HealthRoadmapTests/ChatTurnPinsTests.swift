import XCTest
@testable import HealthRoadmap

/// Chat PR 1 (US-52 AC6d, AC6f, AC6g): golden pins of one phone chat turn today, read from
/// the table the web runs too (packages/health-core/src/__fixtures__/chat-turns.json, copied
/// here by ios/scripts/build-engine.mjs; the web: widget-src/src/hooks/chat-turns.pins.test.tsx).
/// No behaviour change: a later move into a shared reducer keeps every row green, unedited.
///
/// Each line goes through ChatStreamEvent.parse (a nil is skipped, as ChatClient.ask skips it)
/// into ChatTranscript.stream. What ChatView.send adds around them (finish on `done`, a throw
/// on a `done` with an error, the cut-off throw) is replayed here as it is written there; the
/// table's notPinnable list names it. Synthetic questions and answers only.
final class ChatTurnPinsTests: XCTestCase {
    private typealias Row = [String: Any]

    private func table() throws -> Row {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "chat-turns", withExtension: "json"),
                                "the chat table is missing; run ios/scripts/build-engine.mjs")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? Row)
    }

    /// This client's value: a split value's `phone`, else the value both clients share. JSON null is nil.
    private func phone(_ value: Any?) -> Any? {
        let resolved = (value as? Row).flatMap { $0["web"] != nil && $0["phone"] != nil ? $0["phone"] : nil } ?? value
        return resolved is NSNull ? nil : resolved
    }

    private func runsOnPhone(_ row: Row) -> Bool { (row["clients"] as? [String])?.contains("phone") ?? true }

    /// A line as the server sends it: an object as JSON, a string as it is.
    private func raw(_ line: Any?) throws -> String {
        if let line = line as? String { return line }
        return String(decoding: try JSONSerialization.data(withJSONObject: try XCTUnwrap(line)), as: UTF8.self)
    }

    private struct Shown: Equatable { let role: String, text: String, failed: Bool }

    private func shown(_ transcript: ChatTranscript) -> [Shown] {
        transcript.lines.map { Shown(role: $0.role == .user ? "user" : "assistant", text: $0.text, failed: $0.failed) }
    }

    private func expected(_ value: Any?) -> [Shown] {
        (phone(value) as? [Row] ?? []).map { Shown(role: $0["role"] as? String ?? "", text: $0["text"] as? String ?? "", failed: $0["failed"] as? Bool ?? false) }
    }

    private func error(_ spec: Row) throws -> Error {
        if let server = spec["server"] as? Row {
            return AppAttestClient.Failure.server(status: try XCTUnwrap(server["status"] as? Int), message: try XCTUnwrap(server["message"] as? String))
        }
        switch spec["url"] as? String {
        case "timedOut": return URLError(.timedOut)
        case "notConnectedToInternet": return URLError(.notConnectedToInternet)
        default: throw XCTSkip("unknown failure \(spec)")
        }
    }

    // MARK: turns

    func testEachTurnStepByStep() throws {
        let table = try table()
        let afterAsk = try XCTUnwrap(table["afterAsk"] as? Row)
        let turns = try XCTUnwrap(table["turns"] as? [Row]).filter(runsOnPhone)
        XCTAssertGreaterThan(turns.count, 0)
        for row in turns {
            let id = try XCTUnwrap(row["id"] as? String)
            var transcript = ChatTranscript()
            let index = transcript.ask(try XCTUnwrap(row["question"] as? String))
            var box = ""

            if let failure = (row["failure"] as? Row)?["phone"] as? Row {
                transcript.fail(try error(failure))
            } else {
                XCTAssertEqual(transcript.pending?.words, afterAsk["pending"] as? String, "\(id) after ask")
                XCTAssertEqual(transcript.lines[index].text, afterAsk["text"] as? String, "\(id) after ask")
                var finished = false
                for (number, step) in (row["steps"] as? [Row] ?? []).enumerated() {
                    let at = "\(id) step \(number + 1)"
                    let line = try raw(step["line"])
                    if let event = ChatStreamEvent.parse(line) {
                        if (step["line"] as? Row)?["type"] as? String == "thinking" { XCTAssertEqual(event, .thinking, "\(at): draft notes are dropped") }
                        transcript.stream(event, into: index)
                        // ChatView.send, as written there: a done ends the turn.
                        if case .done(let content, _, let failure, _) = event {
                            if let failure { transcript.fail(AppAttestClient.Failure.server(status: 500, message: failure)) }
                            else { _ = transcript.finish(index, content: content) }
                            finished = true
                        }
                    }
                    if step.keys.contains("pending") { XCTAssertEqual(transcript.pending?.words, phone(step["pending"]) as? String, at) }
                    if step.keys.contains("text") { XCTAssertEqual(transcript.lines[index].text, phone(step["text"]) as? String, at) }
                    if step.keys.contains("sources") { XCTAssertEqual(transcript.lines[index].sources, phone(step["sources"]) as? [String], at) }
                }
                switch row["end"] as? String {
                case "cutOff" where !finished:
                    // ChatView.send: a stream that ended with no done line was cut off.
                    transcript.fail(AppAttestClient.Failure.server(status: 0, message: "The answer was cut off. Please try again."))
                case "stop":
                    // ChatView.stop: the question comes back to an empty box.
                    box = transcript.stop() ?? ""
                default: break
                }
            }

            let after = try XCTUnwrap(row["after"] as? Row)
            XCTAssertNil(transcript.pending, "\(id): the turn is over")
            XCTAssertEqual(shown(transcript), expected(after["transcript"]), id)
            XCTAssertEqual(box, phone(after["box"]) as? String, "\(id) box")
            XCTAssertEqual(transcript.error, phone(after["error"]) as? String, "\(id) error")
            XCTAssertEqual(transcript.retryQuestion, phone(after["retry"]) as? String, "\(id) Try again")
            if after.keys.contains("sources") {
                XCTAssertEqual(transcript.lines.last { $0.role == .assistant }?.sources ?? [], phone(after["sources"]) as? [String], "\(id) sources")
            }
            if after.keys.contains("thinking") { XCTAssertNil(phone(after["thinking"]), "\(id): the phone keeps no draft notes") }
        }
    }

    // MARK: history (D4)

    private static let context = #"{"unitSystem":"si"}"#

    func testWhatGoesBackAsHistory() throws {
        let rows = try XCTUnwrap((try table()["history"] as? Row)?["rows"] as? [Row]).filter(runsOnPhone)
        XCTAssertGreaterThan(rows.count, 0)
        for row in rows {
            let id = try XCTUnwrap(row["id"] as? String)
            var transcript = ChatTranscript()
            for turn in 0..<(row["answered"] as? Int ?? 0) {
                let index = transcript.ask("Question \(turn)")
                transcript.stream(.text("Answer \(turn)"), into: index)
                transcript.stream(.done(content: "Answer \(turn)", isFallback: false, error: nil), into: index)
                _ = transcript.finish(index, content: "Answer \(turn)")
            }
            if row["thenFailed"] as? Bool == true {
                _ = transcript.ask("This one fails")
                transcript.fail(URLError(.notConnectedToInternet))
            }
            if row["thenStopped"] as? Bool == true {
                let index = transcript.ask("This one stops")
                transcript.stream(.text("Half"), into: index)
                _ = transcript.stop()
            }
            // ChatView.ask reads the history before the question goes on screen.
            let earlier = transcript.history
            let body = try ChatClient.body(message: "The next question", conversationId: "c1", history: earlier, contextJSON: Self.context)
            let sent = try XCTUnwrap((try JSONSerialization.jsonObject(with: body) as? Row)?["history"] as? [Row], id)
            XCTAssertEqual(sent.count, phone(row["count"]) as? Int, id)
            let contents = sent.compactMap { $0["content"] as? String }
            XCTAssertFalse(contents.contains("This one fails"), id)
            XCTAssertFalse(contents.contains("This one stops"), id)
        }
    }

    // MARK: a long question (D5)

    func testALongQuestionIsSentAsTyped() throws {
        for row in try XCTUnwrap((try table()["question"] as? Row)?["rows"] as? [Row]) {
            let id = try XCTUnwrap(row["id"] as? String)
            let typed = (row["typed"] as? [Row] ?? []).map { String(repeating: $0["repeat"] as? String ?? "", count: $0["times"] as? Int ?? 0) }.joined()
            let body = try ChatClient.body(message: typed, conversationId: "c1", history: [], contextJSON: Self.context)
            let message = try XCTUnwrap((try JSONSerialization.jsonObject(with: body) as? Row)?["message"] as? String)
            XCTAssertEqual(message.utf16.count, phone(row["sentLength"]) as? Int, id)
            XCTAssertNil(phone(row["notice"]), "\(id): the phone says nothing of the length")
        }
    }
}
