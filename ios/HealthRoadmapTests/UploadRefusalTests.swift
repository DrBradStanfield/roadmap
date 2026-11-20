import DeviceCheck
import XCTest
@testable import HealthRoadmap

/// US-52 AC7e: the app gate's refusals and the phone's own App Attest failures, as the upload's
/// view draws them through the real engine: today's iPhone words, and Try again only where it mends.
@MainActor
final class UploadRefusalTests: XCTestCase {
    typealias Kit = UploadTestKit
    private var server = Kit.Server()

    override func setUp() {
        server = Kit.Server()
        StubHTTP.stopped = 0
    }

    /// One picture picked; the failed section's line and its Try again, once the file fails.
    private func failedLine(attest: Kit.Attest = Kit.Attest(), _ answer: @escaping @Sendable (Int) -> StubHTTP.Answer) async throws -> (line: String?, retry: Bool) {
        Kit.serve(server, answer)
        let setup = UploadRunner.Setup(deviceId: "test", record: { "" }, sender: LabReadSender(attest: Kit.client(attest)), frame: .milliseconds(1))
        let runner = UploadRunner(engine: try HealthEngine(), model: UploadModel(), setup: setup)
        _ = await runner.pick(Kit.pictures(1), needsConsent: false)
        var found: (String?, Bool) = (nil, false)
        try await Kit.until("the file failed and was drawn") {
            guard case .drawn(let text) = runner.model.state,
                  let view = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let failed = (view["sections"] as? [[String: Any]])?.first(where: { $0["kind"] as? String == "failed" }),
                  let row = (failed["rows"] as? [[String: Any]])?.first else { return false }
            found = (row["line"] as? String, failed["retry"] is String)
            return true
        }
        return found
    }

    nonisolated private static func gate(_ status: Int, _ error: String, _ reason: String) -> StubHTTP.Answer {
        .init(status: status, headers: Kit.json, body: Data(#"{"success":false,"error":"\#(error)","reason":"\#(reason)"}"#.utf8))
    }

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

    /// The step and code are short words: a domain's dots and spaces never reach the engine.
    func testAnAttestWordIsShortAndPlain() {
        XCTAssertEqual(LabReadSender.word("3"), "3")
        XCTAssertEqual(LabReadSender.word("NSURLErrorDomain -1009"), "NSURLErrorDomain_-1009")
        XCTAssertEqual(LabReadSender.word("com.apple.devicecheck.error 3"), "com_apple_devicecheck_er")
        XCTAssertEqual(LabReadSender.word(""), "_")
    }
}
