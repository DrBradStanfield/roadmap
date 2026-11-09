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

    /// An older engine sends no `documents`; a malformed list reads as empty, and a row this app
    /// cannot read (no title, a day that is no text) drops only itself (review R1).
    func testAMalformedListOrRowNeverHidesTheOthers_US73_AC12() throws {
        let decoded = try JSONDecoder().decode(MyData.Documents.self, from: Data(#"{"scans": 3}"#.utf8))
        XCTAssertTrue(decoded.isEmpty)
        let good = #"{"id":"good","title":"Letter","typeLabel":"Clinic Letter","day":"2026-09-14","content":"x","sourceFileName":null,"original":null}"#
        let untitled = #"{"id":"untitled","typeLabel":"Clinic Letter","day":null,"content":"","sourceFileName":null,"original":null}"#
        let badDay = #"{"id":"bad","title":"T","typeLabel":"Document","day":5,"content":"","sourceFileName":null,"original":null}"#
        let mixed = try JSONDecoder().decode(MyData.Documents.self, from: Data("{\"scans\":[\(badDay)],\"others\":[\(untitled),\(good)]}".utf8))
        XCTAssertEqual(mixed.scans.map(\.id), [])
        XCTAssertEqual(mixed.others.map(\.id), ["good"])
    }

    /// Review R1: a legacy row with no title or date, beside valid measurements, still draws My data
    /// and the other documents, through the engine's own screen.
    func testALegacyRowDrawsBesideTheOthers_US73_AC12() throws {
        let shelf = try XCTUnwrap(screen([["id": "legacy", "type": "clinic_letter"], Self.document("valid", date: "2026-09-14")]).documents?.value)
        XCTAssertEqual(shelf.others.map(\.id), ["valid", "legacy"])
        XCTAssertEqual(shelf.others[1].title, "")
        XCTAssertEqual(shelf.others[1].dayText, "Date unknown")
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

    /// Only the web's passive kinds open in Quick Look (file-kinds.ts VIEWABLE_TYPES, US-14 AC3): by
    /// the extension, a stated type agreeing; a name with none takes its type's (review R4).
    func testOnlyTheWebsPassiveKindsOpenInQuickLook_US73_AC12() {
        let name = { (file: String, type: String) in DocumentPage.previewName(MyData.Document.Original(name: file, mimeType: type)) }
        XCTAssertEqual(name("2026-09-14 Letter.pdf", "application/pdf"), "2026-09-14 Letter.pdf")
        XCTAssertEqual(name("2026-05-01 Chest X-ray.jpg", "image/jpeg"), "2026-05-01 Chest X-ray.jpg")
        XCTAssertEqual(name("Scan.HEIC", ""), "Scan.HEIC")
        XCTAssertEqual(name("Scan", "image/png"), "Scan.png")
        XCTAssertEqual(name("Letter.pdf", "application/octet-stream"), "Letter.pdf")
        XCTAssertNil(name("Diagram.svg", "image/svg+xml"))
        XCTAssertNil(name("Letter.html", "text/html"))
        XCTAssertNil(name("Notes.txt", "text/plain"))
        XCTAssertNil(name("Notes.docx", ""))
        XCTAssertNil(name("Letter", ""))
        // A passive name over a stated type that is not its own does not open.
        XCTAssertNil(name("Letter.pdf", "text/html"))
        // Only the canonical type passes, as the web's viewableType: aliases are refused.
        XCTAssertNil(name("Scan.jpg", "image/jpg"))
        XCTAssertNil(name("Scan.jpeg", "image/pjpeg"))
        XCTAssertNil(name("Letter.pdf", "application/x-pdf"))
        XCTAssertNil(name("Scan", "image/jpg"))
        XCTAssertEqual(name("Scan.JPG", "Image/JPEG; charset=binary"), "Scan.JPG")
        XCTAssertEqual(name("Scan", "image/jpeg"), "Scan.jpeg")
    }

    /// Review R2: leaving the page while the original is read writes nothing.
    func testLeavingDuringTheReadWritesNothing_US73_AC12() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Originals \(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: folder) }
        let original = MyData.Document.Original(name: "Letter.pdf", mimeType: "application/pdf")
        let read = Task { @MainActor in
            await DocumentPage.fetch(original, in: folder) {
                try? await Task.sleep(for: .seconds(2))
                return .file(Data("%PDF".utf8))
            }
        }
        read.cancel()
        let outcome = await read.value
        XCTAssertNil(outcome)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
        // Not left: the copy is written, and a sweep removes every copy.
        let kept = await DocumentPage.fetch(original, in: folder) { .file(Data("%PDF".utf8)) }
        guard case .preview(let url)? = kept else { return XCTFail("no preview") }
        XCTAssertEqual(try Data(contentsOf: url), Data("%PDF".utf8))
        DocumentPage.sweep(folder)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.path))
    }

    /// The original is read through the engine's optional door, which this app's engine has: with
    /// no cloud open it refuses, and on the phone alone the store says there is no cloud to read.
    func testTheOriginalIsReadOnlyFromAnOpenCloud_US73_AC12() async throws {
        let engine = try HealthEngine()
        do {
            _ = try await engine.documentOriginal(id: "doc-1")
            XCTFail("read with no cloud open")
        } catch {
            XCTAssertEqual(RecordStore.failure(error), .opening, "the engine's not-open rejection (review R6)")
        }
        let folder = FileManager.default.temporaryDirectory.appending(path: "Documents \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let outcome = await store.original(of: "doc-1")
        XCTAssertEqual(outcome, .noCloud)
    }

    /// PR 972 review R6: each way an original fails to load says what happened and what to do,
    /// read from the engine's failure JSON; anything unclassed reads as unreachable.
    func testEachFailureSaysWhy_US73_AC12() async throws {
        let failed = { (json: String) in RecordStore.failure(HealthEngine.EngineError.callFailed(json)) }
        XCTAssertEqual(failed(#"{"kind":"not-open","detail":"x"}"#), .opening)
        XCTAssertEqual(failed(#"{"kind":"no-original","detail":"x"}"#), .missing)
        XCTAssertEqual(failed(#"{"kind":"sign-in","detail":"x"}"#), .signIn)
        XCTAssertEqual(failed(#"{"kind":"unreachable","detail":"x"}"#), .unreachable)
        XCTAssertEqual(failed("The cloud record is not open."), .unreachable, "an older engine's plain words")
        XCTAssertEqual(RecordStore.failure(CancellationError()), .unreachable)

        let original = MyData.Document.Original(name: "Letter.pdf", mimeType: "application/pdf")
        let said = { (failure: RecordStore.Failure) async in await DocumentPage.fetch(original) { .failed(failure) } }
        let signIn = await said(.signIn)
        XCTAssertEqual(signIn, .problem("Your cloud storage needs you to sign in again. Sign in from Sync, then try again."))
        let unreachable = await said(.unreachable)
        XCTAssertEqual(unreachable, .problem("Your cloud storage could not be reached. Check your connection, then try again."))
        let opening = await said(.opening)
        XCTAssertEqual(opening, .problem("Your record is still opening from your cloud storage. Try again in a moment."))
        let missing = await said(.missing)
        XCTAssertEqual(missing, .problem("This document's original is no longer in your cloud storage."))
        let unavailable = await said(.unavailable)
        XCTAssertEqual(unavailable, .problem(DocumentPage.couldNotLoad))
    }

    /// The preview's copy lives in its own folder under the app's temporary directory, by its own name.
    func testTheOriginalIsWrittenUnderItsOwnNameForQuickLook_US73_AC12() throws {
        let url = try DocumentPage.write(Data("%PDF".utf8), named: "2026-09-14 Letter.pdf")
        defer { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        XCTAssertEqual(url.lastPathComponent, "2026-09-14 Letter.pdf")
        XCTAssertEqual(try Data(contentsOf: url), Data("%PDF".utf8))
    }
}
