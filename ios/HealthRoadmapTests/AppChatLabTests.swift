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
        var record = try engine.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        for edit in edits {
            let outcome = try engine.apply(edit, to: record, now: now, deviceId: "test")
            XCTAssertTrue(outcome.ok, outcome.message ?? "")
            record = try XCTUnwrap(outcome.record)
        }
        return record
    }

    // MARK: AC5: the chat context

    func testTheChatContextIsTheWidgetsPayload() throws {
        let engine = try HealthEngine()
        let json = try engine.chatContext(recordJSON: try record(engine, .profile(sex: "female", birthYear: 1970, birthMonth: 3, height: 165), .add(metric: "ldl", value: 2.9, day: "2026-09-10")), now: now, deviceId: "test")
        let context = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
        XCTAssertEqual(context["unitSystem"] as? String, "si")
        XCTAssertEqual(context["sex"] as? String, "female")
        XCTAssertEqual(context["ldlC"] as? Double, 2.9)
        XCTAssertNotNil((context["measurementHistory"] as? [String: Any])?["ldl"])
    }

    // MARK: AC6: chat history through ChatSession (async in JavaScript, settled by the call's end)

    func testChatHistoryRecordsListsAndDeletesInJavaScriptCore() throws {
        let engine = try HealthEngine()
        let first = try engine.recordChatExchange(historyJSON: nil, exchange: ChatExchange(conversationId: "c1", isNew: true, userText: "What is ApoB?", assistantText: "A particle count.", isFallback: false), now: now, deviceId: "test")
        let second = try engine.recordChatExchange(historyJSON: first, exchange: ChatExchange(conversationId: "c1", isNew: false, userText: "And LDL?", assistantText: "Related.", isFallback: false), now: now.addingTimeInterval(60), deviceId: "test")
        XCTAssertEqual(try engine.chatConversations(historyJSON: second, now: now, deviceId: "test").map(\.title), ["What is ApoB?"])
        XCTAssertEqual(try engine.chatMessages(historyJSON: second, conversationId: "c1", now: now, deviceId: "test").map(\.content), ["What is ApoB?", "A particle count.", "And LDL?", "Related."])
        let deleted = try engine.deleteChat(historyJSON: second, conversationId: "c1", now: now, deviceId: "test")
        XCTAssertEqual(try engine.chatConversations(historyJSON: deleted, now: now, deviceId: "test"), [])
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
        let review = try engine.labReview(extractionJSON: extraction, now: now)
        XCTAssertEqual(review.reportDay, "2026-10-01")
        XCTAssertEqual(review.items.map(\.ref), ["v0", "v1", "a0"])
        XCTAssertEqual(review.items[1].day, "2025-04-02")
        XCTAssertEqual(review.notSaved.first?.label, "Creatinine")

        let held = try record(engine, .add(metric: "ldl", value: 2.5, day: "2026-10-01"))
        let summary = try engine.labSaveSummary(recordJSON: held, extractionJSON: extraction, refs: ["v0", "v1", "a0"], reportDay: "2026-10-01", now: now, deviceId: "test").get()
        XCTAssertEqual(summary, LabSaveSummary(saved: 2, skipped: 1, refused: []))

        let outcome = try engine.apply(.labImport(extractionJSON: extraction, refs: ["v0", "v1", "a0"], reportDay: "2026-10-01"), to: held, now: now, deviceId: "test")
        XCTAssertTrue(outcome.ok, outcome.message ?? "")
        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(try XCTUnwrap(outcome.record).utf8)) as? [String: Any])
        let rows = try XCTUnwrap(file["measurements"] as? [[String: Any]])
        XCTAssertEqual(rows.filter { $0["source"] as? String == "lab_import" }.count, 1)
        XCTAssertEqual((file["labValues"] as? [Any])?.count, 1)

        XCTAssertThrowsError(try engine.labSaveSummary(recordJSON: held, extractionJSON: extraction, refs: ["v0"], reportDay: "2099-01-01", now: now, deviceId: "test").get())
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
