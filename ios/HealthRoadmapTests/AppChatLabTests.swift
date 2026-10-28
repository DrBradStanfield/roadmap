import Compression
import CryptoKit
import UIKit
import XCTest
@testable import HealthRoadmap

/// US-52: the chat and lab upload doors in JavaScriptCore (the same functions
/// ios/engine/app-doors.test.ts runs in Node), the NDJSON reader, the signed
/// client data, the PDF reader and the ZIP reader.
final class AppChatLabTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    private func record(_ engine: HealthEngine, _ edits: RecordEdit...) throws -> String {
        var record = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        for edit in edits {
            let outcome = try engine.blocking { [now] in try $0.apply(edit, to: record, now: now, deviceId: "test") }
            XCTAssertTrue(outcome.ok, outcome.message ?? "")
            record = try XCTUnwrap(outcome.record)
        }
        return record
    }

    // MARK: AC5: the chat context

    func testTheChatContextIsTheWidgetsPayload() throws {
        let engine = try HealthEngine()
        let start = try record(engine, .profile(sex: "female", birthYear: 1970, birthMonth: 3, height: 165), .add(metric: "ldl", value: 2.9, day: "2026-09-10"))
        let json = try engine.blocking { [now] in try $0.chatContext(recordJSON: start, now: now, deviceId: "test") }
        let context = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(context["unitSystem"] as? String, "si")
        XCTAssertEqual(context["sex"] as? String, "female")
        XCTAssertEqual(context["ldlC"] as? Double, 2.9)
        XCTAssertNotNil((context["measurementHistory"] as? [String: Any])?["ldl"])
    }

    // MARK: AC6: chat history through ChatSession (async in JavaScript, settled by the call's end)

    func testChatHistoryRecordsListsAndDeletesInJavaScriptCore() throws {
        let engine = try HealthEngine()
        let first = try engine.blocking { [now] in try $0.recordChatExchange(historyJSON: nil, exchange: ChatExchange(conversationId: "c1", isNew: true, userText: "What is ApoB?", assistantText: "A particle count.", isFallback: false), now: now, deviceId: "test") }
        let second = try engine.blocking { [now] in try $0.recordChatExchange(historyJSON: first, exchange: ChatExchange(conversationId: "c1", isNew: false, userText: "And LDL?", assistantText: "Related.", isFallback: false), now: now.addingTimeInterval(60), deviceId: "test") }
        XCTAssertEqual(try engine.blocking { [now] in try $0.chatConversations(historyJSON: second, now: now, deviceId: "test") }.map(\.title), ["What is ApoB?"])
        XCTAssertEqual(try engine.blocking { [now] in try $0.chatMessages(historyJSON: second, conversationId: "c1", now: now, deviceId: "test") }.map(\.content), ["What is ApoB?", "A particle count.", "And LDL?", "Related."])
        let deleted = try engine.blocking { [now] in try $0.deleteChat(historyJSON: second, conversationId: "c1", now: now, deviceId: "test") }
        XCTAssertEqual(try engine.blocking { [now] in try $0.chatConversations(historyJSON: deleted, now: now, deviceId: "test") }, [])
    }

    /// Codex (US-52 AC6): a conversation still loading when the person taps New chat, or
    /// opens another, never replaces what the screen then shows.
    @MainActor
    func testALateConversationLoadIsDroppedOnceTheScreenMovesOn() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Chat Load \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let chat = ChatHistoryStore(engine: try HealthEngine(), folder: folder, deviceId: "test")
        for id in ["c1", "c2"] {
            await chat.record(ChatExchange(conversationId: id, isNew: true, userText: "Q \(id)", assistantText: "A.", isFallback: false), askedAt: ChatHistoryStore.erasures)
        }

        let opened = await chat.open("c1").value
        XCTAssertEqual(opened?.first?.content, "Q c1", "nothing moved: the load lands")

        let beforeNewChat = chat.open("c1")
        chat.leave() // New chat
        let dropped = await beforeNewChat.value
        XCTAssertNil(dropped, "New chat wins")

        let first = chat.open("c1")
        let second = chat.open("c2")
        let (late, latest) = await (first.value, second.value)
        XCTAssertNil(late, "the later open wins")
        XCTAssertEqual(latest?.first?.content, "Q c2")
    }

    /// US-52 AC6: the History sheet lists the conversations saved on the phone. The app's
    /// one store starts empty at launch; opening History reads the file (ChatView's button).
    @MainActor
    func testTheHistorySheetListsSavedConversations() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Chat List \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let engine = try HealthEngine()
        let earlier = ChatHistoryStore(engine: engine, folder: folder, deviceId: "test")
        for id in ["c1", "c2"] {
            await earlier.record(ChatExchange(conversationId: id, isNew: true, userText: "Q \(id)", assistantText: "A.", isFallback: false), askedAt: ChatHistoryStore.erasures)
        }
        let launched = ChatHistoryStore(engine: engine, folder: folder, deviceId: "test")
        XCTAssertEqual(launched.conversations, [], "empty until read")
        await launched.refresh() // History, as it opens
        XCTAssertEqual(Set(launched.conversations.map(\.id)), ["c1", "c2"])
    }

    /// R9 (US-52 AC6): a swiped conversation leaves the list at once, before the engine
    /// writes its tombstone, so its row never springs back; the list is read again after.
    @MainActor
    func testADeletedConversationLeavesTheListAtOnce() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Chat Delete \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let chat = ChatHistoryStore(engine: try HealthEngine(), folder: folder, deviceId: "test")
        await chat.record(ChatExchange(conversationId: "c1", isNew: true, userText: "Q", assistantText: "A.", isFallback: false), askedAt: ChatHistoryStore.erasures)
        XCTAssertEqual(chat.conversations.map(\.id), ["c1"])

        let deleting = chat.delete("c1")
        XCTAssertEqual(chat.conversations, [], "gone before the engine has written")
        await deleting.value
        XCTAssertEqual(chat.conversations, [], "and still gone once the list is read again")
    }

    /// Re-check N3 (US-52 AC6): a list read that runs before a swiped conversation's
    /// tombstone is written (an earlier delete's refresh) never shows its row again.
    @MainActor
    func testAListReadBeforeADeleteLandsNeverShowsItsRow() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Chat Delete Twice \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let chat = ChatHistoryStore(engine: try HealthEngine(), folder: folder, deviceId: "test")
        for id in ["c1", "c2"] {
            await chat.record(ChatExchange(conversationId: id, isNew: true, userText: "Q \(id)", assistantText: "A.", isFallback: false), askedAt: ChatHistoryStore.erasures)
        }
        let deleting = chat.delete("c2")
        await chat.refresh() // asked before the delete's write is on the engine's queue
        XCTAssertEqual(chat.conversations.map(\.id), ["c1"], "c2 never comes back")
        await deleting.value
        XCTAssertEqual(chat.conversations.map(\.id), ["c1"])
    }

    // MARK: AC5: the streamed answer

    func testTheStreamReaderKnowsTheWebsEvents() {
        XCTAssertEqual(ChatStreamEvent.parse(#"{"type":"status","text":"Reading your question"}"#), .status("Reading your question"))
        XCTAssertEqual(ChatStreamEvent.parse(#"{"type":"text","text":"Hi"}"#), .text("Hi"))
        XCTAssertEqual(ChatStreamEvent.parse(#"{"type":"sources","titles":["ApoB",3]}"#), .sources(["ApoB"]))
        XCTAssertEqual(ChatStreamEvent.parse(#"{"type":"thinking","text":"x"}"#), .other)
        XCTAssertEqual(ChatStreamEvent.parse(#"{"type":"done","success":true,"content":"All","isFallback":false}"#), .done(content: "All", isFallback: false, error: nil))
        XCTAssertEqual(ChatStreamEvent.parse(#"{"type":"done","success":false,"error":"Failed"}"#), .done(content: nil, isFallback: false, error: "Failed"))
        XCTAssertNil(ChatStreamEvent.parse("not json"))
        // CHAT_STREAMING=false: one JSON reply with no type is the final answer.
        XCTAssertEqual(ChatStreamEvent.parse(#"{"success":true,"content":"Plain","isFallback":false}"#), .done(content: "Plain", isFallback: false, error: nil))
    }

    // MARK: AC1: what the app signs

    func testTheSignedClientDataIsMethodPathAndBodyHash() {
        let body = Data(#"{"message":"hello"}"#.utf8)
        let hash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(String(decoding: AppAttestClient.clientData(path: "/api/app/v1/chat", body: body), as: UTF8.self), "POST\n/api/app/v1/chat\n\(hash)")
    }

    // MARK: AC7/AC8: lab review and the write

    private let extraction = #"""
    {"classification":"lab_report","reportDate":"2026-10-01",
     "values":[{"metric":"ldl","valueSI":3.1,"displayValue":3.1,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"},
               {"metric":"hba1c","valueSI":40,"displayValue":40,"displayUnit":"mmol/mol","displaySystem":"si","confidence":"medium","recordedAt":"2025-04-02"}],
     "additionalValues":[{"name":"Ferritin","value":85,"unit":"µg/L"}],
     "refusedValues":[{"metric":"creatinine","value":80,"unit":"","reason":"unit unknown"}]}
    """#

    func testTheLabReviewAndSaveRunTheWebsBulkRule() throws {
        let engine = try HealthEngine()
        let review = try engine.blocking { [now, extraction] in try $0.labReview(extractionJSON: extraction, now: now) }
        XCTAssertEqual(review.reportDay, "2026-10-01")
        XCTAssertEqual(review.items.map(\.ref), ["v0", "v1", "a0"])
        XCTAssertEqual(review.items[1].day, "2025-04-02")
        XCTAssertEqual(review.notSaved.first?.label, "Creatinine")

        let held = try record(engine, .add(metric: "ldl", value: 2.5, day: "2026-10-01"))
        let summary = try engine.blocking { [now, extraction] in try $0.labSaveSummary(recordJSON: held, extractionJSON: extraction, refs: ["v0", "v1", "a0"], reportDay: "2026-10-01", now: now, deviceId: "test") }.get()
        XCTAssertEqual(summary, LabSaveSummary(saved: 2, skipped: 1, refused: []))

        let outcome = try engine.blocking { [now, extraction] in try $0.apply(.labImport(extractionJSON: extraction, refs: ["v0", "v1", "a0"], reportDay: "2026-10-01"), to: held, now: now, deviceId: "test") }
        XCTAssertTrue(outcome.ok, outcome.message ?? "")
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(outcome.record).utf8)) as? [String: Any])
        let rows = try XCTUnwrap(file["measurements"] as? [[String: Any]])
        XCTAssertEqual(rows.filter { $0["source"] as? String == "lab_import" }.count, 1)
        XCTAssertEqual((file["labValues"] as? [Any])?.count, 1)

        XCTAssertThrowsError(try engine.blocking { [now, extraction] in try $0.labSaveSummary(recordJSON: held, extractionJSON: extraction, refs: ["v0"], reportDay: "2099-01-01", now: now, deviceId: "test") }.get())
    }

    // MARK: AC13d: documents

    func testALetterGetsTheWebsDocumentCard() throws {
        let engine = try HealthEngine()
        let letter = #"{"classification":"discharge_summary","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"discharge_summary","title":"Discharge","documentDate":"2026-09","contentMarkdown":"Short text","metadata":{}}}"#
        let start = try record(engine)
        let review = try engine.blocking { [now] in try $0.labReview(extractionJSON: letter, now: now, recordJSON: start, sourceFileName: "d.pdf", deviceId: "test") }
        XCTAssertFalse(review.isLabReport)
        XCTAssertEqual(review.document, LabReview.Document(classification: "discharge_summary", title: "Discharge", documentDate: nil, preview: "Short text", alreadySaved: false, held: false))
        XCTAssertNil(try engine.blocking { [now, extraction] in try $0.labReview(extractionJSON: extraction, now: now) }.document)
    }

    func testAReadFileKeepsItsOriginalBytes() async throws {
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 200)).pdfData { $0.beginPage() }
        let document = try XCTUnwrap(LabFileReader.documents(from: pdf, name: "a.pdf").first)
        XCTAssertEqual(document.original?.verifiedData(), pdf)
        XCTAssertEqual(document.original?.mimeType, "application/pdf")
        let photo = try await LabFileReader.pictures([UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).image { _ in }], name: "Photo")
        XCTAssertNil(photo.original)
    }

    /// A ZIP member's name is the web's zipMemberName, cap and hash included, so the
    /// document dedup key (`sourceFileName`) is one on the phone and the web. One call per ZIP.
    @MainActor
    func testAZipMembersNameIsTheWebsZipMemberName() async throws {
        let engine = try HealthEngine()
        let image = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { _ in }
        let long = String(repeating: "d", count: 260) + "/letter.png"
        let zip = Self.zip([("a/b.png", image, false), (long, image, false)])
        let names = await engine.named(try LabFileReader.documents(from: zip, name: "Records.zip")).map(\.name)
        // What health-core's zipMemberName gives in Node for these (computed 2026-10-22):
        // the long one cut to 255 with the FNV-1a hash of the whole name, its end kept.
        XCTAssertEqual(names, ["Records.zip/a/b.png", "~635451cb/" + String(repeating: "d", count: 234) + "/letter.png"])
        // R7: any other file's name goes through the same cleanup (one line, capped), in the same call.
        let plain = LabFileReader.Document(name: "Bad\u{7}\nname.pdf", pages: [], truncated: false)
        let cleaned = await engine.named([plain]).map(\.name)
        XCTAssertEqual(cleaned, ["Bad name.pdf"])
    }

    /// A folder's originals are the files themselves, read again when saved: no bytes
    /// mapped from a picked folder outlive the picker's access (US-52 AC13d).
    func testAFoldersOriginalsAreStillReadableAfterTheRead() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Picked \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder.appending(path: "sub"), withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 200, height: 200)).pdfData { $0.beginPage() }
        let png = UIGraphicsImageRenderer(size: CGSize(width: 4, height: 4)).pngData { _ in }
        try pdf.write(to: folder.appending(path: "a.pdf"))
        try png.write(to: folder.appending(path: "sub/b.png"))
        let documents = try await LabFileReader.documents(inFolder: folder)
        XCTAssertEqual(documents.map { $0.original?.verifiedData() }, [pdf, png])
        XCTAssertEqual(documents.map { $0.original?.mimeType }, ["application/pdf", "image/png"])
        for document in documents {
            guard case .file = document.original?.source else { return XCTFail("\(document.name) holds bytes, not its file") }
        }
        // Codex R2: changed since the review read it (same size, other bytes), or gone: no bytes.
        var other = pdf
        other[other.count - 1] ^= 0xFF
        try other.write(to: folder.appending(path: "a.pdf"))
        XCTAssertNil(documents[0].original?.verifiedData())
        try FileManager.default.removeItem(at: folder.appending(path: "sub/b.png"))
        XCTAssertNil(documents[1].original?.verifiedData())
        // The fingerprint is the web's sha256Blob format.
        XCTAssertEqual(documents[1].original?.contentHash, "sha256-" + SHA256.hash(data: png).map { String(format: "%02x", $0) }.joined())
    }

    // MARK: AC7: reading files

    func testAPdfPageWithTextGoesAsText() throws {
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { context in
            context.beginPage()
            ("Synthetic Lab Report. LDL Cholesterol 3.1 mmol/L. HbA1c 40 mmol/mol. Collected 2026-10-01." as NSString)
                .draw(in: CGRect(x: 40, y: 40, width: 530, height: 700), withAttributes: [.font: UIFont.systemFont(ofSize: 14)])
            context.beginPage() // a blank page: a "scan", sent as a picture
        }
        let documents = try LabFileReader.documents(from: pdf, name: "labs.pdf")
        XCTAssertEqual(documents.count, 1)
        XCTAssertEqual(documents[0].pages.map(\.type), ["text", "image"])
        XCTAssertTrue(documents[0].pages[0].content.hasPrefix("[Page 1/2]\n"))
        XCTAssertTrue(documents[0].pages[0].content.contains("LDL Cholesterol 3.1"))
        XCTAssertEqual(documents[0].pages[1].mimeType, "image/jpeg")
    }

    func testAZipGivesItsReportsOneByOne() throws {
        let image = UIGraphicsImageRenderer(size: CGSize(width: 20, height: 20)).pngData { context in
            UIColor.gray.setFill(); context.fill(CGRect(x: 0, y: 0, width: 20, height: 20))
        }
        let zip = Self.zip([("bundle/a.png", image, false), ("bundle/b.png", image, true), ("notes.txt", Data("skip".utf8), false), ("__MACOSX/._a.png", Data("x".utf8), false)])
        let documents = try LabFileReader.documents(from: zip, name: "labs.zip")
        XCTAssertEqual(documents.map(\.name), ["labs.zip/bundle/a.png", "labs.zip/bundle/b.png"])
        XCTAssertEqual(documents.map { $0.pages.first?.type }, ["image", "image"])
        XCTAssertThrowsError(try LabFileReader.documents(from: Data("not a zip".utf8), name: "x.zip"))
        // More members than the cap is refused before they pile up in memory.
        XCTAssertThrowsError(try ZipReader.members(of: zip, maxMemberBytes: 1_000_000, maxMembers: 1) { _ in true })
    }

    /// US-52 AC7, Codex re-check R1: a stored member that declares fewer bytes than it
    /// holds is refused, and the archive cap counts the bytes actually kept, so many
    /// entries pointing at one payload cannot pile up gigabytes.
    func testAZipCannotUnderstateOrReuseItsBytes() throws {
        let payload = Data(repeating: 0x41, count: 1000)
        // One stored member that says it is 1 byte but holds 1,000.
        let understated = Self.rawZip(payload: payload, method: 0, entries: [(name: "a.pdf", compressed: 1000, size: 1)])
        XCTAssertThrowsError(try ZipReader.members(of: understated, maxMemberBytes: 10_000) { _ in true })
        // Honest stored entries, all pointing at the same payload: the kept bytes reach the cap.
        let reused = Self.rawZip(payload: payload, method: 0, entries: (0..<5).map { (name: "r\($0).pdf", compressed: 1000, size: 1000) })
        XCTAssertEqual(try ZipReader.members(of: reused, maxMemberBytes: 10_000, maxTotalBytes: 5000) { _ in true }.count, 5)
        XCTAssertThrowsError(try ZipReader.members(of: reused, maxMemberBytes: 10_000, maxTotalBytes: 4999) { _ in true })
        // The same through deflate: every entry inflates the one blob, and the cap still holds.
        let deflated = Self.deflate(payload)
        let overlapping = Self.rawZip(payload: deflated, method: 8, entries: (0..<5).map { (name: "d\($0).pdf", compressed: deflated.count, size: 1000) })
        XCTAssertThrowsError(try ZipReader.members(of: overlapping, maxMemberBytes: 10_000, maxTotalBytes: 4999) { _ in true })
    }

    /// One local payload, then central entries that each point at it, declaring what they like.
    private static func rawZip(payload: Data, method: Int, entries: [(name: String, compressed: Int, size: Int)]) -> Data {
        // Appended one field at a time: a long `+` chain makes the type checker crawl.
        var out = Data()
        func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { out.append(contentsOf: $0) } }
        func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { out.append(contentsOf: $0) } }
        for v in [0x0403_4b50] { u32(v) }
        for v in [20, 0, method, 0, 0] { u16(v) }
        for v in [0, payload.count, payload.count] { u32(v) }
        for v in [1, 0] { u16(v) }
        out.append(Data("p".utf8))
        out.append(payload)
        let start = out.count
        for entry in entries {
            u32(0x0201_4b50)
            for v in [20, 20, 0, method, 0, 0] { u16(v) }
            for v in [0, entry.compressed, entry.size] { u32(v) }
            for v in [entry.name.utf8.count, 0, 0, 0, 0] { u16(v) }
            for v in [0, 0] { u32(v) } // external attributes; local header at offset 0
            out.append(Data(entry.name.utf8))
        }
        let centralSize = out.count - start
        u32(0x0605_4b50)
        for v in [0, 0, entries.count, entries.count] { u16(v) }
        for v in [centralSize, start] { u32(v) }
        u16(0)
        return out
    }

    /// A minimal ZIP: stored or raw-deflated members, with a central directory.
    private static func zip(_ members: [(String, Data, Bool)]) -> Data {
        var out = Data()
        var central = Data()
        func u16(_ v: Int) -> Data { withUnsafeBytes(of: UInt16(v).littleEndian) { Data($0) } }
        func u32(_ v: Int) -> Data { withUnsafeBytes(of: UInt32(v).littleEndian) { Data($0) } }
        for (name, data, deflate) in members {
            let stored: Data = deflate ? Self.deflate(data) : data
            let offset = out.count
            let header = u16(20) + u16(0) + u16(deflate ? 8 : 0) + u16(0) + u16(0) + u32(0) + u32(stored.count) + u32(data.count) + u16(name.utf8.count) + u16(0)
            out += u32(0x0403_4b50) + header + Data(name.utf8) + stored
            central += u32(0x0201_4b50) + u16(20) + header + u16(0) + u16(0) + u16(0) + u32(0) + u32(offset) + Data(name.utf8)
        }
        let start = out.count
        out += central
        out += u32(0x0605_4b50) + u16(0) + u16(0) + u16(members.count) + u16(members.count) + u32(central.count) + u32(start) + u16(0)
        return out
    }

    private static func deflate(_ data: Data) -> Data {
        var output = Data(count: data.count + 64)
        let written = output.withUnsafeMutableBytes { out in
            data.withUnsafeBytes { input in
                compression_encode_buffer(out.bindMemory(to: UInt8.self).baseAddress!, data.count + 64, input.bindMemory(to: UInt8.self).baseAddress!, data.count, nil, COMPRESSION_ZLIB)
            }
        }
        return output.prefix(written)
    }
}
