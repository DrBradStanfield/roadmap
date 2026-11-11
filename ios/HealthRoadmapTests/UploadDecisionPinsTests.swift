import UIKit
import XCTest
@testable import HealthRoadmap

/// Shared upload PR 1 (US-52 AC7, AC8): golden pins of the phone's upload decisions today,
/// read from the table the web runs too (packages/health-core/src/__fixtures__/upload-decisions.json,
/// copied here by ios/scripts/build-engine.mjs; the web: widget-src/src/lib/upload-decisions.pins.test.tsx).
/// No behaviour change: a later move into health-core keeps every row green, unedited.
/// Synthetic names and bytes only.
@MainActor
final class UploadDecisionPinsTests: XCTestCase {
    private typealias Row = [String: Any]

    private func table() throws -> Row {
        let url = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "upload-decisions", withExtension: "json"),
                                "the upload table is missing; run ios/scripts/build-engine.mjs")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? Row)
    }

    private func rows(_ section: String) throws -> [Row] {
        try XCTUnwrap((try table()[section] as? Row)?["rows"] as? [Row], section)
    }

    /// A name from the table: a string, or pieces where {repeat, times} is that many copies.
    private func text(_ spec: Any?) -> String {
        let pieces = spec as? [Any] ?? [spec as Any]
        return pieces.map { piece in
            if let piece = piece as? String { return piece }
            let repeated = piece as? Row ?? [:]
            return String(repeating: repeated["repeat"] as? String ?? "", count: repeated["times"] as? Int ?? 0)
        }.joined()
    }

    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    private let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { _ in }
    private let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 200)).pdfData { $0.beginPage() }

    // MARK: limits (D8)

    func testThePhoneReadsWithTheTablesLimits() throws {
        let phone = try XCTUnwrap(try table()["limits"] as? Row)["phone"] as? Row ?? [:]
        XCTAssertEqual(LabFileReader.maxFileBytes, phone["fileBytes"] as? Int)
        let zipBytes = try XCTUnwrap(phone["zipBytes"] as? Int)
        XCTAssertTrue(LabFileReader.fits(name: "a.zip", bytes: zipBytes))
        XCTAssertFalse(LabFileReader.fits(name: "a.zip", bytes: zipBytes + 1))
        XCTAssertEqual(LabFileReader.maxFolderFiles, phone["filesPerPick"] as? Int)
        XCTAssertEqual(LabFileReader.maxFolderFiles, phone["zipMembers"] as? Int)
        XCTAssertEqual(LabFileReader.maxPages, phone["pdfPages"] as? Int)
        XCTAssertEqual(LabFileReader.maxTextChars, phone["textPageChars"] as? Int)
        XCTAssertEqual(LabFileReader.maxFolderBytes, phone["folderBytes"] as? Int)
    }

    // MARK: kept or refused (D15, D9)

    /// A picked file by its name alone: the reader it reaches, or its refusal.
    func testAPickedFileIsKeptOrRefusedByItsName() throws {
        for row in try rows("fileKinds") {
            let name = try XCTUnwrap(row["name"] as? String)
            var found = "read"
            do { _ = try LabFileReader.documents(from: Data("x".utf8), name: name) }
            catch LabFileReader.Failure.unsupported { found = "unsupported" }
            catch LabFileReader.Failure.unreadable { found = "kept" }
            catch is ZipReader.Failure { found = "zip" }
            XCTAssertEqual(found, row["phone"] as? String, name)
        }
    }

    func testAZipMemberIsReadOrSkippedByItsPath() throws {
        for row in try rows("zipMembers") {
            let path = try XCTUnwrap(row["path"] as? String)
            let ext = (path as NSString).pathExtension.lowercased()
            let zip = Self.zip([(path, ext == "pdf" ? pdf : ["png", "jpg", "jpeg"].contains(ext) ? png : Data("x".utf8))])
            var read: Bool
            do { read = try LabFileReader.documents(from: zip, name: "labs.zip").count == 1 }
            catch LabFileReader.Failure.empty { read = false }
            XCTAssertEqual(read, row["phone"] as? Bool, path)
        }
    }

    // MARK: sizes and counts (D8)

    func testAPickedFileFitsOrNotByItsSize() throws {
        for row in try rows("fileSizes") {
            let name = try XCTUnwrap(row["name"] as? String), bytes = try XCTUnwrap(row["bytes"] as? Int)
            XCTAssertEqual(LabFileReader.fits(name: name, bytes: bytes) ? "fits" : "tooLarge", row["phone"] as? String, "\(name) \(bytes)")
        }
    }

    /// One member over the cap fails the whole ZIP, before anything inflates.
    func testAZipMemberOverTheCapFailsTheZip() throws {
        let row = try XCTUnwrap((try table()["fileSizes"] as? Row)?["zipMemberOverCap"] as? Row)
        XCTAssertEqual(row["phone"] as? String, "zipFails")
        let zip = Self.declaredZip(name: "big.pdf", size: try XCTUnwrap(row["bytes"] as? Int))
        // Control: the same builder's small member reads.
        XCTAssertEqual(try LabFileReader.documents(from: Self.zip([("small.png", png)]), name: "ok.zip").count, 1)
        XCTAssertThrowsError(try LabFileReader.documents(from: zip, name: "labs.zip")) { error in
            guard case ZipReader.Failure.tooLarge = error else { return XCTFail("\(error)") }
        }
    }

    func testAZipsMemberCount() throws {
        for row in try rows("zipCounts") {
            let count = try XCTUnwrap(row["members"] as? Int)
            let zip = Self.zip((0..<count).map { (String(format: "r%03d.png", $0), png) })
            let phone = try XCTUnwrap(row["phone"] as? Row)
            if let read = phone["read"] as? Int {
                XCTAssertEqual(try LabFileReader.documents(from: zip, name: "labs.zip").count, read, "\(count)")
            } else {
                XCTAssertThrowsError(try LabFileReader.documents(from: zip, name: "labs.zip")) { error in
                    XCTAssertEqual(error.localizedDescription, phone["failure"] as? String, "\(count)")
                }
            }
        }
    }

    // MARK: photo size (D10)

    func testAPickedPhotoIsSentAtItsLongSide() throws {
        let px = try XCTUnwrap((try table()["photoResize"] as? Row)?["phone"] as? Int)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let big = UIGraphicsImageRenderer(size: CGSize(width: 3000, height: 1000), format: format).image { _ in }
        let page = try XCTUnwrap(LabFileReader.jpegPage(big))
        let sent = try XCTUnwrap(UIImage(data: XCTUnwrap(Data(base64Encoded: page.content))))
        XCTAssertEqual(sent.size.width * sent.scale, CGFloat(px))
    }

    // MARK: naming (D13)

    func testEachFilesSourceFileName() async throws {
        let engine = try HealthEngine()
        for row in try rows("naming") {
            let document: LabFileReader.Document
            if row["kind"] as? String == "zip" {
                let zip = try XCTUnwrap(row["zip"] as? String), path = text(row["path"])
                document = LabFileReader.Document(name: "\(zip)/\(path)", pages: [], truncated: false, zipMember: .init(zip: zip, path: path))
            } else {
                document = LabFileReader.Document(name: text(row["name"]), pages: [], truncated: false)
            }
            let named = await engine.named([document]).map(\.name)
            XCTAssertEqual(named, [text(row["phone"])], document.name)
        }
    }

    // MARK: failure words (D14)

    func testAFailedReadsWordsAndTryAgain() async throws {
        let server = "Synthetic server words."
        let report = LabFileReader.Document(name: "labs.pdf", pages: [], truncated: false)
        for row in try rows("failures") {
            let phone = try XCTUnwrap(row["phone"] as? Row), name = row["case"] as? String ?? ""
            let error: Error = if let status = row["status"] as? Int {
                AppAttestClient.Failure.server(status: status, message: server)
            } else {
                switch row["network"] as? String {
                case "timedOut": URLError(.timedOut)
                case "networkConnectionLost": URLError(.networkConnectionLost)
                default: URLError(.notConnectedToInternet)
                }
            }
            let results = await LabUploadSheet.extractEach([report], extract: { _ in throw error }, progress: { _, _ in })
            let result = try XCTUnwrap(results?.first)
            let words = phone["words"] as? String == "$server" ? server : phone["words"] as? String
            XCTAssertEqual(result.failure, words, name)
            XCTAssertEqual(result.retry != nil, phone["retry"] as? Bool, name)
        }
    }

    // MARK: review defaults (D1, D3)

    private let values = #"""
    {"classification":"lab_report","reportDate":"2026-10-01",
     "values":[{"metric":"ldl","valueSI":3.1,"displayValue":3.1,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"},
               {"metric":"hba1c","valueSI":40,"displayValue":40,"displayUnit":"mmol/mol","displaySystem":"si","confidence":"medium","question":"Was this a blood test?"}],
     "additionalValues":[], "refusedValues":[]}
    """#
    private let undated = #"""
    {"classification":"lab_report","reportDate":null,
     "values":[{"metric":"hdl","valueSI":1.4,"displayValue":1.4,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}],
     "additionalValues":[], "refusedValues":[]}
    """#
    private let letter = ##"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Synthetic letter","documentDate":"2026-09-14","contentMarkdown":"# Letter","metadata":{}}}"##
    private let letterWithValues = ##"{"classification":"clinic_letter","reportDate":"2026-10-01","values":[{"metric":"ldl","valueSI":3.1,"displayValue":3.1,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Synthetic letter","documentDate":"2026-09-14","contentMarkdown":"# Letter","metadata":{}}}"##

    private func case_(_ section: String, _ name: String) throws -> Row {
        try XCTUnwrap(try rows(section).first { $0["case"] as? String == name }, name)
    }

    func testWhatTheReviewStartsWith() async throws {
        let engine = try HealthEngine()
        let review = try engine.blocking { [values, now] in try $0.labReview(extractionJSON: values, now: now) }
        let ticked = LabChoices(review: review).ticked
        XCTAssertEqual(ticked.contains("v0"), (try case_("reviewDefaults", "plain value")["phone"] as? Row)?["ticked"] as? Bool)
        XCTAssertEqual(ticked.contains("v1"), (try case_("reviewDefaults", "value with an extractor question")["phone"] as? Row)?["ticked"] as? Bool)

        let fresh = try engine.blocking { [letter, now] in try $0.labReview(extractionJSON: letter, now: now, sourceFileName: "letter.pdf") }
        XCTAssertEqual(LabChoices(review: fresh).keepDocument, (try case_("reviewDefaults", "document, sourceFileName not held")["phone"] as? Row)?["keepDocument"] as? Bool)

        let folder = FileManager.default.temporaryDirectory.appending(path: "Upload pins \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let choice = DocumentChoice(kind: .document, sourceFileName: "letter.pdf", title: "Earlier", documentDate: nil, mimeType: "")
        _ = await store.saveDocument(extractionJSON: letter, choice: choice, original: nil)
        let record = store.recordJSON
        let held = try engine.blocking { [letter, now] in try $0.labReview(extractionJSON: letter, now: now, recordJSON: record, sourceFileName: "letter.pdf") }
        XCTAssertEqual(LabChoices(review: held).keepDocument, (try case_("reviewDefaults", "document, sourceFileName held")["phone"] as? Row)?["keepDocument"] as? Bool)

        let both = try engine.blocking { [letterWithValues, now] in try $0.labReview(extractionJSON: letterWithValues, now: now) }
        let result = LabResult(name: "letter.pdf", truncated: false, extractionJSON: letterWithValues, failure: nil)
        let plan = LabSavePlan(result: result, review: both, choices: LabChoices(review: both), archiveOnly: false)
        let expected = try XCTUnwrap(try case_("reviewDefaults", "letter with values")["phone"] as? Row)
        if case .values = plan { XCTAssertEqual(true, expected["values"] as? Bool) } else { XCTAssertEqual(false, expected["values"] as? Bool) }
        if case .document = plan { XCTAssertEqual(true, expected["document"] as? Bool) } else { XCTAssertEqual(false, expected["document"] as? Bool) }
    }

    // MARK: what blocks Save (D2, D6)

    func testWhatBlocksSave() throws {
        let engine = try HealthEngine()
        let review = try engine.blocking { [values, now] in try $0.labReview(extractionJSON: values, now: now) }
        var none = LabChoices(review: review)
        none.ticked = []
        XCTAssertEqual(none.valuesWait(review), try case_("saveBlocks", "nothing ticked")["phone"] as? String)
        // With a cloud too: nothing ticked files nothing, the original included.
        let result = LabResult(name: "labs.pdf", truncated: false, extractionJSON: values, failure: nil)
        XCTAssertEqual(LabSavePlan(result: result, review: review, choices: none, archiveOnly: false),
                       .nothing(try XCTUnwrap(try case_("saveBlocks", "nothing ticked, cloud connected")["phone"] as? String)))

        let noDay = try engine.blocking { [undated, now] in try $0.labReview(extractionJSON: undated, now: now) }
        XCTAssertEqual(LabChoices(review: noDay).valuesWait(noDay), try case_("saveBlocks", "undated report, no day given")["phone"] as? String)

        // The phone has no typed values: nothing to pin but the table's null.
        XCTAssertTrue(try case_("saveBlocks", "one value typed invalid")["phone"] is NSNull)
    }

    // MARK: ZIP builders

    /// A minimal ZIP of stored members, with a central directory.
    private static func zip(_ members: [(String, Data)]) -> Data {
        var out = Data()
        var central = Data()
        func u16(_ v: Int) -> Data { withUnsafeBytes(of: UInt16(v).littleEndian) { Data($0) } }
        func u32(_ v: Int) -> Data { withUnsafeBytes(of: UInt32(v).littleEndian) { Data($0) } }
        for (name, data) in members {
            let offset = out.count
            let header = u16(20) + u16(0) + u16(0) + u16(0) + u16(0) + u32(0) + u32(data.count) + u32(data.count) + u16(name.utf8.count) + u16(0)
            out += u32(0x0403_4b50) + header + Data(name.utf8) + data
            central += u32(0x0201_4b50) + u16(20) + header + u16(0) + u16(0) + u16(0) + u32(0) + u32(offset) + Data(name.utf8)
        }
        let start = out.count
        out += central
        out += u32(0x0605_4b50) + u16(0) + u16(0) + u16(members.count) + u16(members.count) + u32(central.count) + u32(start) + u16(0)
        return out
    }

    /// A ZIP whose one stored member declares `size` bytes it does not hold: the size
    /// check comes before any byte is read.
    private static func declaredZip(name: String, size: Int) -> Data {
        var out = Data()
        func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { out.append(contentsOf: $0) } }
        func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { out.append(contentsOf: $0) } }
        u32(0x0201_4b50)
        for v in [20, 20, 0, 0, 0, 0] { u16(v) }
        for v in [0, size, size] { u32(v) }
        for v in [name.utf8.count, 0, 0, 0, 0] { u16(v) }
        for v in [0, 0] { u32(v) }
        out.append(Data(name.utf8))
        let centralSize = out.count
        u32(0x0605_4b50)
        for v in [0, 0, 1, 1] { u16(v) }
        for v in [centralSize, 0] { u32(v) }
        u16(0)
        return out
    }
}
