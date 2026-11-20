import XCTest
@testable import HealthRoadmap

/// Design PR 15 (US-52 AC8c, US-13 AC13, AC14, US-12 AC26 to AC28): the review page decodes
/// every section the real bundled engine's view draws, and each tap is the event the engine
/// expects. The engine is stepped directly, its effects left undone. Synthetic files only.
@MainActor
final class UploadPageTests: XCTestCase {
    nonisolated static let now = "2026-11-15T09:00:00.000Z"

    /// One upload stepped on the real engine: its state's text and the record's.
    struct Drive {
        let engine: HealthEngine
        var state: String
        var record = ""

        init(record: String = "") throws {
            engine = try HealthEngine()
            self.record = record
            guard case .answered(let start)?? = try? engine.blocking({ try $0.uploadStart(platform: "phone") }) else { throw XCTSkip("no upload doors") }
            state = start
        }

        mutating func step(_ event: [String: Any]) { step(EngineNatives.json(event)) }

        mutating func step(_ event: String) {
            let (state, record) = (state, record)
            guard case .answered(let next)?? = try? engine.blocking({ try $0.uploadStep(state: state, event: event, record: record, deviceId: "test") }) else {
                return XCTFail("the engine refused \(event)")
            }
            self.state = next.state
        }

        func page(cloud: Bool = false) throws -> UploadPage {
            let (state, record) = (state, record)
            guard case .answered(let text)?? = try engine.blocking({ try $0.uploadView(state: state, record: record, now: .now, cloudConnected: cloud, deviceId: "test") }),
                  let page = UploadPage.decoded(text) else { throw XCTSkip("no view") }
            return page
        }

        var run: Int { (try? JSONSerialization.jsonObject(with: Data(state.utf8)) as? [String: Any])?["run"] as? Int ?? 0 }

        /// Picks `ids` (each "<id>.png"), not needing consent.
        mutating func pick(_ ids: [String]) {
            step(["type": "picked", "needsConsent": false, "now": UploadPageTests.now,
                  "files": ids.map { ["id": $0, "name": "\($0).png", "bytes": 100, "kind": "file"] }])
        }

        /// One file hashed and converted, so it is sending.
        mutating func sending(_ id: String, hash: String? = nil) {
            step(["type": "hashed", "run": run, "id": id, "hash": hash ?? "sha256-\(id)"])
            step(["type": "converted", "run": run, "id": id, "pages": 1, "truncated": false])
        }

        /// One file read: its send answered with `extraction`.
        mutating func read(_ id: String, _ extraction: String) {
            sending(id)
            step(["type": "streamEnded", "run": run, "id": id, "now": UploadPageTests.now,
                  "line": #"{"status":200,"body":{"success":true,"data":\#(extraction)}}"#])
        }
    }

    nonisolated static func lab(reportDate: String? = "2026-10-01", values: String) -> String {
        #"{"classification":"lab_report","reportDate":\#(reportDate.map { "\"\($0)\"" } ?? "null"),"values":[\#(values)],"additionalValues":[],"document":null}"#
    }
    nonisolated static let ldl = #"{"metric":"ldl","valueSI":3.1,"displayValue":3.1,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}"#
    nonisolated static let unsureHdl = #"{"metric":"hdl","valueSI":1.2,"displayValue":1.2,"displayUnit":"mmol/L","displaySystem":"si","confidence":"low"}"#
    nonisolated static func letter(_ title: String = "Cardiology follow-up", date: String? = "2026-09-14") -> String {
        let day = date.map { "\"\($0)\"" } ?? "null"
        return ###"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"\###(title)","documentDate":\###(day),"contentMarkdown":"## Plan\n\nWalk daily.","metadata":{}}}"###
    }

    /// The rows of the page's "check these values" section.
    static func unsure(_ page: UploadPage) -> [UploadPage.ValueRow] {
        page.sections.flatMap { section -> [UploadPage.ValueRow] in
            if case .unsure(_, _, let rows) = section { return rows }
            return []
        }
    }

    // MARK: Sections

    func testReadingShowsProgressStopAndEveryFileInPickedOrder() throws {
        var drive = try Drive()
        drive.pick(["c", "a", "b"])
        drive.sending("c")
        let page = try drive.page()
        XCTAssertEqual(page.progress, .init(done: 0, total: 3, line: "Reading 0 of 3 files", zip: nil))
        XCTAssertEqual(page.stop, .init(label: "Stop"))
        XCTAssertEqual(page.files.rows.map(\.fileId), ["c", "a", "b"])
        XCTAssertEqual(page.files.row, "Files (3)")
        XCTAssertEqual(page.save.enabled, false)
        XCTAssertEqual(page.save.why, "Wait for 3 files to finish")
        XCTAssertNil(page.done)
    }

    /// Results fill in as each file is read: a lab report's unsure value with the tick the engine
    /// gives it, its sure value behind Show all, a letter in the documents list, and a failure with Try again.
    func testMixedResultsDrawEachSectionKind() throws {
        var drive = try Drive()
        drive.pick(["lab", "letter", "busy"])
        drive.read("lab", Self.lab(values: "\(Self.ldl),\(Self.unsureHdl)"))
        drive.read("letter", Self.letter())
        drive.sending("busy")
        drive.step(["type": "sendFailed", "run": drive.run, "id": "busy", "status": 503, "body": #"{"error":"Busy","reason":"unavailable"}"#, "contentType": "application/json"])
        let page = try drive.page()
        XCTAssertNil(page.progress)
        XCTAssertNil(page.stop)
        guard case .unsure(let title, _, let rows) = page.sections.first(where: { if case .unsure = $0 { true } else { false } }) else { return XCTFail("no unsure section: \(page.sections)") }
        XCTAssertEqual(title, "Check this value")
        XCTAssertEqual(rows.map(\.ref), ["v1"])
        XCTAssertEqual(rows.first.map { [$0.label, $0.value, $0.unit] }, ["HDL Cholesterol", "1.2", "mmol/L"], "a value is checked against its printed number")
        // The tick is the engine's default for the phone (upload-rules defaultTicked), drawn as given: not pinned here.
        XCTAssertEqual(page.save.label, rows.first?.ticked == true ? "Save 2 values and 1 document" : "Save 1 value and 1 document")
        guard case .failed(let failedTitle, let failed, let retry) = page.sections.first(where: { if case .failed = $0 { true } else { false } }) else { return XCTFail("no failed section") }
        XCTAssertEqual(failedTitle, "1 file not read")
        XCTAssertEqual(failed.map(\.fileId), ["busy"])
        XCTAssertFalse(failed[0].line.isEmpty)
        XCTAssertEqual(retry, "Try again")
        XCTAssertEqual(page.sure?.line, "1 value will be saved")
        XCTAssertEqual(page.sure?.showAll, "Show all 1")
        XCTAssertEqual(page.sure?.hide, "Hide")
        XCTAssertEqual(page.documents?.line, "1 letter or document will be saved")
        XCTAssertEqual(page.documents?.rows.first, .init(fileId: "letter", title: "Cardiology follow-up", kind: "clinic letter", date: "14 Sep 2026", dateKnown: true,
                                                         kindKey: "clinic_letter", day: "2026-09-14"))
        XCTAssertEqual(page.documents?.kinds?.count, 6)
        XCTAssertEqual([page.documents?.setDate, page.documents?.removeDate], ["Set the date", "Remove the date"])
        XCTAssertEqual([page.phase, page.doneLabel], ["open", "Done"])
        XCTAssertEqual(page.closeEnabled, true)
        XCTAssertEqual(page.engineError, "The upload could not go on.")
        XCTAssertTrue(page.save.enabled, "a failed file never blocks Save")
    }

    func testAnUndatedReportAsksForItsDay() throws {
        var drive = try Drive()
        drive.pick(["u"])
        drive.read("u", Self.lab(reportDate: nil, values: Self.ldl))
        var page = try drive.page()
        XCTAssertEqual(page.sections.first, .undated(.init(fileId: "u", title: "This report has no date", label: "Day of the test", name: "u.png", choose: "Choose the day of the test", chosen: nil)))
        XCTAssertFalse(page.save.enabled)
        drive.step(UploadAction.testDay(fileId: "u", day: "2026-10-02").event(now: Self.now))
        page = try drive.page()
        // The picked day stays on the page, to be seen and changed.
        XCTAssertEqual(page.sections.first, .undated(.init(fileId: "u", title: "This report has no date", label: "Day of the test", name: "u.png", choose: "Choose the day of the test", chosen: "2026-10-02")))
        XCTAssertTrue(page.save.enabled)
    }

    /// Files the record already holds are only counted: never a row to decide on.
    func testEverythingKnownIsCountedNeverShown() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Known page \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var drive = try Drive()
        let store = try RecordStore(folder: folder, engine: drive.engine, deviceId: "test")
        let bytes = Data("%PDF synthetic".utf8)
        let original = LabFileReader.Original(bytes, mimeType: "application/pdf")
        let choice = DocumentChoice(kind: .document, sourceFileName: "Letter.pdf", title: "Letter", documentDate: nil, mimeType: "application/pdf", contentHash: original.contentHash)
        _ = await store.saveDocument(extractionJSON: Self.letter(), choice: choice, original: original)
        drive.record = store.recordJSON
        drive.pick(["k"])
        drive.step(["type": "hashed", "run": drive.run, "id": "k", "hash": original.contentHash])
        let page = try drive.page()
        XCTAssertEqual(page.summary, "Everything here is already in your record.")
        XCTAssertEqual(page.sections, [])
        XCTAssertNil(page.documents)
        XCTAssertEqual(page.files.rows.map(\.status), ["Already in your record"])
        XCTAssertFalse(page.save.enabled)
    }

    func testAFailedSaveSaysWhyAndOffersSaveAgain() throws {
        var drive = try Drive()
        drive.pick(["letter"])
        drive.read("letter", Self.letter())
        drive.step(UploadAction.save.event(now: Self.now))
        drive.step(["type": "saveFailed", "run": drive.run, "attempt": 1, "message": "Not saved."])
        let page = try drive.page()
        XCTAssertEqual(page.save.error, "Not saved.")
        XCTAssertTrue(page.save.enabled)
        XCTAssertNil(page.done)
    }

    func testTheDoneScreenSaysWhatWasSavedAndWhatWasNotStored() throws {
        var drive = try Drive()
        drive.pick(["letter"])
        drive.read("letter", Self.letter())
        drive.step(UploadAction.save.event(now: Self.now))
        drive.step(UploadSession.event(.success(.init(values: 0, documents: 1, archived: 0, unstored: 1)), run: drive.run, attempt: 1))
        let page = try drive.page()
        XCTAssertEqual(page.done?.line, "Saved 1 document.")
        XCTAssertNil(page.done?.archived)
        XCTAssertEqual(page.done?.unstored, "The original file couldn't be stored; its details are saved.")
        XCTAssertFalse(page.save.enabled)
    }

    /// A value whose day the record holds offers Replace in the web's word; a question is the read's
    /// own words; the consent and saving phases are the engine's (the page holds no mode).
    func testReplaceQuestionAndPhases() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Replace page \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var drive = try Drive()
        let store = try RecordStore(folder: folder, engine: drive.engine, deviceId: "test")
        _ = await store.apply(.add(metric: "ldl", value: 2.0, day: "2026-10-01"))
        drive.record = store.recordJSON
        drive.pick(["lab"])
        let asked = #"{"metric":"hdl","valueSI":1.2,"displayValue":1.2,"displayUnit":"mmol/L","displaySystem":"si","confidence":"medium","question":"Was this fasting?"}"#
        drive.read("lab", Self.lab(values: "\(Self.ldl),\(asked)"))
        var page = try drive.page()
        let rows = Self.unsure(page)
        let ldl = try XCTUnwrap(rows.first { $0.ref == "v0" })
        XCTAssertEqual(ldl.replace, "Replace")
        XCTAssertEqual([ldl.value, ldl.held], ["3.1", "2 mmol/L"], "both numbers, the held one as stored")
        XCTAssertEqual(ldl.dayLine, "1 Oct 2026")
        let held = try XCTUnwrap(ldl.replaces)
        XCTAssertEqual(rows.first { $0.ref == "v1" }?.question, "Was this fasting?")
        drive.step(UploadAction.replace(fileId: "lab", ref: "v0", correctsId: held).event(now: Self.now))
        page = try drive.page()
        let replaced = Self.unsure(page).first { $0.ref == "v0" }
        XCTAssertEqual(replaced?.replacing, true)
        XCTAssertEqual(replaced?.conflict, "Replaces the value in your record.")

        var consent = try Drive()
        consent.step(["type": "picked", "needsConsent": true, "now": Self.now, "files": [["id": "a", "name": "a.png", "bytes": 100, "kind": "file"]]])
        XCTAssertEqual(try consent.page().phase, "consent")
        consent.step(["type": "consented"])
        XCTAssertEqual(try consent.page().phase, "open")

        var saving = try Drive()
        saving.pick(["letter"])
        saving.read("letter", Self.letter())
        saving.step(UploadAction.save.event(now: Self.now))
        XCTAssertEqual(try saving.page().closeEnabled, false, "Close waits while the save runs")
    }

    /// Codex pass on d31f5855a, item 2: a conflicting out-of-range value whose Replace is off is never
    /// written, so it does not block Save; with Replace on it blocks, in the existing words.
    func testAKeptConflictOutOfRangeDoesNotBlockSave() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Kept conflict \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var drive = try Drive()
        let store = try RecordStore(folder: folder, engine: drive.engine, deviceId: "test")
        _ = await store.apply(.add(metric: "ldl", value: 2.0, day: "2026-10-01"))
        drive.record = store.recordJSON
        drive.pick(["lab", "letter"])
        let huge = #"{"metric":"ldl","valueSI":500,"displayValue":500,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}"#
        let hdl = #"{"metric":"hdl","valueSI":1.2,"displayValue":1.2,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}"#
        drive.read("lab", Self.lab(values: "\(huge),\(hdl)"))
        drive.read("letter", Self.letter())
        var page = try drive.page()
        XCTAssertTrue(page.save.enabled, "a kept conflict is never written, so it blocks nothing")
        let ldl = try XCTUnwrap(Self.unsure(page).first { $0.ref == "v0" })
        drive.step(UploadAction.replace(fileId: "lab", ref: "v0", correctsId: ldl.replaces).event(now: Self.now))
        page = try drive.page()
        XCTAssertFalse(page.save.enabled)
        XCTAssertEqual(page.save.why, "Correct or clear the values with errors before saving.")
    }

    /// Codex pass on d31f5855a, item 4: the done screen keeps naming what was not saved.
    func testTheDoneScreenNamesWhatWasNotSaved() throws {
        var drive = try Drive()
        drive.pick(["lab"])
        let report = #"{"classification":"lab_report","reportDate":"2026-10-01","values":[\#(Self.ldl)],"additionalValues":[],"unreadValues":[{"name":"Ferritin","reason":"unreadable"}],"document":null}"#
        drive.read("lab", report)
        drive.step(UploadAction.save.event(now: Self.now))
        drive.step(UploadSession.event(.success(.init(values: 1, documents: 1, archived: 0, unstored: nil)), run: drive.run, attempt: 1))
        let page = try drive.page()
        XCTAssertEqual(page.done?.line, "Saved 1 value and 1 document.")
        guard case .notSaved(_, let lines, _) = page.sections.first(where: { if case .notSaved = $0 { true } else { false } }) else { return XCTFail("nothing named") }
        XCTAssertTrue(lines.contains { $0.contains("Ferritin") && $0.contains("could not be read") }, "\(lines)")
    }

    // MARK: The list says what Save writes (owner rulings 2026-11-20, upload-view.gaps.test.ts)

    /// A copy of another reading of the same test and day carries no Replace and says so; Replace
    /// lives on the first. A value the record already holds, equal, is counted.
    func testACopyHasNoReplaceAndHeldValuesAreCounted() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Copy page \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        var drive = try Drive()
        let store = try RecordStore(folder: folder, engine: drive.engine, deviceId: "test")
        _ = await store.apply(.add(metric: "ldl", value: 2.0, day: "2026-10-01"))
        _ = await store.apply(.add(metric: "hdl", value: 1.2, day: "2026-10-01"))
        drive.record = store.recordJSON
        drive.pick(["first", "second"])
        let hdl = #"{"metric":"hdl","valueSI":1.2,"displayValue":1.2,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}"#
        drive.read("first", Self.lab(values: "\(Self.ldl),\(hdl)"))
        drive.read("second", Self.lab(values: Self.ldl))
        let page = try drive.page()
        let rows = Self.unsure(page)
        let first = try XCTUnwrap(rows.first { $0.fileId == "first" && $0.ref == "v0" })
        let copy = try XCTUnwrap(rows.first { $0.fileId == "second" })
        XCTAssertEqual(first.replace, "Replace")
        XCTAssertNil(first.copy)
        XCTAssertNil(copy.replace)
        XCTAssertNil(copy.replaces)
        XCTAssertEqual(copy.copy, "another reading of this test is on the same day")
        XCTAssertEqual(page.alreadySaved, "1 already in your record", "the held HDL, equal")
    }

    /// Save carries what the page would write (the engine adds it), and the done screen names a
    /// reviewed value another writer beat to its slot, in the web's words.
    func testTheDoneScreenNamesSkippedValues() throws {
        var drive = try Drive()
        drive.pick(["lab"])
        drive.read("lab", Self.lab(values: Self.ldl))
        drive.step(UploadAction.save.event(now: Self.now))
        let state = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(drive.state.utf8)) as? [String: Any])
        XCTAssertEqual((state["reviewed"] as? [[String: Any]])?.map { $0["ref"] as? String }, ["v0"])
        drive.step(UploadSession.event(.success(.init(values: 0, documents: 0, archived: 0, unstored: nil, skippedValues: 1)), run: drive.run, attempt: 1))
        let page = try drive.page()
        XCTAssertEqual(page.done?.line, "Saved 0 values.")
        XCTAssertEqual(page.done?.skipped, ["1 blood test value was not added. Check your blood test table: a value was already recorded for that date, or changed during review."])
    }

    /// A value the commit refused (the record changed meanwhile) reaches the done screen through the
    /// saved event, named in the web's words.
    func testTheDoneScreenNamesValuesRefusedAtTheCommit() throws {
        var drive = try Drive()
        drive.pick(["lab"])
        drive.read("lab", Self.lab(values: Self.ldl))
        drive.step(UploadAction.save.event(now: Self.now))
        let line = "Blood pressure not saved: the top number (systolic) must be higher than the bottom number (diastolic). Check the report, then enter it again."
        drive.step(UploadSession.event(.success(.init(values: 0, documents: 0, archived: 0, unstored: nil, refused: [["line": line], ["label": "Ferritin", "reason": "unit"]])), run: drive.run, attempt: 1))
        let page = try drive.page()
        XCTAssertEqual(page.done?.notSaved, ["Ferritin: this unit is not one we know for this test", line])
    }

    // MARK: Actions

    /// Each tap is the engine's event, by its own schema (upload-schema.ts).
    func testEachActionIsTheEnginesEvent() throws {
        func object(_ action: UploadAction) -> NSDictionary {
            try! JSONSerialization.jsonObject(with: Data(action.event(now: Self.now).utf8)) as! NSDictionary
        }
        let table: [(UploadAction, NSDictionary)] = [
            (.tick(fileId: "f", ref: "v1", on: true), ["type": "chose", "id": "f", "change": ["tick": "v1", "on": true], "now": Self.now]),
            (.testDay(fileId: "f", day: "2026-10-02"), ["type": "chose", "id": "f", "change": ["testDay": "2026-10-02"], "now": Self.now]),
            (.title(fileId: "f", title: "Heart clinic"), ["type": "chose", "id": "f", "change": ["document": ["title": "Heart clinic"]], "now": Self.now]),
            (.documentDate(fileId: "f", day: "2026-09-01"), ["type": "chose", "id": "f", "change": ["document": ["date": "2026-09-01"]], "now": Self.now]),
            (.documentDate(fileId: "f", day: nil), ["type": "chose", "id": "f", "change": ["document": ["date": NSNull()]], "now": Self.now]),
            (.kind(fileId: "f", key: "scan_result"), ["type": "chose", "id": "f", "change": ["document": ["kind": "scan_result"]], "now": Self.now]),
            (.replace(fileId: "f", ref: "v0", correctsId: "m1"), ["type": "chose", "id": "f", "change": ["replace": "v0", "correctsId": "m1"], "now": Self.now]),
            (.replace(fileId: "f", ref: "v0", correctsId: nil), ["type": "chose", "id": "f", "change": ["replace": "v0", "correctsId": NSNull()], "now": Self.now]),
            (.retryAll, ["type": "retry", "id": "all"]), (.stop, ["type": "stop"]), (.save, ["type": "saveStarted"]),
            (.close, ["type": "close"]), (.discard, ["type": "discard"]),
        ]
        for (action, expected) in table { XCTAssertEqual(object(action), expected, "\(action)") }
    }

    /// The taps move the engine's state as the page expects: a tick, a title, a date, Try again, Stop.
    func testTapsMoveTheEnginesState() throws {
        var drive = try Drive()
        drive.pick(["lab", "letter", "busy", "slow"])
        drive.read("lab", Self.lab(values: "\(Self.ldl),\(Self.unsureHdl)"))
        drive.read("letter", Self.letter())
        drive.sending("busy")
        drive.step(["type": "sendFailed", "run": drive.run, "id": "busy", "status": 503, "body": "{}", "contentType": "application/json"])
        drive.step(UploadAction.tick(fileId: "lab", ref: "v1", on: true).event(now: Self.now))
        drive.step(UploadAction.title(fileId: "letter", title: "Heart clinic").event(now: Self.now))
        drive.step(UploadAction.documentDate(fileId: "letter", day: "2026-09-01").event(now: Self.now))
        var page = try drive.page()
        XCTAssertEqual(page.save.label, "Save 2 values and 1 document", "the ticked unsure value now saves")
        XCTAssertEqual(page.documents?.rows.first?.title, "Heart clinic")
        XCTAssertEqual(page.documents?.rows.first?.date, "1 Sep 2026")
        drive.step(UploadAction.retryAll.event(now: Self.now))
        page = try drive.page()
        XCTAssertFalse(page.sections.contains { if case .failed = $0 { true } else { false } }, "Try again sends the failed file again")
        XCTAssertEqual(page.stop, .init(label: "Stop"))
        drive.step(UploadAction.stop.event(now: Self.now))
        page = try drive.page()
        XCTAssertNil(page.stop)
        XCTAssertEqual(Set(page.files.rows.filter { ["busy", "slow"].contains($0.fileId) }.map(\.status)), ["Not read: you stopped the upload."])
    }
}
