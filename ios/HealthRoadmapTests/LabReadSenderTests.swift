import os
import XCTest
@testable import HealthRoadmap

/// Design PR 14 (US-52 AC7e): one send to the streaming lab route, as the engine reads it: the
/// stream's framing, the two deadlines, and the App Attest lock. StubHTTP is the server.
final class LabReadSenderTests: XCTestCase {
    typealias Kit = UploadTestKit
    private var server = Kit.Server()

    override func setUp() {
        server = Kit.Server()
        StubHTTP.stopped = 0
    }

    private static let page = LabFileReader.Page(type: "text", content: "x", mimeType: nil)
    private static let body = Data(#"{"pages":[]}"#.utf8)

    /// Bytes as a stream, for the line reader alone.
    private static func bytes(_ data: Data) -> AsyncStream<UInt8> {
        AsyncStream { continuation in
            for byte in data { continuation.yield(byte) }
            continuation.finish()
        }
    }

    // MARK: Lines

    /// Lines end at byte 0x0A only: U+2028, U+2029 and U+0085, which JSON leaves unescaped, stay
    /// inside the line; a final line with no newline counts; one trailing CR is dropped; 1 MB is one line.
    func testLinesEndOnlyAtNewline() async throws {
        let odd = #"{"status":200,"body":{"note":"a\#u{2028}b\#u{2029}c\#u{85}d"}}"#
        let line = try await LabReadSender.finalLine(Self.bytes(Data("{\"accepted\":true}\n\n\(odd)\n".utf8)))
        XCTAssertEqual(line, odd)
        let unended = try await LabReadSender.finalLine(Self.bytes(Data("{\"accepted\":true}\n\(odd)".utf8)))
        XCTAssertEqual(unended, odd)
        let crlf = try await LabReadSender.finalLine(Self.bytes(Data("{\"accepted\":true}\r\n\r\n\(odd)\r\n".utf8)))
        XCTAssertEqual(crlf, odd)
        let long = "{\"status\":200,\"body\":\"" + String(repeating: "é", count: 500_000) + "\"}"
        let big = try await LabReadSender.finalLine(Self.bytes(Data("{\"accepted\":true}\n\(long)\n".utf8)))
        XCTAssertEqual(big, long)
        let none = try await LabReadSender.finalLine(Self.bytes(Data("{\"accepted\":true}\n\n\n".utf8)))
        XCTAssertNil(none)
    }

    /// The same through the network, the body arriving in 5-byte pieces that split characters.
    func testAStreamInPiecesKeepsItsLine() async throws {
        let odd = #"{"status":200,"body":{"note":"é\#u{2028}漢字\#u{2029}"}}"#
        Kit.serve(server) { _ in Kit.read("{\"accepted\":true}\n\n\(odd)\n", chunk: 5) }
        let outcome = try await LabReadSender(attest: Kit.client()).send(Self.body)
        XCTAssertEqual(outcome, .ended(line: odd))
    }

    // MARK: Answers

    /// A refusal before any stream reaches the engine whole: its status, body and type.
    func testARefusalCarriesItsStatusBodyAndType() async throws {
        let text = #"{"success":false,"error":"Busy","reason":"unavailable"}"#
        Kit.serve(server) { _ in .init(status: 503, headers: Kit.json, body: Data(text.utf8)) }
        let outcome = try await LabReadSender(attest: Kit.client()).send(Self.body)
        XCTAssertEqual(outcome, .refused(status: 503, body: text, contentType: "application/json"))
        XCTAssertEqual(UploadRunner.event(for: outcome, run: 2, id: "f0"),
                       EngineNatives.json(["type": "sendFailed", "run": 2, "id": "f0", "status": 503, "body": text, "contentType": "application/json"]))
    }

    /// Only 200 is accepted: another 2xx is the server's failure, never a stream.
    func testOnly200IsAccepted() async throws {
        Kit.serve(server) { _ in .init(status: 202, headers: ["Content-Type": "application/x-ndjson"], body: Data("{\"accepted\":true}\n\(Kit.finalLine)\n".utf8)) }
        let outcome = try await LabReadSender(attest: Kit.client()).send(Self.body)
        guard case .refused(202, _, "application/x-ndjson") = outcome else { return XCTFail("\(outcome)") }
    }

    /// The flags go only when true, as the server's schema takes them.
    func testTheBodyCarriesOnlyTrueFlags() throws {
        let flags = LabReadSender.Flags(ownDates: true, undatedPrev: false, refusedRows: true)
        let body = try JSONSerialization.jsonObject(with: LabReadSender.body(pages: [Self.page], unitSystem: "si", flags: flags)) as? [String: Any]
        XCTAssertEqual(Set(body?.keys.map { $0 } ?? []), ["pages", "unitSystem", "ownDates", "refusedRows"])
    }

    // MARK: Deadlines and the lock

    /// The read deadline runs from the headers: five sends whose uploads are slow wait their turn
    /// for the lock longer than it, and none is cut off.
    func testASendQueuedBehindSlowUploadsIsNotCutOff() async throws {
        Kit.serve(server) { _ in Kit.read(delay: 0.3) }
        let sender = LabReadSender(attest: Kit.client(), readDeadline: .milliseconds(500))
        let outcomes = await withTaskGroup(of: LabReadSender.Outcome?.self) { group in
            for _ in 0..<5 { group.addTask { try? await sender.send(Self.body) } }
            return await group.reduce(into: []) { $0.append($1) }
        }
        XCTAssertEqual(outcomes, Array(repeating: .ended(line: Kit.finalLine), count: 5))
    }

    /// A read that never finishes ends at its deadline, once, and its request is cancelled for real.
    func testTheReadDeadlineCancelsTheRequest() async throws {
        let gate = StubHTTP.Gate()
        Kit.serve(server) { _ in Kit.read(gate: gate) }
        let outcome = try await LabReadSender(attest: Kit.client(), readDeadline: .milliseconds(300)).send(Self.body)
        XCTAssertEqual(outcome, LabReadSender.noAnswer)
        try await Kit.until("cancelled") { StubHTTP.stopped >= 1 }
        gate.open()
    }

    /// A send cancelled while it waits for the App Attest lock never signs and never sends.
    func testASendCancelledWhileWaitingForTheLockNeverSigns() async throws {
        let gate = StubHTTP.Gate()
        Kit.serve(server) { _ in .init(status: 200, headers: ["Content-Type": "application/x-ndjson"], body: Data("\(Kit.finalLine)\n".utf8), gate: gate) }
        let attest = Kit.Attest()
        let sender = LabReadSender(attest: Kit.client(attest))
        let first = Task { try await sender.send(Self.body) }
        try await Kit.until("the first holds the lock") { self.server.count == 1 }
        let second = Task { try await sender.send(Self.body) }
        try await Task.sleep(for: .milliseconds(100))
        second.cancel()
        let cancelled: Bool
        do { _ = try await second.value; cancelled = false } catch { cancelled = error is CancellationError }
        XCTAssertTrue(cancelled)
        gate.open()
        _ = try await first.value
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(attest.made.withLock { $0 }, 1, "the cancelled send never signed")
        XCTAssertEqual(server.count, 1)
    }
}
