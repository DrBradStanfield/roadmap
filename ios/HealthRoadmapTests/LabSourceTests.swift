import XCTest
@testable import HealthRoadmap

/// US-52 AC10, AC11: "+" reads lab reports from the Dropbox app folder through
/// the engine's own dropbox-rest calls in JavaScriptCore, with the token
/// CloudSync keeps, against a stubbed Dropbox (StubHTTP). Node runs the engine
/// half in ios/engine/cloud.test.ts.
@MainActor
final class LabSourceTests: XCTestCase {
    private var folder: URL!
    private var tokens: TokenStore!
    /// What the stub saw; StubHTTP answers off the main thread, so a lock guards it.
    private final class Seen: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [StubHTTP.Request] = []
        func add(_ request: StubHTTP.Request) { lock.withLock { all.append(request) } }
        var requests: [StubHTTP.Request] { lock.withLock { all } }
    }
    private let seen = Seen()
    private var requests: [StubHTTP.Request] { seen.requests }
    /// Held for the test: the engine reaches CloudSync's tokens through a weak reference.
    private var sync: CloudSync?

    private static let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { context in
        context.beginPage()
        ("Synthetic Lab Report. LDL Cholesterol 3.1 mmol/L. Collected 2026-10-01." as NSString)
            .draw(in: CGRect(x: 40, y: 40, width: 530, height: 700), withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
    }

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Lab Sources \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        let seen = seen
        StubHTTP.handler = { request in
            seen.add(request)
            if request.url.path == "/oauth2/token" {
                return .init(body: Data(#"{"access_token":"token-1","refresh_token":"r","expires_in":14400,"account_id":"dbid:A"}"#.utf8))
            }
            guard request.headers["authorization"] == "Bearer token-1" else { return .init(status: 401) }
            if request.headers["dropbox-api-arg"] == #"{"path":"/health-roadmap.json"}"# {
                return .init(status: 409, body: Data(#"{"error_summary":"path/not_found/"}"#.utf8)) // no record yet
            }
            if request.url.path.hasSuffix("/files/list_folder") {
                return .init(body: Data(#"""
                {"entries":[
                  {".tag":"file","id":"id:record","name":"health-roadmap.json","size":900,"server_modified":"2026-10-22T01:00:00Z"},
                  {".tag":"folder","id":"id:imports","name":"imports"},
                  {".tag":"file","id":"id:old","name":"Lipids 2025.pdf","size":2000,"server_modified":"2025-03-01T00:00:00Z"},
                  {".tag":"file","id":"id:new","name":"Bloods October.pdf","size":3000,"server_modified":"2026-10-20T00:00:00Z"},
                  {".tag":"file","id":"id:ds","name":".DS_Store","size":10,"server_modified":"2026-10-21T00:00:00Z"}
                ],"has_more":false}
                """#.utf8))
            }
            if request.url.path.hasSuffix("/files/download") {
                return .init(body: LabSourceTests.pdf)
            }
            return .init(status: 500)
        }
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
    }

    /// The app's parts on the test folder and the stub, connected to Dropbox.
    private func app() throws -> (engine: HealthEngine, sync: CloudSync) {
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        self.sync = sync
        return (engine, sync)
    }

    func testTheListShowsOnlyLabFilesNewestFirstWithTheKeptToken() async throws {
        let (engine, sync) = try app()
        XCTAssertEqual(sync.provider, .dropbox)
        let files = try await engine.labFiles()
        XCTAssertEqual(files.map(\.name), ["Bloods October.pdf", "Lipids 2025.pdf"])
        XCTAssertEqual(files.first, HealthEngine.CloudLabFile(id: "id:new", name: "Bloods October.pdf", size: 3000, modified: "2026-10-20T00:00:00Z"))
        let list = try XCTUnwrap(requests.first { $0.url.path.hasSuffix("/files/list_folder") })
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: list.body) as? [String: Any])
        XCTAssertEqual(body["path"] as? String, "", "the app folder's root, where the connector reads too")
    }

    func testATappedFileDownloadsByItsIdAndReadsAsAPickedFile() async throws {
        let (engine, _) = try app()
        let listed = try await engine.labFiles()
        let file = try XCTUnwrap(listed.first)
        // A stale name on the phone: the file is read under the fresh listing's name (re-check R3).
        let stale = HealthEngine.CloudLabFile(id: file.id, name: "renamed since.zip", size: file.size, modified: file.modified)
        let fetched = try await engine.labFile(stale)
        XCTAssertEqual(fetched.name, "Bloods October.pdf")
        let download = try XCTUnwrap(requests.last { $0.url.path.hasSuffix("/files/download") })
        XCTAssertEqual(download.headers["dropbox-api-arg"], #"{"path":"id:new"}"#)
        let documents = try LabFileReader.documents(from: fetched.data, name: fetched.name)
        XCTAssertEqual(documents.map(\.name), ["Bloods October.pdf"])
        XCTAssertTrue(documents[0].pages[0].content.contains("LDL Cholesterol 3.1"))
    }

    /// Re-check R1: a refusal is told from a cloud failure by its marker, not by its
    /// first character, so a file named "{scan}.pdf" is still said in plain words.
    func testARefusalIsSaidInItsOwnWordsWhateverTheyStartWith() {
        let refusal = DropboxFailure(HealthEngine.EngineError.callFailed(#"{"refused":"{scan}.pdf is empty."}"#))
        XCTAssertEqual(refusal.errorDescription, "{scan}.pdf is empty.")
        let signIn = DropboxFailure(HealthEngine.EngineError.callFailed(#"{"kind":"sign-in","detail":"x"}"#))
        XCTAssertEqual(signIn.errorDescription, "Dropbox needs you to sign in again. Open From Dropbox to sign in.")
        let other = DropboxFailure(HealthEngine.EngineError.callFailed("{scan}.pdf: something odd"))
        XCTAssertEqual(other.errorDescription, "Dropbox could not be reached. Check the connection and try again.")
    }

    func testARevokedSignInIsClassedForTheScreen() async throws {
        tokens.delete(.dropbox)
        let (engine, _) = try app()
        do {
            _ = try await engine.labFiles()
            XCTFail("listing without a sign-in must fail")
        } catch {
            XCTAssertEqual(SyncProblem(error).kind, .signIn)
        }
    }

    /// Review (both reviewers): after "Sign in to Dropbox again" works, the screen
    /// lists afresh instead of staying on the sign-in error. This drives the model;
    /// that both Dropbox sign-in buttons call `signedIn()` through `connected:` was
    /// checked by reading LabSourceViews.swift, not by a UI test (re-check R4).
    func testASignInAfterARefusedListingListsAfresh() async throws {
        tokens.delete(.dropbox)
        let (engine, sync) = try app()
        let list = DropboxLabFolder(engine: engine, sync: sync)
        await list.refresh()
        XCTAssertEqual(list.load, .failed(.signIn))
        try await sync.connect(.dropbox) { url, _ in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "db-xf96vqvjotm5xhx://2/token?code=c&state=\(state)")!
        }
        await list.signedIn()
        guard case .files(let files) = list.load else { return XCTFail("still \(list.load)") }
        XCTAssertEqual(files.map(\.name), ["Bloods October.pdf", "Lipids 2025.pdf"])
    }

    // MARK: Reading on the phone (AC10, AC11)

    func testAFileOverTheWebsLimitIsRefusedBeforeItDownloads() {
        XCTAssertTrue(LabFileReader.fits(name: "a.pdf", bytes: 10 * 1024 * 1024))
        XCTAssertFalse(LabFileReader.fits(name: "a.pdf", bytes: 10 * 1024 * 1024 + 1))
        XCTAssertTrue(LabFileReader.fits(name: "a.ZIP", bytes: 20 * 1024 * 1024))
        XCTAssertFalse(LabFileReader.fits(name: "a.zip", bytes: 20 * 1024 * 1024 + 1))
    }

    func testPhotosAndScansGoAsJpegPagesOfOneReportWithinTheWebsPageLimit() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 60)).image { context in
            UIColor.gray.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 60))
        }
        let photo = try LabFileReader.pictures([image], name: "Photo")
        XCTAssertEqual(photo.pages.map(\.mimeType), ["image/jpeg"])
        XCTAssertFalse(photo.truncated)
        let scan = try LabFileReader.pictures(Array(repeating: image, count: LabFileReader.maxPages + 2), name: "Scanned report")
        XCTAssertEqual(scan.pages.count, LabFileReader.maxPages)
        XCTAssertTrue(scan.truncated)
        XCTAssertThrowsError(try LabFileReader.pictures([], name: "Nothing"))
    }
}
