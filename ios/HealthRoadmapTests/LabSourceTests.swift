import XCTest
@testable import HealthRoadmap

/// US-52 AC10: reading a report from Files, Photos or the camera on the phone, and the
/// sheet's sends. Since 2026-10-25 there is no Dropbox list (AC11): a cloud report comes
/// in through Files.
@MainActor
final class LabSourceTests: XCTestCase {
    private static let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { context in
        context.beginPage()
        ("Synthetic Lab Report. LDL Cholesterol 3.1 mmol/L. Collected 2026-10-01." as NSString)
            .draw(in: CGRect(x: 40, y: 40, width: 530, height: 700), withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
    }

    /// US-25 AC21 (merge review R2, Codex re-check R1): every report is decoded on the shared
    /// pool, never the main thread, whether a file or a folder was picked in Files.
    func testReportsAreDecodedOffTheMainThread() async throws {
        let places = Places()
        LabFileReader.decodingWatch = { places.add(Thread.isMainThread ? "main" : "pool") }
        defer { LabFileReader.decodingWatch = nil }
        // A folder as Files hands it over: its URL ends in a slash.
        let folder = FileManager.default.temporaryDirectory.appending(path: "Picked \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let picked = folder.appending(path: "picked.pdf")
        try LabSourceTests.pdf.write(to: picked)
        _ = try await LabFileReader.decoded(picked: picked)
        _ = try await LabFileReader.decoded(picked: folder)
        XCTAssertEqual(places.all, ["pool", "pool"], "a picked file, a picked folder")
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

    // MARK: A read that does not answer (AC7a)

    /// The break-it pass: a server that never answered left "The request timed out." and
    /// only Skip, so the person had to pick the photo again. The report read on the phone
    /// is kept for Try again, and the words are plain.
    func testATimedOutReadKeepsItsReportForTryAgain_US52_AC7a() async throws {
        let documents = [LabFileReader.Document(name: "Photo", pages: [], truncated: false)]
        let timedOut = await LabUploadSheet.extractEach(documents, extract: { _ in throw URLError(.timedOut) }, progress: { _, _ in })
        let results = try XCTUnwrap(timedOut)
        XCTAssertEqual(results.first?.failure, "The server took too long to answer. Please try again.")
        XCTAssertEqual(results.first?.retry?.name, "Photo", "the read report is kept, so Try again needs no new pick")
        let unreached = await LabUploadSheet.extractEach(documents, extract: { _ in throw URLError(.notConnectedToInternet) }, progress: { _, _ in })
        let offline = try XCTUnwrap(unreached)
        XCTAssertEqual(offline.first?.failure, "The server could not be reached. Check your connection, then try again.")
        XCTAssertNotNil(offline.first?.retry)
        let lost = await LabUploadSheet.extractEach(documents, extract: { _ in throw URLError(.networkConnectionLost) }, progress: { _, _ in })
        let dropped = try XCTUnwrap(lost)
        XCTAssertEqual(dropped.first?.failure, "The connection dropped before the answer finished. Please try again.")
        // An exception's own text never reaches the screen; the server's words do.
        let thrown = await LabUploadSheet.extractEach(documents, extract: { _ in
            throw NSError(domain: "JSContext", code: 7, userInfo: [NSLocalizedDescriptionKey: "TypeError: undefined is not an object"])
        }, progress: { _, _ in })
        let odd = try XCTUnwrap(thrown)
        XCTAssertEqual(odd.first?.failure, "Something went wrong, so this report was not read. Please try again.")
        XCTAssertNil(odd.first?.retry, "an unknown failure is not one Try again is known to mend (review R5)")
        let gateway = await LabUploadSheet.extractEach(documents, extract: { _ in
            throw AppAttestClient.Failure.server(status: 502, message: "The server could not answer just now. Please try again later.")
        }, progress: { _, _ in })
        let busy = try XCTUnwrap(gateway)
        XCTAssertEqual(busy.first?.failure, "The server could not answer just now. Please try again later.")
        XCTAssertNotNil(busy.first?.retry)
    }

    /// Review R5: a refusal that fails the same way again offers no Try again: a refused
    /// attestation (401), a file too large (413). The server's words are kept.
    func testARefusalThatWouldFailAgainHasNoTryAgain_US52_AC7a() async throws {
        let documents = [LabFileReader.Document(name: "r1.pdf", pages: [], truncated: false)]
        for (status, words) in [(401, "The app could not be verified."), (413, "This file is too large.")] {
            let refused = await LabUploadSheet.extractEach(documents, extract: { _ in
                throw AppAttestClient.Failure.server(status: status, message: words)
            }, progress: { _, _ in })
            let results = try XCTUnwrap(refused)
            XCTAssertEqual(results.first?.failure, words, "\(status)")
            XCTAssertNil(results.first?.retry, "\(status)")
        }
        let unavailable = await LabUploadSheet.extractEach(documents, extract: { _ in
            throw AppAttestClient.Failure.server(status: 503, message: "Busy.")
        }, progress: { _, _ in })
        XCTAssertNotNil(try XCTUnwrap(unavailable).first?.retry, "a server's own trouble may mend")
    }

    /// A file the AI declined reads the same way again (US-15 AC34): no Try again.
    func testAReportTheAICouldNotReadHasNoTryAgain_US52_AC7a() async throws {
        let documents = [LabFileReader.Document(name: "r1.pdf", pages: [], truncated: false)]
        let declined = await LabUploadSheet.extractEach(documents, extract: { _ in
            throw AppAttestClient.Failure.server(status: 422, message: "Not read")
        }, progress: { _, _ in })
        let results = try XCTUnwrap(declined)
        XCTAssertEqual(results.first?.failure, "The AI could not read this file.")
        XCTAssertNil(results.first?.retry)
    }

    /// The daily limit mends only tomorrow, so it shows the server's words and offers no Try again.
    func testTheDailyLimitHasNoTryAgain_US52_AC7a() async throws {
        let documents = [LabFileReader.Document(name: "r1.pdf", pages: [], truncated: false)]
        let limited = await LabUploadSheet.extractEach(documents, extract: { _ in
            throw AppAttestClient.Failure.server(status: 429, message: "You can upload more tomorrow.")
        }, progress: { _, _ in })
        let results = try XCTUnwrap(limited)
        XCTAssertEqual(results.first?.failure, "You can upload more tomorrow.")
        XCTAssertNil(results.first?.retry)
    }

    /// Try again sends the same report once, and only it: the other reports' answers stay.
    /// Closed or cancelled while it runs, it gives nothing back.
    func testTryAgainResendsOnlyThatReport_US52_AC7a() async throws {
        let documents = ["r1.pdf", "r2.pdf"].map { LabFileReader.Document(name: $0, pages: [], truncated: false) }
        let sentOnce = await LabUploadSheet.extractEach(documents, extract: { document in
            if document.name == "r2.pdf" { throw URLError(.timedOut) }
            return #"{"first":1}"#
        }, progress: { _, _ in })
        let first = try XCTUnwrap(sentOnce)
        var sent: [String] = []
        let retried = await LabUploadSheet.retried(first, at: 1, extract: { document in
            sent.append(document.name)
            return "{}"
        })
        let again = try XCTUnwrap(retried)
        XCTAssertEqual(sent, ["r2.pdf"])
        XCTAssertEqual(again.map(\.name), ["r1.pdf", "r2.pdf"])
        XCTAssertEqual(again[0].extractionJSON, #"{"first":1}"#)
        XCTAssertNil(again[1].failure)
        XCTAssertEqual(again[1].extractionJSON, "{}")
        XCTAssertEqual(again[0].id, first[0].id, "the other review keeps its place")
        XCTAssertNotEqual(again[1].id, first[1].id, "the new answer opens a fresh review")
        let cancelled = await Task { @MainActor in
            await LabUploadSheet.retried(first, at: 1, extract: { _ in
                withUnsafeCurrentTask { $0?.cancel() }
                return "{}"
            })
        }.value
        XCTAssertNil(cancelled, "a cancelled Try again leaves the review as it was")
    }

    /// Cancel and Close stop a read whose server never answers at once, and the request
    /// with it, rather than waiting out the timeout.
    func testCancellingAReadThatHangsStopsTheRequest_US52_AC7a() async throws {
        StubHTTP.handler = { _ in StubHTTP.Answer(hang: true) }
        let stoppedBefore = StubHTTP.stopped
        let client = LabUploadClient(attest: AppAttestClient(session: StubHTTP.session()))
        let read = Task { () -> Bool in
            do { _ = try await client.extract(LabFileReader.Document(name: "Photo", pages: [], truncated: false), unitSystem: "si"); return false }
            catch { return true }
        }
        try await Task.sleep(for: .milliseconds(300))
        let started = Date()
        read.cancel()
        let threw = await read.value
        XCTAssertTrue(threw)
        XCTAssertLessThan(Date().timeIntervalSince(started), 2, "the read ended at once")
        for _ in 0..<20 where StubHTTP.stopped == stoppedBefore { try await Task.sleep(for: .milliseconds(100)) }
        XCTAssertGreaterThan(StubHTTP.stopped, stoppedBefore, "the request was cancelled, not left running")
    }

    // MARK: Reading on the phone (AC10)

    func testAFileOverTheWebsLimitDoesNotFit() {
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
    func testAFolderGivesEveryReportInsideItInNameOrder() async throws {
        let folder = try newFolder("Records")
        let inner = folder.appending(path: "2025")
        try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        try Self.png.write(to: folder.appending(path: "b.png"))
        try Self.png.write(to: inner.appending(path: "a.PNG"))
        try Self.png.write(to: folder.appending(path: ".hidden.png"))
        try Data("notes".utf8).write(to: folder.appending(path: "notes.txt"))
        let names = try await LabFileReader.documents(inFolder: folder).map(\.name)
        XCTAssertEqual(names, ["\(folder.lastPathComponent)/2025/a.PNG", "\(folder.lastPathComponent)/b.png"])
    }

    // MARK: Files, checked before reading (US-52 AC10, adversary R3)

    /// A folder with no report says so in a folder's words, not a file's.
    func testAnEmptyFolderIsSaidAsAFolder() async throws {
        let folder = try newFolder("Empty")
        try Data("notes".utf8).write(to: folder.appending(path: "notes.txt"))
        await assertRefused(try await LabFileReader.documents(inFolder: folder),
                            "This folder holds no reports the app can read: no PDF, JPEG or PNG.")
    }

    /// A file over the web's limit is refused by its listed size, never read: it cannot be
    /// read at all here, so a read would say "could not be opened".
    func testAnOversizedFileIsRefusedBeforeItIsRead() async throws {
        let folder = try newFolder("Big")
        let big = try sparse(folder.appending(path: "big.pdf"), bytes: LabFileReader.maxFileBytes + 1)
        await assertRefused(try LabFileReader.documents(picked: big), LabFileReader.Failure.tooLarge("big.pdf").localizedDescription)
        try Self.png.write(to: folder.appending(path: "a.png"))
        await assertRefused(try await LabFileReader.documents(inFolder: folder), LabFileReader.Failure.tooLarge("big.pdf").localizedDescription)
    }

    /// A folder whose reports hold more than the cap in all is refused before any is read.
    func testAFolderOverTheCapIsRefusedBeforeAnyRead() async throws {
        let folder = try newFolder("Heavy")
        for n in 1...3 { _ = try sparse(folder.appending(path: "r\(n).pdf"), bytes: 1_000) }
        await assertRefused(try await LabFileReader.documents(inFolder: folder, maxBytes: 2_500),
                            "This folder holds more than 200 MB of reports. Pick a smaller folder, or the reports one at a time.")
    }

    /// Re-check N2: a listed size can understate the bytes (or be missing), so the reads
    /// keep their own total. Here the files grow after the listing, before they are read.
    func testAFolderWhoseReadsOutgrowTheCapIsRefused() async throws {
        let folder = try newFolder("Growing")
        for name in ["a.png", "b.png", "c.png"] { try Self.png.write(to: folder.appending(path: name)) }
        let big = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 400)).pngData { context in
            for x in stride(from: 0, to: 400, by: 4) { UIColor(hue: CGFloat(x) / 400, saturation: 1, brightness: 1, alpha: 1).setFill(); context.fill(CGRect(x: x, y: 0, width: 4, height: 400)) }
        }
        let grown = folder
        await assertRefused(try await LabFileReader.documents(inFolder: folder, maxBytes: Self.png.count * 3 + 100) { done, _ in
            if done == 0 { for name in ["b.png", "c.png"] { try? big.write(to: grown.appending(path: name)) } }
        }, "This folder holds more than 200 MB of reports. Pick a smaller folder, or the reports one at a time.")
    }

    /// The walk stops at 5,000 entries rather than listing a whole drive.
    func testAFolderWithTooManyEntriesIsRefused() async throws {
        let folder = try newFolder("Many")
        for n in 0...LabFileReader.maxFolderEntries { FileManager.default.createFile(atPath: folder.appending(path: "n\(n).txt").path, contents: nil) }
        await assertRefused(try await LabFileReader.documents(inFolder: folder), "This folder holds more than 5,000 files. Pick a smaller folder.")
    }

    /// The reading screen counts each report; Close stops the read before the next file.
    func testAFolderCountsItsReportsAndStopsBetweenFilesWhenClosed() async throws {
        let folder = try newFolder("Three")
        for name in ["a.png", "b.png", "c.png"] { try Self.png.write(to: folder.appending(path: name)) }
        let counts = Places()
        let all = try await LabFileReader.documents(inFolder: folder) { done, total in counts.add("\(done + 1) of \(total)") }
        XCTAssertEqual(all.count, 3)
        XCTAssertEqual(counts.all, ["1 of 3", "2 of 3", "3 of 3"])

        let stopped = Places()
        let read = Task { @MainActor in
            try await LabFileReader.documents(inFolder: folder) { done, total in
                stopped.add("\(done + 1) of \(total)")
                withUnsafeCurrentTask { $0?.cancel() }
            }
        }
        let result = await read.result
        XCTAssertThrowsError(try result.get()) { XCTAssertTrue($0 is CancellationError, "\($0)") }
        XCTAssertEqual(stopped.all, ["1 of 3"], "the second file is never read")
    }

    private static let png = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).pngData { context in
        UIColor.gray.setFill(); context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
    }

    /// A new folder, removed after the test, with a URL ending in a slash as Files hands it over.
    private func newFolder(_ name: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "\(name)-\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return folder
    }

    /// A file of `bytes` that cannot be read (no read permission), so any read of it fails.
    private func sparse(_ url: URL, bytes: Int) throws -> URL {
        FileManager.default.createFile(atPath: url.path, contents: nil, attributes: [.posixPermissions: 0o200])
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(bytes))
        try handle.close()
        return url
    }

    private func assertRefused<T>(_ call: @autoclosure () async throws -> T, _ words: String, line: UInt = #line) async {
        do {
            _ = try await call()
            XCTFail("not refused", line: line)
        } catch {
            XCTAssertEqual(error.localizedDescription, words, line: line)
        }
    }
}
