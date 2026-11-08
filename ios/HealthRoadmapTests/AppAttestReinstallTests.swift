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

    private let report = LabFileReader.Document(name: "Report", pages: [], truncated: false)

    /// Possible codes for a stale key, not only `invalidKey`. Which one a reinstalled
    /// phone gives is not known yet; the on-screen suffix will tell.
    func testAStaleKeyFromTheLastInstallIsReplacedOnceAndTheReportGoes_US52_AC1c() async throws {
        for code in [DCError.Code.invalidKey, .invalidInput, .unknownSystemFailure] {
            reset()
            let fake = FakeAttest(staleCode: code)
            let client = LabUploadClient(attest: AppAttestClient(session: StubHTTP.session(), service: fake))
            _ = try await client.extract(report, unitSystem: "si")
            XCTAssertEqual(paths, ["/api/app/v1/attest/challenge", "/api/app/v1/attest/register", "/api/app/v1/lab-import"], "code \(code.rawValue)")
            XCTAssertEqual(labKey, "fresh-key-1", "the report is signed with the new key")
            XCTAssertEqual(Keychain.read(), "fresh-key-1", "the stale id is replaced")
            XCTAssertEqual(fake.made, 1)
        }
    }

    /// A new key that cannot sign either is not retried again, and the words name App Attest.
    @MainActor func testAKeyThatStillCannotSignStopsAfterOneNewKeyAndSaysWhere_US52_AC1c() async {
        let fake = FakeAttest(staleCode: .invalidInput, freshKeysFail: true)
        let client = LabUploadClient(attest: AppAttestClient(session: StubHTTP.session(), service: fake))
        do {
            _ = try await client.extract(report, unitSystem: "si")
            XCTFail("the assertion fails")
        } catch {
            XCTAssertEqual(fake.made, 1, "one new key, no loop")
            XCTAssertFalse(paths.contains("/api/app/v1/lab-import"), "nothing was sent")
            let words = "This iPhone could not prove the app is genuine, so nothing was sent. Please try again. (App Attest assert 3)"
            XCTAssertEqual(LabUploadSheet.words(for: error), words)
            XCTAssertEqual(ChatTranscript.words(for: error), words, "chat uses the same client")
        }
        // The words say "Please try again", so the review offers Try again.
        let failed = await LabUploadSheet.extractEach([report], extract: { _ in throw AppAttestClient.Failure.device(stage: "assert", code: "3") }, progress: { _, _ in })
        XCTAssertEqual(failed?.first?.failure, "This iPhone could not prove the app is genuine, so nothing was sent. Please try again. (App Attest assert 3)")
        XCTAssertNotNil(failed?.first?.retry, "an App Attest failure may mend, so Try again shows")
    }

    /// Once a launch, not once a request: the key this launch registered is never
    /// replaced, so a many-report ZIP spends one registration (adversary R1, AC1b's cap).
    func testAKeyThisLaunchRegisteredIsNotReplacedOnTheNextRequest_US52_AC1c() async {
        let fake = FakeAttest(staleCode: .invalidInput, freshKeysFail: true)
        let client = LabUploadClient(attest: AppAttestClient(session: StubHTTP.session(), service: fake))
        for _ in 0..<2 {
            do {
                _ = try await client.extract(report, unitSystem: "si")
                XCTFail("the assertion fails")
            } catch {
                guard case AppAttestClient.Failure.device(stage: "assert", code: "3") = error else { return XCTFail("\(error)") }
            }
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
        let client = LabUploadClient(attest: AppAttestClient(session: StubHTTP.session(), service: fake, keys: keys))
        for _ in 0..<2 { _ = try await client.extract(report, unitSystem: "si") }
        XCTAssertEqual(fake.made, 1, "one key for the launch")
        XCTAssertEqual(paths.filter { $0 == "/api/app/v1/attest/register" }.count, 1)
        XCTAssertEqual(paths.filter { $0 == "/api/app/v1/lab-import" }.count, 2, "both reports went")
        XCTAssertEqual(labKey, "fresh-key-1")
        XCTAssertNil(Keychain.read(), "the write failed, as the test meant")
    }
}
