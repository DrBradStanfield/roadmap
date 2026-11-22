import UIKit
import XCTest
@testable import HealthRoadmap

/// US-52 end to end, opt-in: the app's own clients against a LOCAL server
/// (`npm run build`, then react-router-serve with NODE_ENV=development and
/// APP_ATTEST_DEV_BYPASS=1 on port 3000). One real chat turn and one real lab
/// extraction of a SYNTHETIC report, so it spends a little Anthropic money:
/// it runs only with TEST_RUNNER_HEALTH_ROADMAP_E2E=1, never in test.sh.
final class AppServerE2ETests: XCTestCase {
    private var enabled: Bool { ProcessInfo.processInfo.environment["HEALTH_ROADMAP_E2E"] == "1" }

    func testOneChatTurnStreamsFromTheLocalServer() async throws {
        try XCTSkipUnless(enabled, "set TEST_RUNNER_HEALTH_ROADMAP_E2E=1 with a local server running")
        let engine = try HealthEngine()
        let record = try engine.blocking { try $0.newRecord(now: .now, deviceId: "e2e", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        let context = try engine.blocking { try $0.chatContext(recordJSON: record, now: .now, deviceId: "e2e") }
        let body = try ChatClient.body(message: "In one sentence, what is ApoB?", conversationId: UUID().uuidString.lowercased(), history: [], contextJSON: context)
        var statuses: [String] = []
        var streamed = ""
        var final: String?
        for try await event in ChatClient().ask(body: body) {
            switch event {
            case .status(let text): statuses.append(text)
            case .text(let text): streamed += text
            case .done(let content, _, let error, _): XCTAssertNil(error); final = content
            default: break
            }
        }
        XCTAssertTrue(statuses.contains("Reading your question"))
        XCTAssertFalse(streamed.isEmpty, "the answer streamed")
        XCTAssertFalse(try XCTUnwrap(final).isEmpty)
        print("E2E chat: \(statuses.count) status lines, \(streamed.count) streamed characters, final \(final?.count ?? 0) characters")
    }

    @MainActor func testOneSyntheticLabReportIsReadAndWritten() async throws {
        try XCTSkipUnless(enabled, "set TEST_RUNNER_HEALTH_ROADMAP_E2E=1 with a local server running")
        // A made-up report: no real person, no real result.
        let lines = [
            "Example Community Laboratory - SYNTHETIC TEST REPORT",
            "Patient: Test Person (synthetic). Collected: 2026-10-01. Reported: 2026-10-02.",
            "LDL Cholesterol 3.1 mmol/L (reference < 3.0)",
            "HDL Cholesterol 1.4 mmol/L (reference > 1.0)",
            "Total Cholesterol 5.2 mmol/L (reference < 5.5)",
            "Triglycerides 1.2 mmol/L (reference < 1.7)",
            "HbA1c 38 mmol/mol (reference 20 - 40)",
            "Ferritin 85 ug/L (reference 30 - 400)",
        ]
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: 612, height: 792)).pdfData { context in
            context.beginPage()
            (lines.joined(separator: "\n") as NSString).draw(in: CGRect(x: 40, y: 40, width: 530, height: 700), withAttributes: [.font: UIFont.systemFont(ofSize: 13)])
        }
        // Through the shared upload, as the sheet runs a file from Files: one read, one Save.
        let folder = FileManager.default.temporaryDirectory.appending(path: "E2E \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let file = folder.appending(path: "synthetic.pdf")
        try pdf.write(to: file)
        let store = try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "e2e")
        let upload = UploadSession(engine: store.engine, store: store)
        defer { upload.end() }
        let engine = store.engine
        let started = await upload.start({ try await LabFileReader.picked(file) { await engine.uploadRules(files: $0, members: $1) } }, needsConsent: false)
        XCTAssertEqual(started, .running)
        func page() -> UploadPage? { if case .drawn(let text) = upload.model.state { upload.page(text) } else { nil } }
        try await UploadTestKit.until("read", timeout: 120) { page()?.save.enabled == true }
        upload.send(.save)
        try await UploadTestKit.until("saved") { page()?.done != nil }
        XCTAssertNotNil(store.myData?.bloodTests.first { $0.metric == "ldl" }?.latest?.day, "LDL saved")
        print("E2E lab: \(page()?.done?.line ?? "no done line")")
    }
}
