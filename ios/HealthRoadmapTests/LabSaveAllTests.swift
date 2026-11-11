import XCTest
@testable import HealthRoadmap

/// US-52 AC8b: save all saves each waiting report as its own Save would, from the same
/// defaults the review shows, and nothing a single Save would not.
@MainActor
final class LabSaveAllTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Save All \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private let dated = #"""
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
    private let letter = ##"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Cardiology follow-up","documentDate":"2026-09-14","contentMarkdown":"# Letter","metadata":{}}}"##

    func testTheDefaultsAreTheReviewsOneDefinition_US52_AC8b() throws {
        let engine = try HealthEngine()
        let lab = try engine.blocking { [dated] in try $0.labReview(extractionJSON: dated, now: .now) }
        let choices = LabChoices(review: lab)
        XCTAssertEqual(choices.ticked, ["v0"], "a value with a question starts unticked")
        XCTAssertEqual(DayText.iso(choices.testDay), "2026-10-01")
        XCTAssertNil(choices.valuesWait(lab), "a dated report is ready to save")

        let noDay = try engine.blocking { [undated] in try $0.labReview(extractionJSON: undated, now: .now) }
        var waiting = LabChoices(review: noDay)
        XCTAssertEqual(waiting.valuesWait(noDay), "Needs the test day")
        waiting.dayConfirmed = true
        XCTAssertNil(waiting.valuesWait(noDay), "the day confirmed, it can save")
        waiting.ticked = []
        XCTAssertEqual(waiting.valuesWait(noDay), "No values ticked")

        let card = try engine.blocking { [letter] in try $0.labReview(extractionJSON: letter, now: .now) }
        let kept = LabChoices(review: card)
        XCTAssertTrue(kept.keepDocument, "a new letter is kept")
        XCTAssertEqual(kept.documentTitle, "Cardiology follow-up")
        XCTAssertTrue(kept.documentDateKnown)
        XCTAssertEqual(DayText.iso(kept.documentDate), "2026-09-14")
    }

    /// A question row, an undated report not confirmed, a letter already in the record and a
    /// report that could not be read save nothing; a change made on a screen already shown
    /// (the day confirmed) carries in, and the run goes on past each one not saved.
    func testSaveAllSavesNothingASingleSaveWouldNot_US52_AC8b() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let choice = DocumentChoice(kind: .document, sourceFileName: "Letter.pdf", title: "Cardiology follow-up", documentDate: nil, mimeType: "")
        let filed = await store.saveDocument(extractionJSON: letter, choice: choice, original: nil)
        XCTAssertEqual(filed, .saved(count: 1, stored: nil, unstored: 0, stale: false))

        let results = [
            LabResult(name: "Labs.pdf", truncated: false, extractionJSON: dated, failure: nil),
            LabResult(name: "Undated.pdf", truncated: false, extractionJSON: undated, failure: nil),
            LabResult(name: "Letter.pdf", truncated: false, extractionJSON: letter, failure: nil),
            LabResult(name: "Blurred.jpg", truncated: false, extractionJSON: nil, failure: "The AI could not read this file."),
            LabResult(name: "Undated again.pdf", truncated: false, extractionJSON: undated, failure: nil),
        ]
        // The last undated report was shown, and its day set and confirmed there.
        let noDay = try engine.blocking { [undated] in try $0.labReview(extractionJSON: undated, now: .now) }
        var confirmed = LabChoices(review: noDay)
        confirmed.testDay = try XCTUnwrap(DayText.noon("2026-08-03"))
        confirmed.dayConfirmed = true
        let held: [Int: LabChoices] = [4: confirmed]

        var outcomes: [ReportOutcome] = []
        for (i, result) in results.enumerated() {
            outcomes.append(await LabReportSave.saveWaiting(result, held: held[i], engine: engine, store: store))
        }
        XCTAssertEqual(outcomes, [
            .saved(values: 1, documents: 0),
            .notSaved("Needs the test day"),
            .notSaved("Already in your record"),
            .notSaved("Could not be read"),
            .saved(values: 1, documents: 0),
        ])

        let file = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(store.recordJSON.utf8)) as? [String: Any])
        let imported = ((file["labValues"] as? [[String: Any]]) ?? []) + ((file["measurements"] as? [[String: Any]]) ?? [])
        let rows = imported.filter { $0["source"] as? String == "lab_import" }
        XCTAssertEqual(rows.compactMap { $0["metricName"] as? String ?? $0["metric"] as? String }.sorted(), ["hdl", "ldl"], "the question row was not saved")
        XCTAssertTrue(rows.contains { ($0["recordedAt"] as? String)?.hasPrefix("2026-08-03") == true }, "the day confirmed on screen was used")
        XCTAssertEqual((file["documents"] as? [[String: Any]])?.count, 1, "the letter was not filed again")
    }
}
