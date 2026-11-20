import DeviceCheck
import XCTest
@testable import HealthRoadmap

/// US-52 AC7e: the app gate's refusals, the phone's App Attest outcomes and a request that failed on
/// the way, as the upload's view draws them through the real engine: today's iPhone words, and Try
/// again only where it mends.
@MainActor
final class UploadRefusalTests: XCTestCase {
    typealias Kit = UploadTestKit
    private var server = Kit.Server()

    override func setUp() {
        server = Kit.Server()
        StubHTTP.stopped = 0
    }

    private static let ok = StubHTTP.Answer(body: Data(#"{"ok":true}"#.utf8))
    private static let challenge = StubHTTP.Answer(body: Data(#"{"challenge":"c"}"#.utf8))

    /// `count` pictures picked; the failed section's lines, its Try again, and each file's reason.
    private func failed(count: Int = 1, attest: Kit.Attest = Kit.Attest(), stored: String? = "key", openDeadline: Duration = .seconds(20),
                        challenge: StubHTTP.Answer = challenge, register: StubHTTP.Answer = ok,
                        _ answer: @escaping @Sendable (Int) -> StubHTTP.Answer) async throws -> (lines: [String], retry: Bool, reasons: [String]) {
        Kit.serve(server, challenge: challenge, register: register, answer)
        let sender = LabReadSender(attest: Kit.client(attest, stored: stored), openDeadline: openDeadline)
        let runner = UploadRunner(engine: try HealthEngine(), model: UploadModel(), setup: .init(deviceId: "test", record: { "" }, sender: sender, frame: .milliseconds(1)))
        _ = await runner.pick(Kit.pictures(count), needsConsent: false)
        var found: ([String], Bool) = ([], false)
        try await Kit.until("every file failed and was drawn") {
            guard case .drawn(let text) = runner.model.state,
                  let view = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let failed = (view["sections"] as? [[String: Any]])?.first(where: { $0["kind"] as? String == "failed" }),
                  let rows = failed["rows"] as? [[String: Any]], rows.count == count else { return false }
            found = (rows.compactMap { $0["line"] as? String }, failed["retry"] is String)
            return true
        }
        return (found.0, found.1, await Kit.stages(runner).values.sorted())
    }

    private func failedLine(attest: Kit.Attest = Kit.Attest(), stored: String? = "key", openDeadline: Duration = .seconds(20),
                            challenge: StubHTTP.Answer = challenge, register: StubHTTP.Answer = ok,
                            _ answer: @escaping @Sendable (Int) -> StubHTTP.Answer) async throws -> (line: String?, retry: Bool) {
        let got = try await failed(attest: attest, stored: stored, openDeadline: openDeadline, challenge: challenge, register: register, answer)
        return (got.lines.first, got.retry)
    }

    nonisolated private static func gate(_ status: Int, _ error: String, _ reason: String) -> StubHTTP.Answer {
        .init(status: status, headers: Kit.json, body: Data(#"{"success":false,"error":"\#(error)","reason":"\#(reason)"}"#.utf8))
    }

    // MARK: The gate

    /// A 401 after the app's one retry for a lost key: the gate's words, no Try again.
    func testAFinal401ShowsTheGatesWordsWithoutTryAgain() async throws {
        let got = try await failedLine { n in
            n == 1 ? Self.gate(401, "This request was not signed by the app.", "unknown_key") : Self.gate(401, "This request was not signed by the app.", "bad_signature")
        }
        XCTAssertEqual(got.line, "This request was not signed by the app.")
        XCTAssertFalse(got.retry)
        XCTAssertEqual(server.count, 2, "the lost key was retried once, inside the app")
    }

    func testA413ShowsTheGatesWordsWithoutTryAgain() async throws {
        let got = try await failedLine { _ in Self.gate(413, "Request too large", "too_large") }
        XCTAssertEqual(got.line, "Request too large")
        XCTAssertFalse(got.retry)
    }

    func testAnUnknown4xxShowsTheGatesWordsWithoutTryAgain() async throws {
        let got = try await failedLine { _ in .init(status: 400, headers: Kit.json, body: Data(#"{"success":false,"error":"Invalid request"}"#.utf8)) }
        XCTAssertEqual(got.line, "Invalid request")
        XCTAssertFalse(got.retry)
    }

    /// The gate's 400 for an upload that did not arrive whole: the network's fault, so Try again.
    func testAnUploadThatDidNotArriveWholeOffersTryAgain() async throws {
        let got = try await failedLine { _ in Self.gate(400, "The request did not arrive whole. Please try again.", "body_read_failed") }
        XCTAssertEqual(got.line, "The request did not arrive whole. Please try again.")
        XCTAssertTrue(got.retry)
    }

    func testA503ShowsTheGatesWordsWithTryAgain() async throws {
        let got = try await failedLine { _ in Self.gate(503, "This is not available right now. Please try again later.", "unavailable") }
        XCTAssertEqual(got.line, "This is not available right now. Please try again later.")
        XCTAssertTrue(got.retry)
    }

    /// A refusal with no words of its own: today's fallback line.
    func testARefusalWithNoWordsShowsTodaysFallback() async throws {
        let got = try await failedLine { _ in .init(status: 413, headers: ["Content-Type": "text/html"], body: Data("<html>".utf8)) }
        XCTAssertEqual(got.line, "The server could not answer just now. Please try again later.")
        XCTAssertFalse(got.retry)
    }

    /// A read that failed on the server (a streamed 5xx): the server's own words, and Try again.
    func testAStreamedServerFailureKeepsTheServersWords() async throws {
        let got = try await failedLine { _ in Kit.read("{\"accepted\":true}\n{\"status\":500,\"body\":{\"success\":false,\"error\":\"Failed to process request\"}}\n") }
        XCTAssertEqual(got.line, "Failed to process request")
        XCTAssertTrue(got.retry)
    }

    // MARK: On the way

    func testNoConnectionShowsTodaysWordsWithTryAgain() async throws {
        let got = try await failedLine { _ in .init(offline: true) }
        XCTAssertEqual(got.line, "The server could not be reached. Check your connection, then try again.")
        XCTAssertTrue(got.retry)
    }

    func testADroppedConnectionShowsTodaysWordsWithTryAgain() async throws {
        let got = try await failedLine { _ in .init(failure: .networkConnectionLost) }
        XCTAssertEqual(got.line, "The connection dropped before the answer finished. Please try again.")
        XCTAssertTrue(got.retry)
    }

    func testARequestThatTakesTooLongShowsTodaysWordsWithTryAgain() async throws {
        let got = try await failedLine(openDeadline: .milliseconds(300)) { _ in .init(hang: true) }
        XCTAssertEqual(got.line, "The server took too long to answer. Please try again.")
        XCTAssertTrue(got.retry)
    }

    // MARK: App Attest

    /// A device without App Attest: nothing is sent; today's line, no Try again.
    func testADeviceThatCannotAttestSendsNothing() async throws {
        let got = try await failedLine(attest: Kit.Attest(supported: false)) { _ in Kit.read() }
        XCTAssertEqual(got.line, "Chat and lab upload need a device that can prove the app is genuine (Apple App Attest). This device cannot.")
        XCTAssertFalse(got.retry)
        XCTAssertEqual(server.count, 0)
    }

    /// An assertion that fails: nothing is sent; today's line with its step and code, and Try again.
    func testAFailedAssertionShowsItsStepAndCodeWithTryAgain() async throws {
        let got = try await failedLine(attest: Kit.Attest(assertFails: DCError(.invalidKey))) { _ in Kit.read() }
        XCTAssertEqual(got.line, "This iPhone could not prove the app is genuine, so nothing was sent. Please try again. (App Attest assert \(DCError.Code.invalidKey.rawValue))")
        XCTAssertTrue(got.retry)
        XCTAssertEqual(server.count, 0)
    }

    /// A registration refused under 500: the server's words and no Try again, so taps cannot spend
    /// registrations; its 429 is the registration's limit, not the upload's day, so the run goes on.
    func testARefusedRegistrationShowsItsWordsWithoutTryAgain() async throws {
        for (status, reason) in [(401, "bad_attestation"), (409, "key_exists"), (429, "limit")] {
            let got = try await failed(count: 2, stored: nil, register: Self.gate(status, "The app could not be registered (\(reason)).", reason)) { _ in Kit.read() }
            XCTAssertEqual(got.lines, Array(repeating: "The app could not be registered (\(reason)).", count: 2), "\(status)")
            XCTAssertFalse(got.retry, "\(status)")
            XCTAssertEqual(got.reasons, ["failed:appRefused", "failed:appRefused"], "\(status): never the daily limit")
            XCTAssertEqual(server.count, 0)
        }
    }

    /// A registration the server could not take (5xx), or a challenge that failed: Try again.
    func testARegistrationTheServerCouldNotTakeOffersTryAgain() async throws {
        let register = try await failedLine(stored: nil, register: Self.gate(503, "This is not available right now. Please try again later.", "unavailable")) { _ in Kit.read() }
        XCTAssertEqual(register.line, "This is not available right now. Please try again later.")
        XCTAssertTrue(register.retry)
        let challenge = try await failedLine(stored: nil, challenge: .init(status: 500)) { _ in Kit.read() }
        XCTAssertEqual(challenge.line, "Chat is not available right now. Please try again later.")
        XCTAssertTrue(challenge.retry)
    }

    /// The step and code are short words: a domain's dots and spaces never reach the engine, and a
    /// code from outside DeviceCheck is kept whole beside a shortened domain.
    func testAnAttestWordIsShortAndPlain() {
        XCTAssertEqual(LabReadSender.word("3"), "3")
        XCTAssertEqual(LabReadSender.word(""), "_")
        XCTAssertEqual(LabReadSender.attestFailed("assert", "3"), .attestFailed(stage: "assert", code: "3"))
        XCTAssertEqual(LabReadSender.attestFailed("assert", "NSURLErrorDomain -1009"), .attestFailed(stage: "assert", code: "NSURLErrorDomain_-1009"))
        XCTAssertEqual(LabReadSender.attestFailed("key", "com.apple.devicecheck.error 1234567"), .attestFailed(stage: "key", code: "com_apple_device_1234567"))
    }
}
