import DeviceCheck
import XCTest
@testable import HealthRoadmap

/// US-52 AC1c: after a delete and reinstall the Keychain still holds the old key id, but
/// the key is gone. The phone makes and registers a new key once, then sends; a failure
/// that remains says it was App Attest, at which step, with which code.
final class AppAttestReinstallTests: XCTestCase {
    /// Stands in for DCAppAttestService: it knows only the keys it made, and an unknown
    /// key fails its assertion with `staleCode`, as a reinstalled phone's does.
    final class FakeAttest: AttestService, @unchecked Sendable {
        private let lock = NSLock()
        private var keys: Set<String> = []
        private(set) var made = 0
        let staleCode: DCError.Code
        let freshKeysFail: Bool

        init(staleCode: DCError.Code, freshKeysFail: Bool = false) {
            self.staleCode = staleCode
            self.freshKeysFail = freshKeysFail
        }

        var isSupported: Bool { true }
        func generateKey() async throws -> String {
            lock.withLock { made += 1; let id = "fresh-key-\(made)"; keys.insert(id); return id }
        }
        func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data { Data("attestation".utf8) }
        func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data {
            let known = lock.withLock { keys.contains(keyId) }
            if !known || freshKeysFail { throw DCError(known ? .invalidKey : staleCode) }
            return Data("assertion".utf8)
        }
    }

    private var paths: [String] = []
    private var labKey: String?

    override func setUp() { reset() }

    /// A stale id planted and the server stubbed, before each run.
    private func reset() {
        Keychain.save("key-from-the-last-install")
        paths = []
        labKey = nil
        StubHTTP.handler = { [unowned self] request in
            paths.append(request.url.path)
            switch request.url.path {
            case "/api/app/v1/attest/challenge": return .init(body: Data(#"{"challenge":"c"}"#.utf8))
            case "/api/app/v1/attest/register": return .init(body: Data(#"{"ok":true}"#.utf8))
            default:
                labKey = request.headers["x-app-attest-key"]
                return .init(body: Data(#"{"success":true,"data":{}}"#.utf8))
            }
        }
    }

    override func tearDown() {
        Keychain.delete()
    }

    /// One upload send of an empty report (LabReadSender, the shared upload's `send` effect).
    private let report = Data(#"{"pages":[],"unitSystem":"si"}"#.utf8)

    /// Possible codes for a stale key, not only `invalidKey`. Which one a reinstalled
    /// phone gives is not known yet; the on-screen suffix will tell.
    func testAStaleKeyFromTheLastInstallIsReplacedOnceAndTheReportGoes_US52_AC1c() async throws {
        for code in [DCError.Code.invalidKey, .invalidInput, .unknownSystemFailure] {
            reset()
            let fake = FakeAttest(staleCode: code)
            let sender = LabReadSender(attest: AppAttestClient(session: StubHTTP.session(), service: fake))
            _ = try await sender.send(report)
            XCTAssertEqual(paths, ["/api/app/v1/attest/challenge", "/api/app/v1/attest/register", LabReadSender.path], "code \(code.rawValue)")
            XCTAssertEqual(labKey, "fresh-key-1", "the report is signed with the new key")
            XCTAssertEqual(Keychain.read(), "fresh-key-1", "the stale id is replaced")
            XCTAssertEqual(fake.made, 1)
        }
    }

    /// A new key that cannot sign either is not retried again, and the failure names App Attest's
    /// step and code. The upload's words and its Try again for it are the engine's
    /// (UploadRefusalTests.testAFailedAssertionShowsItsStepAndCodeWithTryAgain); chat's are here.
    @MainActor func testAKeyThatStillCannotSignStopsAfterOneNewKeyAndSaysWhere_US52_AC1c() async throws {
        let fake = FakeAttest(staleCode: .invalidInput, freshKeysFail: true)
        let sender = LabReadSender(attest: AppAttestClient(session: StubHTTP.session(), service: fake))
        let outcome = try await sender.send(report)
        XCTAssertEqual(outcome, .local(.attestFailed(stage: "assert", code: "3")))
        XCTAssertEqual(fake.made, 1, "one new key, no loop")
        XCTAssertFalse(paths.contains(LabReadSender.path), "nothing was sent")
        let words = "This iPhone could not prove the app is genuine, so nothing was sent. Please try again. (App Attest assert 3)"
        XCTAssertEqual(ChatTranscript.words(for: AppAttestClient.Failure.device(stage: "assert", code: "3")), words)
    }

    /// Once a launch, not once a request: the key this launch registered is never
    /// replaced, so a many-report ZIP spends one registration (adversary R1, AC1b's cap).
    func testAKeyThisLaunchRegisteredIsNotReplacedOnTheNextRequest_US52_AC1c() async throws {
        let fake = FakeAttest(staleCode: .invalidInput, freshKeysFail: true)
        let sender = LabReadSender(attest: AppAttestClient(session: StubHTTP.session(), service: fake))
        for _ in 0..<2 {
            let outcome = try await sender.send(report)
            XCTAssertEqual(outcome, .local(.attestFailed(stage: "assert", code: "3")))
        }
        XCTAssertEqual(fake.made, 1, "one key for the launch")
        XCTAssertEqual(paths.filter { $0 == "/api/app/v1/attest/register" }.count, 1)
        XCTAssertEqual(Keychain.read(), "fresh-key-1")
    }

    /// The key this launch registered is used even when the Keychain did not keep it,
    /// so a failed Keychain write never costs a registration per report (Codex re-check).
    func testAKeyTheKeychainDidNotKeepIsStillUsedForTheLaunch_US52_AC1c() async throws {
        let fake = FakeAttest(staleCode: .invalidInput)
        let keys = KeyStore(read: Keychain.read, save: { _ in }, delete: Keychain.delete)
        let sender = LabReadSender(attest: AppAttestClient(session: StubHTTP.session(), service: fake, keys: keys))
        for _ in 0..<2 { _ = try await sender.send(report) }
        XCTAssertEqual(fake.made, 1, "one key for the launch")
        XCTAssertEqual(paths.filter { $0 == "/api/app/v1/attest/register" }.count, 1)
        XCTAssertEqual(paths.filter { $0 == LabReadSender.path }.count, 2, "both reports went")
        XCTAssertEqual(labKey, "fresh-key-1")
        XCTAssertNil(Keychain.read(), "the write failed, as the test meant")
    }
}
