import ImageIO
import PDFKit
import XCTest
@testable import HealthRoadmap

/// US-52 AC10, AC13c: what each source hands the shared upload (LabUploadPicks): a file from
/// Files, a folder's reports, a photo as "Photo.jpg", a scan as one "Scanned report.pdf". The
/// engine's own effects convert them later (`Held`), as they convert a picked file. Since
/// 2026-10-25 there is no Dropbox list (AC11): a cloud report comes in through Files.
/// Synthetic pictures only.
@MainActor
final class LabSourceTests: XCTestCase {
    // MARK: Photos and Scan (AC10)

    /// A photo goes as one JPEG file named "Photo.jpg", converted as a picked picture is: one JPEG
    /// page, its long side resized to the web's 2,000. Bytes that are no picture are refused.
    func testAPhotoIsOneJpegFileConvertedAsAPickedPicture_US52_AC10() async throws {
        let image = Self.picture(width: 2400, height: 3200)
        let photo = try await LabFileReader.picked(photo: try XCTUnwrap(image.jpegData(compressionQuality: 0.9)))
        XCTAssertEqual(photo.name, "Photo.jpg")
        let read = try Self.converted(photo)
        XCTAssertEqual(read.pages.map(\.mimeType), ["image/jpeg"])
        let page = try XCTUnwrap(UIImage(data: try XCTUnwrap(Data(base64Encoded: try XCTUnwrap(read.pages.first).content))))
        XCTAssertEqual(max(page.size.width, page.size.height), 2000, "the long side is resized to the web's 2,000")
        XCTAssertEqual(read.pages.first?.content, photo.data.base64EncodedString(), "the page sent is the held photo, byte for byte: no second encode")
        do {
            _ = try await LabFileReader.picked(photo: Data("not a picture".utf8))
            XCTFail("bytes that are no picture are refused")
        } catch {
            XCTAssertEqual(error.localizedDescription, "The photo could not be opened.")
        }
    }

    /// A scan of several pages is ONE PDF file, a page each, so the upload has one entry for it.
    /// Past the web's 20 pages it keeps one page more, so the convert reads 20 and says the rest
    /// was cut, as for a long PDF from Files. No page, no file.
    func testAScanIsOnePdfOfItsPagesWithinTheWebsPageLimit_US52_AC10() async throws {
        let page = Self.picture(width: 40, height: 60)
        let three = try await LabFileReader.picked(scan: [page, page, page])
        XCTAssertEqual(three.name, "Scanned report.pdf")
        XCTAssertEqual(PDFDocument(data: three.data)?.pageCount, 3)
        let read = try Self.converted(three)
        XCTAssertEqual(read.pages.count, 3)
        XCTAssertEqual(Set(read.pages.map(\.mimeType)), ["image/jpeg"], "a scanned page has no text: it goes as a picture")
        XCTAssertFalse(read.truncated)

        let long = try await LabFileReader.picked(scan: Array(repeating: page, count: LabFileReader.maxPages + 5))
        XCTAssertEqual(PDFDocument(data: long.data)?.pageCount, LabFileReader.maxPages + 1)
        let cut = try Self.converted(long)
        XCTAssertEqual(cut.pages.count, LabFileReader.maxPages)
        XCTAssertTrue(cut.truncated)

        let nothing = try? await LabFileReader.picked(scan: [])
        XCTAssertNil(nothing, "no page, no report")
    }

    // MARK: A long scan steps down to fit (build 13 read a 20-page scan; the file cap must not refuse it)

    /// A page of text-like marks, `seed` making each page its own, as a camera scan of a report.
    private static func reportPage(_ seed: Int) -> UIImage {
        var state = UInt64(seed &* 2_654_435_761 &+ 1)
        func next() -> CGFloat { state = state &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407; return CGFloat(state >> 33) / CGFloat(1 << 31) }
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: CGSize(width: 2000, height: 2600), format: format).image { context in
            UIColor(white: 0.93, alpha: 1).setFill(); context.fill(CGRect(x: 0, y: 0, width: 2000, height: 2600))
            for line in 0..<90 {
                var x: CGFloat = 120
                while x < 1880 {
                    let w = 10 + next() * 60
                    UIColor(white: next() * 0.4, alpha: 1).setFill()
                    context.fill(CGRect(x: x, y: 120 + CGFloat(line) * 26, width: w, height: 14 + next() * 6))
                    x += w + 6 + next() * 14
                }
            }
            // Paper grain, as a camera sees it.
            for _ in 0..<8_000 {
                UIColor(white: 0.8 + next() * 0.2, alpha: 1).setFill()
                context.fill(CGRect(x: next() * 2000, y: next() * 2600, width: 2, height: 2))
            }
        }
    }

    /// The long side of each page of a PDF, in points.
    private static func longSides(_ data: Data) throws -> [CGFloat] {
        let pdf = try XCTUnwrap(PDFDocument(data: data))
        return (0..<pdf.pageCount).compactMap { pdf.page(at: $0).map { max($0.bounds(for: .mediaBox).width, $0.bounds(for: .mediaBox).height) } }
    }

    /// A 20-page scan over the engine's file cap at today's pages fits once its pages step down:
    /// one file, one review entry, every page still 2,000 or 1,600 points on its long side.
    func testALongScanOverTheCapStepsDownToFit_US52_AC10() async throws {
        let pages = (0..<20).map(Self.reportPage)
        let today = try await LabFileReader.picked(scan: pages)
        let rules = Self.rules
        let cap = await rules([LabFileReader.UploadFile(name: "Scanned report.pdf", bytes: today.data.count)], []).maxMemberBytes
        XCTAssertGreaterThan(today.data.count, cap, "the synthetic scan is over the cap at today's pages (\(today.data.count) bytes)")
        let scan = try await LabFileReader.picked(scan: pages, ask: rules)
        XCTAssertLessThanOrEqual(scan.data.count, cap, "\(scan.data.count) bytes")
        XCTAssertEqual(scan.name, "Scanned report.pdf")
        let sides = try Self.longSides(scan.data)
        XCTAssertEqual(sides.count, 20, "one file of every page")
        XCTAssertTrue(sides.allSatisfy { $0 == 2000 || $0 == 1600 }, "\(Set(sides))")
        let read = try Self.converted(scan)
        XCTAssertEqual(read.pages.count, 20)
        XCTAssertFalse(read.truncated)
        // What is sent is what the size check saw: the request body of the pages as made, against
        // the body the convert would send if it drew the stepped PDF's pages again (as it did).
        let flags = try JSONDecoder().decode(LabReadSender.Flags.self, from: Data(#"{"ownDates":true,"undatedPrev":false,"refusedRows":true}"#.utf8))
        let body = try LabReadSender.body(pages: read.pages, unitSystem: "si", flags: flags).count
        let redrawn = try LabReadSender.body(pages: try LabFileReader.document(from: scan.data, name: scan.name, rules: .swift).pages, unitSystem: "si", flags: flags).count
        print("US-52 AC10 scan sizes: pdf \(scan.data.count), today's pdf \(today.data.count), body as made \(body), body if drawn again \(redrawn)")
        XCTAssertLessThan(body, 20 * 1024 * 1024, "well under the server's 25 MB body cap (APP_LAB_BODY_CAP)")
        XCTAssertEqual(read.pages, scan.pages?.pages, "the pages sent are the pages made, as they are")
        XCTAssertLessThan(body, redrawn)
        // A PDF picked from Files converts as before: drawn from the file.
        let file = try await LabFileReader.picked(scan: Array(pages.prefix(2))).data
        let held = LabFileReader.Held()
        held.hold(file, as: "file", name: "report.pdf")
        let fromFiles = try held.convert("file", rules: .swift).pages
        XCTAssertEqual(fromFiles, try LabFileReader.document(from: file, name: "report.pdf", rules: .swift).pages)
    }

    /// A scan past 20 pages ends with a blank placeholder page that weighs nothing: 25 pages whose
    /// first 20 fit are not stepped down, and the convert still says the rest was cut.
    func testAScanPastTwentyPagesIsJudgedOnItsFirstTwenty_US52_AC10() async throws {
        let pages = (0..<25).map { Self.reportPage($0 % 5) }
        let twenty = try await LabFileReader.picked(scan: Array(pages.prefix(20)))
        let all = try await LabFileReader.picked(scan: pages)
        XCTAssertLessThan(all.data.count - twenty.data.count, 4_096, "the placeholder is tiny")
        let capped: LabFileReader.AskRules = { [cap = twenty.data.count + 4_096] _, _ in
            LabFileReader.Rules(file: { _, bytes in bytes > cap ? .tooLarge : .keep }, member: { _ in .keep }, maxMemberBytes: cap, maxMembers: 1, maxTotalBytes: cap)
        }
        let scan = try await LabFileReader.picked(scan: pages, ask: capped)
        XCTAssertEqual(try Self.longSides(scan.data).prefix(20).allSatisfy { $0 == 2000 }, true, "not stepped down")
        XCTAssertEqual(PDFDocument(data: scan.data)?.pageCount, 21)
        let read = try Self.converted(scan)
        XCTAssertEqual(read.pages.count, 20)
        XCTAssertTrue(read.truncated)
    }

    /// Each step in turn, against a cap the test sets: the first step that fits is used, and when
    /// none does the smallest goes (the engine then refuses it in its words). A scan under the cap
    /// is today's PDF, untouched.
    func testAScanTakesTheFirstStepThatFitsAndAScanUnderTheCapIsUntouched_US52_AC10() async throws {
        let pages = (0..<3).map(Self.reportPage)
        let today = try await LabFileReader.picked(scan: pages)
        func capped(_ cap: Int) -> LabFileReader.AskRules {
            { _, _ in LabFileReader.Rules(file: { _, bytes in bytes > cap ? .tooLarge : .keep }, member: { _ in .keep }, maxMemberBytes: cap, maxMembers: 1, maxTotalBytes: cap) }
        }
        let under = try await LabFileReader.picked(scan: pages, ask: capped(today.data.count))
        XCTAssertEqual(under.data.count, today.data.count, "under the cap: today's PDF (only its creation time differs)")
        XCTAssertEqual(try Self.longSides(under.data), [2000, 2000, 2000])

        let stepped = try await LabFileReader.picked(scan: pages, ask: capped(today.data.count - 1))
        XCTAssertLessThan(stepped.data.count, today.data.count)
        XCTAssertEqual(try Self.longSides(stepped.data), [2000, 2000, 2000], "quality first, size kept")

        let none = try await LabFileReader.picked(scan: pages, ask: capped(1))
        XCTAssertEqual(try Self.longSides(none.data), [1600, 1600, 1600], "the smallest step goes")

        // The page limit and the cut still hold on a stepped scan.
        let long = try await LabFileReader.picked(scan: Array(repeating: Self.picture(width: 40, height: 60), count: LabFileReader.maxPages + 5), ask: capped(1))
        XCTAssertEqual(PDFDocument(data: long.data)?.pageCount, LabFileReader.maxPages + 1)
        XCTAssertTrue(try Self.converted(long).truncated)
    }

    /// A photo the library cannot hand over (a failing transferable) says the app's words.
    func testAPhotoThatWillNotLoadSaysTheAppsWords_US52_AC10() async throws {
        func refused(_ load: @escaping @Sendable () async throws -> Data?, line: UInt = #line) async {
            do {
                _ = try await LabFileReader.picked(photoLoad: load)
                XCTFail("a load that fails is refused", line: line)
            } catch {
                XCTAssertEqual(error.localizedDescription, "The photo could not be opened.", line: line)
            }
        }
        await refused { throw NSError(domain: NSCocoaErrorDomain, code: 4097, userInfo: [NSLocalizedDescriptionKey: "Couldn't communicate with a helper application."]) }
        await refused { nil }
    }

    /// US-25 AC21: a photo is resized and a scan's PDF is built on the shared pool, never the main
    /// thread, though the sheet (and this test) call them from the main actor.
    func testAPhotoAndAScanAreMadeOffTheMainThread_US25_AC21() async throws {
        let places = Places()
        let image = Self.picture(width: 400, height: 600)
        _ = try await LabFileReader.picked(photo: try XCTUnwrap(image.jpegData(compressionQuality: 0.9)), working: { places.add(Thread.isMainThread ? "main" : "pool") })
        _ = try await LabFileReader.picked(scan: [image, image], working: { places.add(Thread.isMainThread ? "main" : "pool") })
        XCTAssertEqual(places.all, ["pool", "pool"], "a photo, a scan")
    }

    private final class Places: @unchecked Sendable {
        private let lock = NSLock()
        private var seen: [String] = []
        func add(_ place: String) { lock.withLock { seen.append(place) } }
        var all: [String] { lock.withLock { seen } }
    }

    // MARK: No picture metadata reaches the server (owner ruling, privacy)

    /// A JPEG with a GPS location, as a phone's camera writes one.
    private static func jpegWithGPS() throws -> Data {
        let image = try XCTUnwrap(picture(width: 300, height: 400).cgImage)
        let out = NSMutableData()
        let destination = try XCTUnwrap(CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil))
        let gps: [CFString: Any] = [kCGImagePropertyGPSLatitude: 36.8, kCGImagePropertyGPSLatitudeRef: "S",
                                    kCGImagePropertyGPSLongitude: 174.7, kCGImagePropertyGPSLongitudeRef: "E"]
        CGImageDestinationAddImage(destination, image, [kCGImagePropertyGPSDictionary: gps] as CFDictionary)
        XCTAssertTrue(CGImageDestinationFinalize(destination))
        return out as Data
    }

    private static func hasGPS(_ data: Data) -> Bool {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] else { return false }
        return properties[kCGImagePropertyGPSDictionary] != nil
    }

    private static func pageBytes(_ document: LabFileReader.Document) throws -> [Data] {
        try document.pages.map { try XCTUnwrap(Data(base64Encoded: $0.content)) }
    }

    /// A JPEG picked from Files can carry its location: its page is redrawn and re-encoded, so the
    /// page sent holds no GPS and is not the source's bytes. Only the app's own photo, already
    /// redrawn, goes as its own bytes.
    func testAFilesJpegIsRedrawnSoItsLocationNeverLeaves_US52_AC10() async throws {
        let source = try Self.jpegWithGPS()
        XCTAssertTrue(Self.hasGPS(source), "the fixture carries a location")
        let held = LabFileReader.Held()
        held.hold(source, as: "f", name: "scan.jpg")
        let pages = try Self.pageBytes(try held.convert("f", rules: .swift))
        XCTAssertNotEqual(pages, [source])
        XCTAssertFalse(pages.contains(where: Self.hasGPS))
    }

    /// The same for a JPEG in a folder pick, in a ZIP, and for a scan's pages.
    func testAFolderOrZipJpegAndAScanSendNoLocation_US52_AC10() async throws {
        let source = try Self.jpegWithGPS()
        let folder = try newFolder("Located")
        try source.write(to: folder.appending(path: "a.jpg"))
        let picked = try await LabFileReader.picked(folder, ask: Self.rules)
        let fromFolder = try Self.pageBytes(try Self.converted(try XCTUnwrap(picked.first)))
        XCTAssertNotEqual(fromFolder, [source])
        XCTAssertFalse(fromFolder.contains(where: Self.hasGPS), "a folder's JPEG")

        let zip = ZipLazyReadTests.zip([.init("a.jpg", source, deflate: false)])
        let fromZip = try await LabFileReader.documents(from: zip, name: "labs.zip")
        let zipPages = try fromZip.flatMap(Self.pageBytes)
        XCTAssertFalse(zipPages.isEmpty)
        XCTAssertNotEqual(zipPages, [source])
        XCTAssertFalse(zipPages.contains(where: Self.hasGPS), "a ZIP's JPEG")

        let scan = try await LabFileReader.picked(scan: [try XCTUnwrap(UIImage(data: source))])
        let scanPages = try Self.pageBytes(try Self.converted(scan))
        XCTAssertFalse(scanPages.contains(where: Self.hasGPS), "a scan's pages")
    }

    /// The app's own photo: redrawn once when picked, so no location; its page is those bytes.
    func testThePhotoPageIsTheHeldPhotoAndHasNoLocation_US52_AC10() async throws {
        let photo = try await LabFileReader.picked(photo: try Self.jpegWithGPS())
        XCTAssertFalse(Self.hasGPS(photo.data))
        let pages = try Self.pageBytes(try Self.converted(photo))
        XCTAssertEqual(pages, [photo.data])
    }

    // MARK: A folder (AC13c)

    /// A picked folder gives every report in it and its folders, in name order, named by their
    /// place in the folder, as bytes; other and hidden files are left out.
    func testAFolderGivesEveryReportInsideItInNameOrder_US52_AC13c() async throws {
        let folder = try newFolder("Records")
        let inner = folder.appending(path: "2025")
        try FileManager.default.createDirectory(at: inner, withIntermediateDirectories: true)
        try Self.png.write(to: folder.appending(path: "b.png"))
        try Self.png.write(to: inner.appending(path: "a.PNG"))
        try Self.png.write(to: folder.appending(path: ".hidden.png"))
        try Data("notes".utf8).write(to: folder.appending(path: "notes.txt"))
        let picked = try await LabFileReader.picked(folder, ask: Self.rules)
        XCTAssertEqual(picked.map(\.name), ["\(folder.lastPathComponent)/2025/a.PNG", "\(folder.lastPathComponent)/b.png"])
        XCTAssertEqual(picked.map(\.data), [Self.png, Self.png])
        XCTAssertEqual(Set(picked.map(\.id)).count, 2, "each file its own id")
    }

    /// A folder of more than 200 reports gives the first 200 in name order (the web's file cap);
    /// the bytes held are the files' own, within the folder cap.
    func testAFolderGivesAtMostTwoHundredReports_US52_AC13c() async throws {
        let folder = try newFolder("Many reports")
        for n in 0...LabFileReader.maxFolderFiles { try Self.png.write(to: folder.appending(path: String(format: "r%03d.png", n))) }
        let picked = try await LabFileReader.picked(folder, ask: Self.rules)
        XCTAssertEqual(picked.count, LabFileReader.maxFolderFiles)
        XCTAssertEqual(picked.last?.name, "\(folder.lastPathComponent)/r199.png")
        XCTAssertEqual(picked.reduce(0) { $0 + $1.data.count }, Self.png.count * LabFileReader.maxFolderFiles)
    }

    // MARK: Checked before reading (US-52 AC10, adversary R3)

    /// A folder with no report says so in a folder's words, not a file's.
    func testAnEmptyFolderIsSaidAsAFolder() async throws {
        let folder = try newFolder("Empty")
        try Data("notes".utf8).write(to: folder.appending(path: "notes.txt"))
        await assertRefused(try await LabFileReader.picked(folder, ask: Self.rules),
                            "This folder holds no reports the app can read: no PDF, JPEG or PNG.")
    }

    /// A report over its cap in a folder is never read: it goes by its listed size alone, for the
    /// engine to refuse in its own words, and the folder's other reports are read. The big file
    /// here cannot be read at all, so a read would fail.
    func testAnOversizedReportInAFolderGoesUnreadAndTheRestAreRead_US52_AC7() async throws {
        let folder = try newFolder("Big")
        _ = try sparse(folder.appending(path: "big.pdf"), bytes: LabFileReader.maxFileBytes + 1)
        try Self.png.write(to: folder.appending(path: "a.png"))
        let picked = try await LabFileReader.picked(folder, ask: Self.rules)
        XCTAssertEqual(picked.map(\.name), ["\(folder.lastPathComponent)/a.png", "\(folder.lastPathComponent)/big.pdf"])
        XCTAssertEqual(picked.map(\.bytes), [Self.png.count, LabFileReader.maxFileBytes + 1])
        XCTAssertEqual(picked.map(\.data.count), [Self.png.count, 0], "the big file is never read or held")
    }

    /// A folder whose reports hold more than the cap in all is refused before any is read.
    func testAFolderOverTheCapIsRefusedBeforeAnyRead() async throws {
        let folder = try newFolder("Heavy")
        for n in 1...3 { _ = try sparse(folder.appending(path: "r\(n).pdf"), bytes: 1_000) }
        await assertRefused(try await LabFileReader.picked(folder: folder, maxBytes: 2_500, ask: Self.rules),
                            "This folder holds more than 200 MB of reports. Pick a smaller folder, or the reports one at a time.")
    }

    /// Re-check N2: a listed size can understate the bytes (or be missing), so the reads keep
    /// their own total. Here the files grow after the listing (as the rules are asked), before
    /// they are read.
    func testAFolderWhoseReadsOutgrowTheCapIsRefused() async throws {
        let folder = try newFolder("Growing")
        for name in ["a.png", "b.png", "c.png"] { try Self.png.write(to: folder.appending(path: name)) }
        let big = UIGraphicsImageRenderer(size: CGSize(width: 400, height: 400)).pngData { context in
            for x in stride(from: 0, to: 400, by: 4) { UIColor(hue: CGFloat(x) / 400, saturation: 1, brightness: 1, alpha: 1).setFill(); context.fill(CGRect(x: x, y: 0, width: 4, height: 400)) }
        }
        let grown = folder
        await assertRefused(try await LabFileReader.picked(folder: folder, maxBytes: Self.png.count * 3 + 100) { files, members in
            for name in ["b.png", "c.png"] { try? big.write(to: grown.appending(path: name)) }
            return await Self.rules(files, members)
        }, "This folder holds more than 200 MB of reports. Pick a smaller folder, or the reports one at a time.")
    }

    /// The walk stops at 5,000 entries rather than listing a whole drive.
    func testAFolderWithTooManyEntriesIsRefused() async throws {
        let folder = try newFolder("Many")
        for n in 0...LabFileReader.maxFolderEntries { FileManager.default.createFile(atPath: folder.appending(path: "n\(n).txt").path, contents: nil) }
        await assertRefused(try await LabFileReader.picked(folder, ask: Self.rules), "This folder holds more than 5,000 files. Pick a smaller folder.")
    }

    /// Close while a folder is read: the read stops before its next file, and nothing is handed on.
    func testClosingWhileAFolderIsReadStopsBeforeTheNextFile_US52_AC7a() async throws {
        let folder = try newFolder("Three")
        for name in ["a.png", "b.png", "c.png"] { try Self.png.write(to: folder.appending(path: name)) }
        let read = Task { @MainActor in
            try await LabFileReader.picked(folder, ask: { files, members in
                withUnsafeCurrentTask { $0?.cancel() }
                return await Self.rules(files, members)
            })
        }
        let result = await read.result
        XCTAssertThrowsError(try result.get()) { XCTAssertTrue($0 is CancellationError, "\($0)") }
    }

    // MARK: Helpers

    /// health-core's rules, from the bundled engine.
    nonisolated static let rules: LabFileReader.AskRules = { files, members in
        guard let engine = try? HealthEngine() else { return .none }
        return await engine.uploadRules(files: files, members: members)
    }

    /// One pick converted as the engine's `convert` effect converts it.
    private static func converted(_ picked: UploadRunner.Picked) throws -> LabFileReader.Document {
        let held = LabFileReader.Held()
        held.hold(picked.data, as: picked.id, name: picked.name, redrawn: picked.redrawn, made: picked.pages)
        return try held.convert(picked.id, rules: .swift)
    }

    private static func picture(width: CGFloat, height: CGFloat) -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: width, height: height)).image { context in
            UIColor.gray.setFill(); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
        }
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
