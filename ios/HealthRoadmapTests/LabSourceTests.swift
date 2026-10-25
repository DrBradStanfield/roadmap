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
    /// The app folder the stub lists: each entry's `path_display` places it (US-52 AC13c).
    private final class Tree: @unchecked Sendable {
        private let lock = NSLock()
        private var all: [[String: Any]] = [
            [".tag": "file", "id": "id:record", "name": "health-roadmap.json", "path_display": "/health-roadmap.json", "size": 900, "server_modified": "2026-10-22T01:00:00Z"],
            [".tag": "folder", "id": "id:imports", "name": "imports", "path_display": "/imports"],
            [".tag": "file", "id": "id:old", "name": "Lipids 2025.pdf", "path_display": "/Lipids 2025.pdf", "size": 2000, "server_modified": "2025-03-01T00:00:00Z"],
            [".tag": "file", "id": "id:new", "name": "Bloods October.pdf", "path_display": "/Bloods October.pdf", "size": 3000, "server_modified": "2026-10-20T00:00:00Z"],
            [".tag": "file", "id": "id:ds", "name": ".DS_Store", "path_display": "/.DS_Store", "size": 10, "server_modified": "2026-10-21T00:00:00Z"],
        ]
        private var goneIds: Set<String> = []
        func add(_ entries: [[String: Any]]) { lock.withLock { all += entries } }
        /// Files deleted since the listing: their download answers not_found.
        func gone(_ id: String) { lock.withLock { _ = goneIds.insert(id) } }
        func isGone(_ arg: String?) -> Bool { lock.withLock { goneIds.contains { arg == #"{"path":"\#($0)"}"# } } }
        /// One folder's entries, or everything below it.
        func list(_ path: String, recursive: Bool) -> Data {
            let entries = lock.withLock { all }.filter { entry in
                let shown = entry["path_display"] as! String
                return recursive ? shown.hasPrefix(path + "/") : (shown as NSString).deletingLastPathComponent == (path.isEmpty ? "/" : path)
            }
            return try! JSONSerialization.data(withJSONObject: ["entries": entries, "has_more": false])
        }
    }
    private let tree = Tree()
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
        let tree = tree
        StubHTTP.handler = { request in
            seen.add(request)
            if request.url.path == "/oauth2/token" {
                return .init(body: Data(#"{"access_token":"token-1","refresh_token":"r","expires_in":14400,"account_id":"dbid:A"}"#.utf8))
            }
            guard request.headers["authorization"] == "Bearer token-1" else { return .init(status: 401) }
            if request.headers["dropbox-api-arg"] == #"{"path":"/health-roadmap.json"}"# {
                return .init(status: 409, body: Data(#"{"error_summary":"path/not_found/"}"#.utf8)) // no record yet
            }
            if request.url.path.hasSuffix("/files/list_folder"),
               let asked = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any] {
                return .init(body: tree.list(asked["path"] as? String ?? "", recursive: asked["recursive"] as? Bool ?? false))
            }
            if request.url.path.hasSuffix("/files/download") {
                if tree.isGone(request.headers["dropbox-api-arg"]) { return .init(status: 409, body: Data(#"{"error_summary":"path/not_found/"}"#.utf8)) }
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
        let files = try await engine.labFolder("").files
        XCTAssertEqual(files.map(\.name), ["Bloods October.pdf", "Lipids 2025.pdf"])
        XCTAssertEqual(files.first, HealthEngine.CloudLabFile(id: "id:new", name: "Bloods October.pdf", size: 3000, modified: "2026-10-20T00:00:00Z", path: "Bloods October.pdf"))
        let list = try XCTUnwrap(requests.first { $0.url.path.hasSuffix("/files/list_folder") })
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: list.body) as? [String: Any])
        XCTAssertEqual(body["path"] as? String, "", "the app folder's root, where the connector reads too")
    }

    func testATappedFileDownloadsByItsIdAndReadsAsAPickedFile() async throws {
        let (engine, _) = try app()
        let listed = try await engine.labFolder("").files
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
            _ = try await engine.labFolder("")
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
        guard case .files(let listing) = list.load else { return XCTFail("still \(list.load)") }
        XCTAssertEqual(listing.files.map(\.name), ["Bloods October.pdf", "Lipids 2025.pdf"])
    }

    // MARK: Dropbox folders (AC13c)

    /// A small tree under the app folder: Labs, with a report, a note and Labs/2025 with two more.
    private func addLabs() {
        tree.add([
            [".tag": "folder", "id": "id:labs", "name": "Labs", "path_display": "/Labs"],
            [".tag": "folder", "id": "id:2025", "name": "2025", "path_display": "/Labs/2025"],
            [".tag": "file", "id": "id:b", "name": "b.pdf", "path_display": "/Labs/b.pdf", "size": 3000, "server_modified": "2026-01-01T00:00:00Z"],
            [".tag": "file", "id": "id:note", "name": "note.txt", "path_display": "/Labs/note.txt", "size": 5],
            [".tag": "file", "id": "id:a10", "name": "a10.pdf", "path_display": "/Labs/2025/a10.pdf", "size": 3000, "server_modified": "2025-01-01T00:00:00Z"],
            [".tag": "file", "id": "id:a2", "name": "a2.pdf", "path_display": "/Labs/2025/a2.pdf", "size": 3000, "server_modified": "2025-02-01T00:00:00Z"],
        ])
    }

    func testAFolderOpensToItsSubfoldersAndItsOwnReports() async throws {
        addLabs()
        let (engine, sync) = try app()
        let root = try await engine.labFolder("")
        XCTAssertEqual(root.folders.map(\.name), ["Labs"], "imports/ is the app's own")
        let labs = try XCTUnwrap(root.folders.last)
        let list = DropboxLabFolder(engine: engine, sync: sync, folder: labs)
        await list.refresh()
        guard case .files(let listing) = list.load else { return XCTFail("still \(list.load)") }
        XCTAssertEqual(listing.folders, [HealthEngine.CloudLabFolder(name: "2025", path: "Labs/2025")])
        XCTAssertEqual(listing.files.map(\.name), ["b.pdf"])
        // A file in a subfolder downloads by id after a fresh listing of that folder.
        let fetched = try await engine.labFile(XCTUnwrap(listing.files.first))
        XCTAssertEqual(fetched.name, "b.pdf")
        let lists = requests.filter { $0.url.path.hasSuffix("/files/list_folder") }
            .compactMap { try? JSONSerialization.jsonObject(with: $0.body) as? [String: Any] }
        XCTAssertEqual(lists.last?["path"] as? String, "/Labs")
        XCTAssertEqual(requests.last { $0.url.path.hasSuffix("/files/download") }?.headers["dropbox-api-arg"], #"{"path":"id:b"}"#)
    }

    /// US-25 AC21 (merge review R2, Codex re-check R1): every report is decoded on the shared
    /// pool, never the main thread or the engine's queue, whether the engine's folder read or
    /// the sheet (a Files pick, a Dropbox file) asks.
    func testReportsAreDecodedOffTheMainThreadAndTheEnginesQueue() async throws {
        addLabs()
        let (engine, _) = try app()
        let onEngine = DispatchSpecificKey<Bool>()
        engine.queue.setSpecific(key: onEngine, value: true)
        let places = Places()
        LabFileReader.decodingWatch = {
            places.add(Thread.isMainThread ? "main" : DispatchQueue.getSpecific(key: onEngine) == true ? "engine" : "pool")
        }
        defer { LabFileReader.decodingWatch = nil }
        _ = try await engine.labFolderDocuments(.init(name: "Labs", path: "Labs"))
        let picked = folder.appending(path: "picked.pdf")
        try LabSourceTests.pdf.write(to: picked)
        _ = try await LabFileReader.decoded(picked: picked)
        _ = try await LabFileReader.decoded(LabSourceTests.pdf, name: "b.pdf")
        XCTAssertEqual(places.all, Array(repeating: "pool", count: 5), "three folder reports, a pick, a Dropbox file")
    }

    /// US-25 AC21: a photo and a camera scan are resized on the shared pool too, never the
    /// main thread (LabUploadSheet awaits them).
    func testPhotosAndScansAreResizedOffTheMainThread() async throws {
        let places = Places()
        LabFileReader.decodingWatch = { places.add(Thread.isMainThread ? "main" : "pool") }
        defer { LabFileReader.decodingWatch = nil }
        let image = UIGraphicsImageRenderer(size: CGSize(width: 2400, height: 3200)).image { context in
            UIColor.gray.setFill(); context.fill(CGRect(x: 0, y: 0, width: 2400, height: 3200))
        }
        let photo = try await LabFileReader.photo(try XCTUnwrap(image.jpegData(compressionQuality: 0.9)))
        _ = try await LabFileReader.pictures([image, image], name: "Scanned report")
        XCTAssertEqual(places.all, ["pool", "pool"], "a photo, a scan")
        XCTAssertEqual(photo.name, "Photo")
        let page = try XCTUnwrap(UIImage(data: try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(photo.pages.first).content))))
        XCTAssertEqual(max(page.size.width, page.size.height), 2000, "the long side is resized to the web's 2,000")
        do {
            _ = try await LabFileReader.photo(Data("not a picture".utf8))
            XCTFail("bytes that are no picture are refused")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The photo could not be opened.")
        }
    }
    private final class Places: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [String] = []
        func add(_ place: String) { lock.withLock { seen.append(place) } }
        var all: [String] { lock.withLock { seen } }
    }

    /// The whole folder reads as a folder picked in Files does: name order, by place.
    func testAWholeFolderReadsEveryReportInsideItInNameOrder() async throws {
        addLabs()
        let (engine, _) = try app()
        var seenProgress: [[Int]] = []
        let documents = try await engine.labFolderDocuments(.init(name: "Labs", path: "Labs")) { seenProgress.append([$0, $1]) }
        XCTAssertEqual(documents.map(\.name), ["Labs/2025/a2.pdf", "Labs/2025/a10.pdf", "Labs/b.pdf"])
        XCTAssertEqual(seenProgress, [[0, 3], [1, 3], [2, 3]])
        XCTAssertTrue(documents.allSatisfy { $0.original != nil })
        let downloads = requests.filter { $0.url.path.hasSuffix("/files/download") }.map { $0.headers["dropbox-api-arg"] }
        XCTAssertEqual(downloads, [#"{"path":"id:a2"}"#, #"{"path":"id:a10"}"#, #"{"path":"id:b"}"#])
        // One listing for the whole read, not one per file (review R2).
        XCTAssertEqual(requests.filter { $0.url.path.hasSuffix("/files/list_folder") }.count, 1)
        // The root's whole read names files by their place below it, with no folder name.
        let all = try await engine.labFolderDocuments(DropboxLabFolder.root)
        XCTAssertEqual(all.map(\.name), ["Bloods October.pdf", "Labs/2025/a2.pdf", "Labs/2025/a10.pdf", "Labs/b.pdf", "Lipids 2025.pdf"])
    }

    func testAWholeFolderReadsAtMostTwoHundredFiles() async throws {
        tree.add((1...LabFileReader.maxFolderFiles + 5).map { n in
            [".tag": "file", "id": "id:many\(n)", "name": "r\(n).pdf", "path_display": "/Many/r\(n).pdf", "size": 3000]
        })
        let (engine, _) = try app()
        let documents = try await engine.labFolderDocuments(.init(name: "Many", path: "Many"))
        XCTAssertEqual(documents.count, LabFileReader.maxFolderFiles)
        XCTAssertEqual(documents.first?.name, "Many/r1.pdf")
        XCTAssertEqual(documents.last?.name, "Many/r200.pdf")
        XCTAssertEqual(requests.filter { $0.url.path.hasSuffix("/files/download") }.count, LabFileReader.maxFolderFiles)
    }

    func testAWholeFolderWithAFileOverTheLimitIsRefusedBeforeAnyDownload() async throws {
        addLabs()
        tree.add([[".tag": "file", "id": "id:big", "name": "big.pdf", "path_display": "/Labs/big.pdf", "size": LabFileReader.maxFileBytes + 1]])
        let (engine, _) = try app()
        do {
            _ = try await engine.labFolderDocuments(.init(name: "Labs", path: "Labs"))
            XCTFail("an oversized file must refuse the folder")
        } catch {
            XCTAssertEqual(error.localizedDescription, LabFileReader.Failure.tooLarge("big.pdf").localizedDescription)
        }
        XCTAssertFalse(requests.contains { $0.url.path.hasSuffix("/files/download") })
    }

    func testAFolderOverTwoHundredMegabytesInAllIsRefusedInItsOwnWords() async throws {
        tree.add((1...21).map { n in
            [".tag": "file", "id": "id:heavy\(n)", "name": "h\(n).pdf", "path_display": "/Heavy/h\(n).pdf", "size": LabFileReader.maxFileBytes]
        })
        let (engine, _) = try app()
        do {
            _ = try await engine.labFolderDocuments(.init(name: "Heavy", path: "Heavy"))
            XCTFail("more than 200 MB must refuse the folder")
        } catch {
            XCTAssertEqual(error.localizedDescription, "This folder holds more than 200 MB of reports. Pick a smaller folder, or the reports one at a time.")
        }
        XCTAssertFalse(requests.contains { $0.url.path.hasSuffix("/files/download") })
    }

    /// At the root, the app's own folders neither list nor read (the engine half: cloud.test.ts).
    func testTheRootLeavesOutTheAppsOwnFolders() async throws {
        addLabs()
        tree.add([
            [".tag": "folder", "id": "id:lr", "name": "Lab results", "path_display": "/Lab results"],
            [".tag": "file", "id": "id:kept", "name": "kept.pdf", "path_display": "/Lab results/kept.pdf", "size": 3000],
            [".tag": "file", "id": "id:parked", "name": "parked.pdf", "path_display": "/imports/parked.pdf", "size": 3000],
        ])
        let (engine, _) = try app()
        let root = try await engine.labFolder("")
        XCTAssertEqual(root.folders.map(\.name), ["Labs"])
        XCTAssertEqual(root.hidden, ["imports", "Lab results"], "named in the root's footer (review R6)")
        let all = try await engine.labFolderDocuments(DropboxLabFolder.root)
        XCTAssertFalse(all.contains { $0.name.hasPrefix("Lab results/") || $0.name.hasPrefix("imports/") })
    }

    /// Review R1: a read the person walked away from stops before the next download.
    func testACancelledWholeFolderReadStopsBeforeTheNextDownload() async throws {
        addLabs()
        let (engine, _) = try app()
        let read = Task { @MainActor in
            try await engine.labFolderDocuments(.init(name: "Labs", path: "Labs")) { done, _ in
                if done == 1 { withUnsafeCurrentTask { $0?.cancel() } }
            }
        }
        let result = await read.result
        XCTAssertThrowsError(try result.get()) { XCTAssertTrue($0 is CancellationError, "\($0)") }
        XCTAssertEqual(requests.filter { $0.url.path.hasSuffix("/files/download") }.count, 1)
    }

    /// Codex: every send the sheet starts, the one after first-use consent included, is
    /// its tracked work; once Close cancels it, no further report is sent and no review opens.
    func testACancelledSendSendsNoFurtherReports() async {
        let documents = (1...3).map { LabFileReader.Document(name: "r\($0).pdf", pages: [], truncated: false) }
        let outcome = await Task { @MainActor () -> ([LabResult]?, [String]) in
            var sent: [String] = []
            let results = await LabUploadSheet.extractEach(documents, extract: { document in
                sent.append(document.name)
                withUnsafeCurrentTask { $0?.cancel() }
                return "{}"
            }, progress: { _, _ in })
            return (results, sent)
        }.value
        XCTAssertNil(outcome.0, "no review for a closed sheet")
        XCTAssertEqual(outcome.1, ["r1.pdf"])
        // Not cancelled: every report is sent, in order.
        let all = await LabUploadSheet.extractEach(documents, extract: { _ in "{}" }, progress: { _, _ in })
        XCTAssertEqual(all?.map(\.name), ["r1.pdf", "r2.pdf", "r3.pdf"])
    }

    /// Review R3: the reports' bytes are held to the cap as they are read, whatever the listing said.
    func testAWholeFolderStopsWhenItsReportsOutgrowTheCap() async throws {
        tree.add((1...3).map { n in
            [".tag": "file", "id": "id:small\(n)", "name": "s\(n).pdf", "path_display": "/Small/s\(n).pdf", "size": 1]
        })
        let (engine, _) = try app()
        do {
            _ = try await engine.labFolderDocuments(.init(name: "Small", path: "Small"), maxBytes: LabSourceTests.pdf.count * 3 / 2)
            XCTFail("the second report passes the cap")
        } catch {
            XCTAssertEqual(error.localizedDescription, LabFileReader.Failure.folderTooLarge.localizedDescription)
        }
        XCTAssertEqual(requests.filter { $0.url.path.hasSuffix("/files/download") }.count, 2)
    }

    /// Review R5: the folder's own words for an empty folder and for a file gone mid-read.
    func testAnEmptyOrChangedFolderIsSaidAsAFolder() async throws {
        addLabs()
        tree.add([[".tag": "file", "id": "id:txt", "name": "only.txt", "path_display": "/Notes/only.txt", "size": 5]])
        tree.gone("id:a10")
        let (engine, _) = try app()
        do {
            _ = try await engine.labFolderDocuments(.init(name: "Notes", path: "Notes"))
            XCTFail("no reports")
        } catch {
            XCTAssertEqual(error.localizedDescription, "This folder holds no reports the app can read: no PDF, JPEG, PNG or ZIP.")
        }
        do {
            _ = try await engine.labFolderDocuments(.init(name: "Labs", path: "Labs"))
            XCTFail("a file went")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The folder changed while it was read. Try again.")
        }
    }

    func testAWholeFolderWithoutASignInSaysSoInTheSheetsWords() async throws {
        tokens.delete(.dropbox)
        let (engine, _) = try app()
        do {
            _ = try await engine.labFolderDocuments(.init(name: "Labs", path: "Labs"))
            XCTFail("listing without a sign-in must fail")
        } catch {
            XCTAssertEqual(error.localizedDescription, "Dropbox needs you to sign in again. Open From Dropbox to sign in.")
        }
    }

    // MARK: Reading on the phone (AC10, AC11)

    func testAFileOverTheWebsLimitIsRefusedBeforeItDownloads() {
        XCTAssertTrue(LabFileReader.fits(name: "a.pdf", bytes: 10 * 1024 * 1024))
        XCTAssertFalse(LabFileReader.fits(name: "a.pdf", bytes: 10 * 1024 * 1024 + 1))
        XCTAssertTrue(LabFileReader.fits(name: "a.ZIP", bytes: 20 * 1024 * 1024))
        XCTAssertFalse(LabFileReader.fits(name: "a.zip", bytes: 20 * 1024 * 1024 + 1))
    }

    func testPhotosAndScansGoAsJpegPagesOfOneReportWithinTheWebsPageLimit() async throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 60)).image { context in
            UIColor.gray.setFill(); context.fill(CGRect(x: 0, y: 0, width: 40, height: 60))
        }
        let photo = try await LabFileReader.pictures([image], name: "Photo")
        XCTAssertEqual(photo.pages.map(\.mimeType), ["image/jpeg"])
        XCTAssertFalse(photo.truncated)
        let scan = try await LabFileReader.pictures(Array(repeating: image, count: LabFileReader.maxPages + 2), name: "Scanned report")
        XCTAssertEqual(scan.pages.count, LabFileReader.maxPages)
        XCTAssertTrue(scan.truncated)
        let nothing = try? await LabFileReader.pictures([], name: "Nothing")
        XCTAssertNil(nothing, "no picture, no report")
    }

    /// US-52 AC13c: a picked folder gives every report in it and its folders, in name
    /// order, named by their place in the folder; other and hidden files are left out.
    func testAFolderGivesEveryReportInsideItInNameOrder() throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Records-\(UUID().uuidString)")
        let inner = folder.appending(path: "2025")
        try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let png = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).pngData { context in
            UIColor.gray.setFill(); context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }
        try png.write(to: folder.appending(path: "b.png"))
        try png.write(to: inner.appending(path: "a.PNG"))
        try png.write(to: folder.appending(path: ".hidden.png"))
        try Data("notes".utf8).write(to: folder.appending(path: "notes.txt"))
        let names = try LabFileReader.documents(inFolder: folder).map(\.name)
        XCTAssertEqual(names, ["\(folder.lastPathComponent)/2025/a.PNG", "\(folder.lastPathComponent)/b.png"])

        let empty = FileManager.default.temporaryDirectory.appending(path: "Empty-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: empty) }
        XCTAssertThrowsError(try LabFileReader.documents(inFolder: empty))
    }
}
