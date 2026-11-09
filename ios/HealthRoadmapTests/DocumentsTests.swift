import XCTest
@testable import HealthRoadmap

/// US-73 AC12: the letters and scan results at the foot of My health, as the web lists them
/// (HealthRecordsSection), and each one's page (the web's DocumentLightbox).
@MainActor
final class DocumentsTests: XCTestCase {
    private static func document(_ id: String, type: String = "clinic_letter", date: String? = "2026-01-01", fileRef: String = "", mimeType: String = "",
                                 title: String? = nil, text: String = "# Letter", metadata: [String: Any] = [:]) -> [String: Any] {
        ["id": id, "title": title ?? "Doc \(id)", "type": type, "date": date ?? NSNull(), "fileRef": fileRef, "contentHash": "", "mimeType": mimeType,
         "extractedText": text, "addedAt": "2026-10-01T00:00:00.000Z", "metadata": metadata, "sourceFileName": "\(id).pdf"]
    }

    private func screen(_ documents: [[String: Any]]) throws -> MyData {
        let engine = try HealthEngine()
        let empty = try engine.blocking { try $0.newRecord(now: .now, deviceId: "test") }
        var record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(empty.utf8)) as? [String: Any])
        record["documents"] = documents
        let json = String(decoding: try JSONSerialization.data(withJSONObject: record), as: UTF8.self)
        return try engine.blocking { try $0.screen(recordJSON: json, now: .now, deviceId: "test") }.myData
    }

    func testTheEngineListsScanResultsThenDocumentsNewestFirstWithoutArchiveRows_US73_AC12() throws {
        let shelf = try XCTUnwrap(screen([
            Self.document("old", date: "2025-03-02"),
            Self.document("scan", type: "scan_result", date: "2026-05-01", fileRef: "Scans/2026-05-01 Chest X-ray.jpg", mimeType: "image/jpeg"),
            Self.document("new", date: "2026-09-14"),
            Self.document("labs", type: "pathology_report", title: "Blood test results", text: "", metadata: ["labArchive": true]),
        ]).documents?.value)
        XCTAssertEqual(shelf.scans.map(\.id), ["scan"])
        XCTAssertEqual(shelf.others.map(\.id), ["new", "old"])
        XCTAssertEqual(shelf.scans[0].original, MyData.Document.Original(name: "2026-05-01 Chest X-ray.jpg", mimeType: "image/jpeg"))
        XCTAssertNil(shelf.others[0].original)
        XCTAssertEqual(shelf.others[0].typeLabel, "Clinic Letter")
        XCTAssertEqual(shelf.others[0].content, "# Letter")
    }

    func testARecordWithNoDocumentsListsNone_US73_AC12() throws {
        XCTAssertEqual(try screen([]).documents?.value?.isEmpty, true)
    }

    func testAnUndatedDocumentSaysDateUnknownAsTheWebDoes_US73_AC12() throws {
        let shelf = try XCTUnwrap(screen([Self.document("undated", date: nil)]).documents?.value)
        XCTAssertEqual(shelf.others[0].dayText, "Date unknown")
    }

    /// An older engine sends no `documents`; a malformed list reads as none, never a blank My data.
    func testAMissingOrMalformedListNeverBlanksMyData_US73_AC12() throws {
        let decoded = try JSONDecoder().decode(Lenient<MyData.Documents>.self, from: Data(#"{"scans": 3}"#.utf8))
        XCTAssertNil(decoded.value)
    }

    func testThePageDrawsTheWebsMarkdownBlocks_US73_AC12() {
        let blocks = DocumentText.blocks("""
        # Cardiology follow-up
        Seen today.
        Echo **normal**.

        - Continue statin
        2. Review in 6 months
        | Test | Result |
        |------|--------|
        | LVEF | 60% |
        After the table.
        """)
        XCTAssertEqual(blocks, [
            .heading(level: 1, text: "Cardiology follow-up"),
            .paragraph("Seen today.\nEcho **normal**."),
            .bullet("Continue statin"),
            .numbered("2.", "Review in 6 months"),
            .table([["Test", "Result"], ["LVEF", "60%"]]),
            .paragraph("After the table."),
        ])
    }

    /// Design review: a first heading that repeats the page's title is not drawn twice, and a table
    /// too wide for the screen reads as one block per row, every value kept.
    func testTheRepeatedTitleIsDroppedAndAWideTableStacks_US73_AC12() {
        XCTAssertEqual(DocumentText.blocks("# Cardiology follow-up\nSeen.", title: "cardiology follow-up "), [.paragraph("Seen.")])
        XCTAssertEqual(DocumentText.blocks("# Summary\nSeen.", title: "Cardiology follow-up").first, .heading(level: 1, text: "Summary"))
        let stacked = DocumentText.stacked([["Test", "Result", "Range"], ["LDL cholesterol", "2.4 mmol/L", "<3.0"]])
        XCTAssertEqual(stacked.map(\.name), ["LDL cholesterol"])
        XCTAssertEqual(stacked.map(\.rest), ["Result 2.4 mmol/L · Range <3.0"])
    }

    /// Words from an uploaded file never open anything: a link keeps its text and loses its target.
    func testALinkInADocumentIsPlainText_US73_AC12() {
        let text = DocumentText.inline("See [the clinic](https://example.test/x) and **bold**")
        XCTAssertEqual(String(text.characters), "See the clinic and bold")
        XCTAssertTrue(text.runs.allSatisfy { $0.link == nil })
    }

    /// Only passive kinds open in Quick Look; an SVG or a web page can carry script (US-14 AC3).
    func testOnlyAPDFPhotoOrPlainTextOpensInQuickLook_US73_AC12() {
        let original = { (name: String, type: String) in MyData.Document.Original(name: name, mimeType: type) }
        XCTAssertTrue(DocumentPage.previewable(original("2026-09-14 Letter.pdf", "application/pdf")))
        XCTAssertTrue(DocumentPage.previewable(original("2026-05-01 Chest X-ray.jpg", "image/jpeg")))
        XCTAssertTrue(DocumentPage.previewable(original("Scan", "image/png")))
        XCTAssertFalse(DocumentPage.previewable(original("Diagram.svg", "image/svg+xml")))
        XCTAssertFalse(DocumentPage.previewable(original("Letter.html", "text/html")))
        XCTAssertFalse(DocumentPage.previewable(original("Notes.docx", "")))
    }

    /// The original is read through the engine's optional door, which this app's engine has: with
    /// no cloud open it refuses, and on the phone alone the store says there is no cloud to read.
    func testTheOriginalIsReadOnlyFromAnOpenCloud_US73_AC12() async throws {
        let engine = try HealthEngine()
        do {
            _ = try await engine.documentOriginal(id: "doc-1")
            XCTFail("read with no cloud open")
        } catch {}
        let folder = FileManager.default.temporaryDirectory.appending(path: "Documents \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let outcome = await store.original(of: "doc-1")
        XCTAssertEqual(outcome, .noCloud)
    }

    /// The preview's copy lives in its own folder under the app's temporary directory, by its own name.
    func testTheOriginalIsWrittenUnderItsOwnNameForQuickLook_US73_AC12() throws {
        let url = try DocumentPage.write(Data("%PDF".utf8), named: "2026-09-14 Letter.pdf")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        XCTAssertEqual(url.lastPathComponent, "2026-09-14 Letter.pdf")
        XCTAssertEqual(try Data(contentsOf: url), Data("%PDF".utf8))
    }
}
