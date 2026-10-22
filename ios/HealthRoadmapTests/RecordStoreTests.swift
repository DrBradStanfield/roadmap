import XCTest
@testable import HealthRoadmap

/// US-25 AC4: the record lives in one file on the phone. A write reaches the
/// disk before the screen shows it, a refused write changes nothing, and a
/// record the app cannot read is never overwritten.
@MainActor
final class RecordStoreTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        // A space in the name, as in "Application Support", where the app keeps the record:
        // a percent-encoded path once made the app miss its own file and start a new one.
        folder = FileManager.default.temporaryDirectory.appending(path: "Record Store \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        UnitChoices().save()
    }

    private var file: URL { folder.appending(path: "health-roadmap.json") }

    private func store() throws -> RecordStore {
        try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "test")
    }

    func testFirstLaunchWritesAnEmptyRecord() throws {
        let store = try store()
        let onDisk = try String(contentsOf: file, encoding: .utf8)
        XCTAssertEqual(onDisk, store.recordJSON)
        XCTAssertTrue(onDisk.contains("\"measurements\":[]"))
        XCTAssertNotNil(store.myData)
        // Staged beside the record, then moved: nothing else is left behind.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false)), ["health-roadmap.json"])
    }

    func testAnAddedValueIsOnDiskAndSurvivesARelaunch() throws {
        let first = try store()
        XCTAssertEqual(first.apply(.add(metric: "weight", value: 80, day: "2026-10-20")), .saved)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), first.recordJSON)

        let relaunched = try store()
        XCTAssertEqual(relaunched.myData?.vitals.first?.latest?.day, "2026-10-20")
    }

    func testARefusedEditLeavesTheFileUntouched() throws {
        let store = try store()
        let before = try Data(contentsOf: file)
        guard case .refused(let message, _) = store.apply(.add(metric: "systolic_bp", value: 400, day: "2026-10-20")) else {
            return XCTFail("a systolic of 400 must be refused")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertEqual(try Data(contentsOf: file), before)
    }

    func testAHeldDayNamesItsRowSoTheAppCanAskBeforeCorrecting() throws {
        let store = try store()
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")), .saved)
        guard case .refused(_, let existingId?) = store.apply(.add(metric: "weight", value: 82, day: "2026-10-20")) else {
            return XCTFail("a second weight for the day must name the row that holds it")
        }
        XCTAssertEqual(store.apply(.correct(id: existingId, value: 82)), .saved)
        XCTAssertEqual(store.myData?.vitals.first?.latest?.value, "82.0")
    }

    /// A value page asks for its history on every redraw; the answer is cached per
    /// record, so a correction must show at once (US-25 AC9, the cache in RecordStore).
    func testTheValueHistoryFollowsACorrection() throws {
        let store = try store()
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")), .saved)
        let first = try XCTUnwrap(store.history(for: "weight"))
        XCTAssertEqual(first.rows.map(\.value), ["80.0"])
        XCTAssertEqual(store.history(for: "weight"), first, "asked again: the same answer")
        let id = try XCTUnwrap(first.rows.first?.id)
        XCTAssertEqual(store.apply(.correct(id: id, value: 82)), .saved)
        let after = try XCTUnwrap(store.history(for: "weight"))
        XCTAssertEqual(after.rows.first { $0.status == "active" }?.value, "82.0", "the correction shows, not the cached history")
        XCTAssertEqual(after.rows.count, 2)
        XCTAssertNotNil(store.history(for: "waist"), "another metric is asked for afresh")
    }

    func testThePlanFollowsTheStoredRecord() throws {
        let store = try store()
        let engine = try HealthEngine()
        XCTAssertThrowsError(try engine.plan(recordJSON: store.recordJSON, now: .now, deviceId: "test"), "an empty record has no height or sex")

        XCTAssertEqual(store.apply(.profile(sex: "male", birthYear: 1975, birthMonth: 6, height: 178)), .saved)
        XCTAssertEqual(store.apply(.add(metric: "systolic_bp", value: 150, day: "2026-10-20")), .saved)
        XCTAssertEqual(store.apply(.add(metric: "diastolic_bp", value: 95, day: "2026-10-20")), .saved)
        let sections = try engine.sections(planJSON: engine.plan(recordJSON: store.recordJSON, now: .now, deviceId: "test"))
        let ids = sections.flatMap(\.cards).flatMap(\.suggestions).map(\.id)
        XCTAssertTrue(ids.contains { $0.hasPrefix("bp-") }, "a 150/95 reading must reach the plan: \(ids)")
    }

    func testTheRecordIsKeptOutOfBackups() throws {
        // Brad 2026-10-21: the record is left out of backups. The mark is on the folder,
        // because every save replaces the file; so the file must sit in that folder.
        let store = try RecordStore(folder: RecordStore.appFolder(in: folder), engine: HealthEngine(), deviceId: "test")
        var holder = store.file.deletingLastPathComponent()
        holder.removeAllCachedResourceValues()
        XCTAssertEqual(try holder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testTheDeviceIdIsKeptOutOfBackupsWithTheRecord() throws {
        // D5: a phone restored from a backup must not reuse the old phone's id, or two
        // phones would write one cloud record as the same device. The id lives in the
        // record's folder, which backups leave out, so a restore starts with a new one.
        let marked = try RecordStore.appFolder(in: folder)
        let id = try RecordStore.deviceId(in: marked)
        XCTAssertTrue(id.hasPrefix("ios-"))
        XCTAssertEqual(try RecordStore.deviceId(in: marked), id, "the same install keeps its id")

        let restored = try RecordStore.appFolder(in: folder.appending(path: "Restored phone"))
        XCTAssertNotEqual(try RecordStore.deviceId(in: restored), id, "a folder without the id is a new device")
    }

    func testJSONThatIsNotARecordIsNeverOverwritten() throws {
        // Adversary R4: the engine's migration turned `null` into an empty record.
        try Data("null".utf8).write(to: file)
        let store = try store()
        XCTAssertNotNil(store.problem)
        if case .saved = store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) {
            XCTFail("an edit must not write over a file that is not a record")
        }
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "null")
    }

    func testAnUnreadableRecordIsNeverOverwritten() throws {
        try Data("not a record".utf8).write(to: file)
        let store = try store()
        XCTAssertNil(store.myData)
        XCTAssertNotNil(store.problem)
        if case .saved = store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) {
            XCTFail("an edit must not write over a record the app cannot read")
        }
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "not a record")
    }

    // MARK: Per-test units (US-25 AC17e)

    /// The record's units, and the other ones: the choice a test is switched to.
    private func otherUnits(_ store: RecordStore) -> (record: String, other: String) {
        let record = store.myData?.unitSystem ?? "si"
        return (record, record == "si" ? "conventional" : "si")
    }

    private func storedWeight(_ store: RecordStore) throws -> Double {
        let record = try JSONSerialization.jsonObject(with: Data(store.recordJSON.utf8)) as? [String: Any]
        let rows = record?["measurements"] as? [[String: Any]] ?? []
        return try XCTUnwrap(rows.last { $0["metricType"] as? String == "weight" && $0["status"] as? String == "active" }?["value"] as? Double)
    }

    func testAValueIsReadInTheUnitsTheSheetShowedWhenItOpened() throws {
        let store = try store()
        let (_, other) = otherUnits(store)
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        store.switchUnits(for: weight, to: other)
        XCTAssertEqual(store.units(for: "weight"), other)
        store.pinScreen()
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")), .saved)
        store.unpinScreen()
        // 80 typed in the weight's own units: 80 kg, or 80 lb (36.3 kg).
        XCTAssertEqual(try storedWeight(store), other == "si" ? 80 : 36.287, accuracy: 0.01)
    }

    func testTheMasterSwitchClearsEveryChoice() throws {
        let store = try store()
        let (record, other) = otherUnits(store)
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        store.switchUnits(for: weight, to: other)
        XCTAssertFalse(store.unitChoices.isEmpty)
        XCTAssertEqual(store.apply(.units(other)), .saved)
        XCTAssertTrue(store.unitChoices.isEmpty)
        XCTAssertEqual(store.units(for: "weight"), other)
        _ = record
    }

    func testSwitchingBackToTheRecordsUnitsDropsTheChoice() throws {
        let store = try store()
        let (record, other) = otherUnits(store)
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        store.switchUnits(for: weight, to: other)
        store.switchUnits(for: weight, to: record)
        XCTAssertTrue(store.unitChoices.isEmpty)
    }

    /// Codex R1: a master switch that cannot be saved keeps the choices with the record
    /// they belong to, so labels and reading still agree.
    func testAFailedMasterSwitchKeepsEveryChoice() throws {
        let store = try store()
        let (record, other) = otherUnits(store)
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        store.switchUnits(for: weight, to: other)
        // A folder where the record file was: the write fails.
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        guard case .refused = store.apply(.units(other)) else { return XCTFail("the switch was saved") }
        XCTAssertEqual(store.myData?.unitSystem, record)
        XCTAssertEqual(store.units(for: "weight"), other)
        XCTAssertFalse(store.unitChoices.isEmpty)
    }

    func testAnEraseClearsEveryChoice() throws {
        let store = try store()
        let (_, other) = otherUnits(store)
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        store.switchUnits(for: weight, to: other)
        try store.showErased(HealthEngine().newRecord(now: .now, deviceId: "test"))
        XCTAssertTrue(store.unitChoices.isEmpty)
    }

    /// US-52 AC13d: with no cloud, a letter is a text-only row, as the web saves one
    /// off-cloud: no original, no hash, its text kept. On disk before the screen.
    func testALetterOnThePhoneAloneIsATextOnlyRow() async throws {
        let store = try store()
        let letter = ##"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Cardiology follow-up","documentDate":null,"contentMarkdown":"# Letter","metadata":{}}}"##
        let original = LabFileReader.Original(Data("%PDF".utf8), mimeType: "application/pdf")
        let choice = DocumentChoice(kind: .document, sourceFileName: "Letter.pdf", title: "Cardiology follow-up", documentDate: nil, mimeType: "application/pdf", contentHash: original.contentHash)
        let result = await store.saveDocument(extractionJSON: letter, choice: choice, original: original)
        XCTAssertEqual(result, .saved(count: 1, stored: nil, unstored: 0, stale: false))
        let onDisk = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        let row = try XCTUnwrap((onDisk?["documents"] as? [[String: Any]])?.first)
        XCTAssertEqual(row["fileRef"] as? String, "")
        XCTAssertEqual(row["contentHash"] as? String, "")
        XCTAssertEqual(row["mimeType"] as? String, "")
        XCTAssertEqual(row["extractedText"] as? String, "# Letter")
        XCTAssertTrue(row["date"] is NSNull)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), store.recordJSON)
        // The review of the same file now says it is already saved (the web's sourceFileName dedup).
        let engine = try HealthEngine()
        XCTAssertEqual(try engine.labReview(extractionJSON: letter, now: .now, recordJSON: store.recordJSON, sourceFileName: "Letter.pdf", deviceId: "test").document?.alreadySaved, true)
    }

    /// US-52 AC13d (R5): a document save's record lands on the phone's file only over the
    /// record the save began from; an edit made while it ran is never written over.
    func testADocumentSaveNeverWritesOverAnEditMadeWhileItRan() throws {
        let store = try store()
        let before = store.recordJSON
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")), .saved)
        let edited = store.recordJSON
        // A save that began on `before` answers a record without the edit: refused.
        XCTAssertFalse(try store.commitPhoneDocument(before, over: before))
        XCTAssertEqual(store.recordJSON, edited)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), edited)
        XCTAssertTrue(try store.commitPhoneDocument(edited, over: edited))
    }
}
