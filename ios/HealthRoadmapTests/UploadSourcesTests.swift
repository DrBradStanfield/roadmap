import os
import UIKit
import XCTest
@testable import HealthRoadmap

/// US-52 AC8c, AC10, AC13c: every source takes the shared upload's one page, as a file from Files
/// does: a photo, a scan, a folder. Each pick goes through `UploadSession.start` as the sheet starts
/// it, then the real engine; the server is StubHTTP. Synthetic files only.
@MainActor
final class UploadSourcesTests: XCTestCase {
    typealias Kit = UploadTestKit
    private var folder: URL!
    private var server = Kit.Server()

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Upload Sources \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        server = Kit.Server()
        StubHTTP.stopped = 0
        // Each read answers a letter, titled by the read's number.
        let server = server
        StubHTTP.handler = { _ in
            let n = server.seen.withLock { $0.append(""); return $0.count }
            let line = #"{"status":200,"body":{"success":true,"data":\#(UploadPageTests.letter("Letter \(n)"))}}"#
            return Kit.read("{\"accepted\":true}\n\(line)\n")
        }
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private func phone() throws -> RecordStore {
        try RecordStore(folder: folder, engine: HealthEngine(session: StubHTTP.session()), deviceId: "ios-test")
    }

    private func session(_ store: RecordStore) -> UploadSession {
        UploadSession(engine: store.engine, store: store, sender: LabReadSender(attest: Kit.client()), frame: .milliseconds(1))
    }

    private func page(_ session: UploadSession) -> UploadPage? {
        if case .drawn(let text) = session.model.state { session.page(text) } else { nil }
    }

    private func until(_ what: String, line: UInt = #line, _ check: () async -> Bool) async throws { try await Kit.until(what, line: line, check) }

    private static func picture(_ shade: CGFloat, width: CGFloat = 300, height: CGFloat = 400) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: width, height: height)).image { context in
            UIColor(white: shade, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
    }

    private func files(_ names: [String], in place: URL) throws {
        try FileManager.default.createDirectory(at: place, withIntermediateDirectories: true)
        for (n, name) in names.enumerated() {
            try XCTUnwrap(Self.picture(CGFloat(n + 1) / 10, width: CGFloat(20 + n), height: 20).pngData()).write(to: place.appending(path: name))
        }
    }

    // MARK: Photos and Scan

    /// A photo goes through the same consent, read and review as a file: nothing leaves the phone
    /// before the agree, then one read, one row named "Photo.jpg", and one Save that writes it.
    func testAPhotoGoesThroughConsentReadAndReviewAsAFileDoes_US52_AC10() async throws {
        let store = try phone()
        let upload = session(store)
        defer { upload.end() }
        let jpeg = try XCTUnwrap(Self.picture(0.5).jpegData(compressionQuality: 0.9))
        let started = await upload.start({ [try await LabFileReader.picked(photo: jpeg)] }, needsConsent: true)
        XCTAssertEqual(started, .running)
        try await until("consent") { page(upload)?.phase == "consent" }
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(server.count, 0, "nothing leaves the phone before the agree")
        await upload.runner.consented()
        try await until("read") { page(upload)?.save.enabled == true }
        XCTAssertEqual(server.count, 1)
        XCTAssertEqual(page(upload)?.files.rows.map(\.name), ["Photo.jpg"])
        XCTAssertEqual(page(upload)?.save.label, "Save 1 document")
        upload.send(.save)
        try await until("done") { page(upload)?.done != nil }
        XCTAssertTrue(store.recordJSON.contains("Letter 1"))
    }

    /// A scan of several pages is ONE file in the upload: one row, one read, one letter.
    func testAScanOfSeveralPagesIsOneEntry_US52_AC10() async throws {
        let store = try phone()
        let upload = session(store)
        defer { upload.end() }
        let pages = [Self.picture(0.2), Self.picture(0.4), Self.picture(0.6)]
        let started = await upload.start({ [try await LabFileReader.picked(scan: pages)] }, needsConsent: false)
        XCTAssertEqual(started, .running)
        try await until("read") { page(upload)?.save.enabled == true }
        XCTAssertEqual(server.count, 1, "one read for the whole scan")
        XCTAssertEqual(page(upload)?.files.rows.map(\.name), ["Scanned report.pdf"])
        XCTAssertEqual(page(upload)?.documents?.rows.count, 1)
    }

    // MARK: A folder

    /// A folder of 5 reports, 2 already in the record: one page and one Save; the 2 are counted
    /// and never sent or offered.
    func testAFolderOfFiveIsOnePageWithOneSaveAndKnownFilesNeverSent_US52_AC13c() async throws {
        let store = try phone()
        let records = folder.appending(path: "Records", directoryHint: .isDirectory)
        try files(["r1.png", "r2.png", "r3.png", "r4.png", "r5.png"], in: records)
        // Two of them saved first, from Files one at a time.
        let first = session(store)
        _ = await first.start({ [try await LabFileReader.picked(records.appending(path: "r1.png"), ask: LabSourceTests.rules),
                                 try await LabFileReader.picked(records.appending(path: "r2.png"), ask: LabSourceTests.rules)].flatMap { $0 } },
                            needsConsent: false)
        try await until("two read") { page(first)?.save.enabled == true }
        first.send(.save)
        try await until("two saved") { page(first)?.done != nil }
        first.send(.close)
        first.end()
        let sentBefore = server.count

        let upload = session(store)
        defer { upload.end() }
        let started = await upload.start({ try await LabFileReader.picked(records, ask: LabSourceTests.rules) }, needsConsent: false)
        XCTAssertEqual(started, .running)
        try await until("all settled") { page(upload)?.save.enabled == true }
        let page = try XCTUnwrap(page(upload))
        XCTAssertEqual(server.count - sentBefore, 3, "the 2 known files were never sent")
        XCTAssertTrue(page.summary.hasPrefix("5 files: 2 already in your record"), page.summary)
        XCTAssertEqual(page.files.rows.filter { $0.status == "Already in your record" }.count, 2)
        XCTAssertEqual(page.documents?.rows.count, 3)
        XCTAssertEqual(page.save.label, "Save 3 documents")
        upload.send(.save)
        try await until("done") { self.page(upload)?.done != nil }
        XCTAssertEqual(self.page(upload)?.done?.line, "Saved 3 documents.")
    }

    // MARK: Refusals

    /// A file over its cap is refused in the engine's words on the page, never read or sent; the
    /// other file in the pick still reads.
    func testAnOversizedFileIsRefusedInTheEnginesWords_US52_AC7() async throws {
        let store = try phone()
        let upload = session(store)
        defer { upload.end() }
        let big = folder.appending(path: "big.pdf")
        FileManager.default.createFile(atPath: big.path, contents: nil, attributes: [.posixPermissions: 0o200])
        let handle = try FileHandle(forWritingTo: big)
        try handle.truncate(atOffset: UInt64(LabFileReader.maxFileBytes + 1))
        try handle.close()
        let started = await upload.start({ try await LabFileReader.picked(big, ask: LabSourceTests.rules) }, needsConsent: false)
        XCTAssertEqual(started, .running)
        try await until("refused row") { page(upload)?.files.rows.first?.status == "Too large to read" }
        XCTAssertEqual(page(upload)?.files.rows.map(\.name), ["big.pdf"])
        try await Task.sleep(for: .milliseconds(200))
        XCTAssertEqual(server.count, 0)
        let held = await upload.runner.heldBytes
        XCTAssertEqual(held, 0, "a refused file is forgotten")
    }

    /// Close while a pick is first read, from each source: the pick is never held or sent.
    func testCloseDuringTheFirstReadOfEachSourceHoldsAndSendsNothing_US52_AC7a() async throws {
        let store = try phone()
        let records = folder.appending(path: "Close", directoryHint: .isDirectory)
        try files(["a.png", "b.png"], in: records)
        let jpeg = try XCTUnwrap(Self.picture(0.5).jpegData(compressionQuality: 0.9))
        let page = Self.picture(0.3)
        let sources: [(String, @Sendable () async throws -> [UploadRunner.Picked])] = [
            ("a file", { try await LabFileReader.picked(records.appending(path: "a.png"), ask: LabSourceTests.rules) }),
            ("a folder", { try await LabFileReader.picked(records, ask: LabSourceTests.rules) }),
            ("a photo", { [try await LabFileReader.picked(photo: jpeg)] }),
            ("a scan", { [try await LabFileReader.picked(scan: [page, page])] }),
        ]
        for (source, read) in sources {
            let upload = session(store)
            // The sheet's Close cancels the task reading the pick (LabUploadSheet.leave).
            let started = await Task { @MainActor in
                await upload.start({
                    let picked = try await read()
                    withUnsafeCurrentTask { $0?.cancel() }
                    return picked
                }, needsConsent: false)
            }.value
            XCTAssertEqual(started, .running, source)
            try await Task.sleep(for: .milliseconds(200))
            let held = await upload.runner.heldBytes
            let state = await upload.runner.stateText
            XCTAssertEqual(held, 0, "\(source): nothing held")
            XCTAssertNil(state, "\(source): the engine never had the pick")
            XCTAssertEqual(server.count, 0, "\(source): nothing sent")
            upload.end()
        }
    }

    /// A pick from each source after a run that was refused, or that finished, starts cleanly: the
    /// sheet makes a new session for it, and it reads.
    func testAPickAfterARefusedOrFinishedRunStartsCleanly_US52_AC8c() async throws {
        let store = try phone()
        let empty = folder.appending(path: "Empty", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: empty, withIntermediateDirectories: true)
        let refused = session(store)
        let words = await refused.start({ try await LabFileReader.picked(empty, ask: LabSourceTests.rules) }, needsConsent: false)
        XCTAssertEqual(words, .refused("This folder holds no reports the app can read: no PDF, JPEG or PNG."))
        refused.end()

        let jpeg = try XCTUnwrap(Self.picture(0.5).jpegData(compressionQuality: 0.9))
        let photo = session(store)
        _ = await photo.start({ [try await LabFileReader.picked(photo: jpeg)] }, needsConsent: false)
        try await until("the photo read") { page(photo)?.save.enabled == true }
        photo.send(.save)
        try await until("the photo saved") { page(photo)?.done != nil }
        photo.send(.close)
        photo.end()

        let scan = session(store)
        defer { scan.end() }
        let sheet = Self.picture(0.7)
        _ = await scan.start({ [try await LabFileReader.picked(scan: [sheet])] }, needsConsent: false)
        try await until("the scan read") { page(scan)?.save.enabled == true }
        XCTAssertEqual(page(scan)?.files.rows.map(\.name), ["Scanned report.pdf"])
        XCTAssertEqual(server.count, 2)
    }

    // MARK: Screenshots

    /// A photo and a scan on the one page, read and saved, for the design review. Runs only when
    /// TEST_RUNNER_UPLOAD_SHOTS names a folder (UploadReviewShots).
    func testShootAPhotoAndAScanOnThePage() async throws {
        guard let out = ProcessInfo.processInfo.environment["UPLOAD_SHOTS"] else { throw XCTSkip("no shots folder") }
        let store = try phone()
        let jpeg = try XCTUnwrap(Self.picture(0.5).jpegData(compressionQuality: 0.9))
        let pages = [Self.picture(0.2), Self.picture(0.4), Self.picture(0.6)]
        let sources: [(String, @Sendable () async throws -> [UploadRunner.Picked])] = [
            ("photo", { [try await LabFileReader.picked(photo: jpeg)] }),
            ("scan", { [try await LabFileReader.picked(scan: pages)] }),
        ]
        for (name, read) in sources {
            let upload = session(store)
            _ = await upload.start(read, needsConsent: false)
            try await until("\(name) read") { page(upload)?.save.enabled == true }
            try UploadReviewShots.shoot(try XCTUnwrap(page(upload)), to: "\(out)/\(name)-review.png")
            upload.send(.save)
            try await until("\(name) saved") { page(upload)?.done != nil }
            try UploadReviewShots.shoot(try XCTUnwrap(page(upload)), to: "\(out)/\(name)-done.png")
            upload.send(.close)
            upload.end()
        }
    }

    // MARK: Off the main thread

    /// US-25 AC21: every report is converted (PDF read, picture resized) on the shared pool, never
    /// the main thread, whatever the source.
    func testReportsAreConvertedOffTheMainThread_US25_AC21() async throws {
        let places = OSAllocatedUnfairLock(initialState: [String]())
        let held = LabFileReader.Held(beforeKeeping: { _ in places.withLock { $0.append(Thread.isMainThread ? "main" : "pool") } })
        let setup = UploadRunner.Setup(deviceId: "test", record: { "" }, ask: LabSourceTests.rules, sender: LabReadSender(attest: Kit.client()),
                                       frame: .milliseconds(1), held: held)
        let runner = UploadRunner(engine: try HealthEngine(), model: UploadModel(), setup: setup)
        let jpeg = try XCTUnwrap(Self.picture(0.5).jpegData(compressionQuality: 0.9))
        let picks = [try await LabFileReader.picked(photo: jpeg), try await LabFileReader.picked(scan: [Self.picture(0.2), Self.picture(0.4)])]
        _ = await runner.pick(picks, needsConsent: false)
        try await until("both read") { await Kit.allRead(runner, 2) }
        XCTAssertEqual(places.withLock { $0 }, ["pool", "pool"])
    }
}
