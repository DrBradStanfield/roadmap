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

    func testAnAddedValueIsOnDiskAndSurvivesARelaunch() async throws {
        let first = try store()
        await XCTAssertSaved(await first.apply(.add(metric: "weight", value: 80, day: "2026-10-20")))
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), first.recordJSON)

        let relaunched = try store()
        XCTAssertEqual(relaunched.myData?.vitals.first?.latest?.day, "2026-10-20")
    }

    func testARefusedEditLeavesTheFileUntouched() async throws {
        let store = try store()
        let before = try Data(contentsOf: file)
        guard case .refused(let message, _) = await store.apply(.add(metric: "systolic_bp", value: 400, day: "2026-10-20")) else {
            return XCTFail("a systolic of 400 must be refused")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertEqual(try Data(contentsOf: file), before)
    }

    func testAHeldDayNamesItsRowSoTheAppCanAskBeforeCorrecting() async throws {
        let store = try store()
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")))
        guard case .refused(_, let existingId?) = await store.apply(.add(metric: "weight", value: 82, day: "2026-10-20")) else {
            return XCTFail("a second weight for the day must name the row that holds it")
        }
        await XCTAssertSaved(await store.apply(.correct(id: existingId, value: 82)))
        XCTAssertEqual(store.myData?.vitals.first?.latest?.value, "82.0")
    }

    /// A value page asks for its history on every redraw; the answer is cached per
    /// record, so a correction must show at once (US-25 AC9, the cache in RecordStore).
    func testTheValueHistoryFollowsACorrection() async throws {
        let store = try store()
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")))
        let firstHistory = await store.history(for: "weight")
        let first = try XCTUnwrap(firstHistory)
        XCTAssertEqual(first.rows.map(\.value), ["80.0"])
        XCTAssertEqual(store.shownHistory(for: "weight"), first, "kept for the page to draw")
        let again = await store.history(for: "weight")
        XCTAssertEqual(again, first, "asked again: the same answer")
        let id = try XCTUnwrap(first.rows.first?.id)
        await XCTAssertSaved(await store.apply(.correct(id: id, value: 82)))
        let afterHistory = await store.history(for: "weight")
        let after = try XCTUnwrap(afterHistory)
        XCTAssertEqual(after.rows.first { $0.status == "active" }?.value, "82.0", "the correction shows, not the cached history")
        XCTAssertEqual(after.rows.count, 2)
        let waist = await store.history(for: "waist")
        XCTAssertNotNil(waist, "another metric is asked for afresh")
    }

    /// The kept histories are keyed on the record's revision: one from an older revision is
    /// dropped once another metric is read for the new one, and two asks for the same metric
    /// and revision share one engine call's answer.
    func testHistoriesFromOlderRevisionsAreDropped() async throws {
        let store = try store()
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")))
        _ = await store.history(for: "weight")
        XCTAssertNotNil(store.shownChart(for: "weight"))
        await XCTAssertSaved(await store.apply(.add(metric: "waist", value: 90, day: "2026-10-20")))
        XCTAssertNotNil(store.shownChart(for: "weight"), "kept to draw until a newer one lands")
        XCTAssertNil(store.shownHistory(for: "weight"), "but not current")
        async let first = store.history(for: "waist")
        async let second = store.history(for: "waist")
        let (a, b) = await (first, second)
        XCTAssertEqual(a, b)
        XCTAssertNil(store.shownChart(for: "weight"), "the older revision's history was dropped")
        XCTAssertEqual(store.shownChart(for: "waist")?.history, a)
    }

    /// Adversary R2, Codex (US-25 AC9, AC20): a history read for an older record or unit is
    /// never current, and a correction's "Now" hint comes only from a history in the sheet's
    /// own unit. Lp(a) at 100 nmol/L, the unit moves to mg/dL, a tap before the history is
    /// read again: the hint is never "100 mg/dL".
    func testAStaleHistoryNeverGivesACorrectionItsHint() async throws {
        let store = try store()
        await XCTAssertSaved(await store.setLpaUnit("nmol/L").value)
        await XCTAssertSaved(await store.apply(.add(metric: "lpa", value: 100, day: "2026-10-19"), as: store.screen))
        let read = await store.history(for: "lpa")
        let value = try XCTUnwrap(read?.rows.first)
        XCTAssertEqual(read?.unit, "nmol/L")
        XCTAssertEqual(store.correctionHint(for: value.id, metric: "lpa", unit: "nmol/L", on: store.screen), value.value)

        await XCTAssertSaved(await store.setLpaUnit("mg/dL").value)
        XCTAssertNil(store.shownHistory(for: "lpa"), "the old unit's history is not current")
        XCTAssertEqual(store.shownChart(for: "lpa")?.history, read, "still drawn, its taps held")
        let seen = store.screen // the tap, before the page reads the history again
        XCTAssertEqual(seen.lpaUnit, "mg/dL")
        XCTAssertNil(store.correctionHint(for: value.id, metric: "lpa", unit: seen.lpaUnit, on: seen), "no hint rather than 100 mg/dL")

        _ = await store.history(for: "lpa")
        let hint = store.correctionHint(for: value.id, metric: "lpa", unit: seen.lpaUnit, on: seen)
        XCTAssertNotNil(hint, "the fresh history, in mg/dL, gives it")
        XCTAssertNotEqual(hint, value.value)
        // A sheet still on the old unit's screen gets no hint from the mg/dL history either.
        XCTAssertNil(store.correctionHint(for: value.id, metric: "lpa", unit: "nmol/L", on: seen.showing(lpaUnit: "nmol/L")))
    }

    /// Re-check N1 (US-25 AC9, AC20): the hint is in the sheet's own unit for every metric.
    /// An 80 kg weight's correction is open, the record flips units, the history is read
    /// again: no hint, never "176.4 kg".
    func testACorrectionHintIsNeverInAnotherUnit() async throws {
        let store = try store()
        let (_, other) = otherUnits(store)
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-19")))
        let first = await store.history(for: "weight")
        let read = try XCTUnwrap(first)
        let value = try XCTUnwrap(read.rows.first)
        let seen = store.screen // the tap
        XCTAssertEqual(store.correctionHint(for: value.id, metric: "weight", unit: read.unit, on: seen), value.value)

        await XCTAssertSaved(await store.apply(.units(other)))
        let again = await store.history(for: "weight")
        let fresh = try XCTUnwrap(again)
        XCTAssertNotEqual(fresh.unit, read.unit)
        XCTAssertNil(store.correctionHint(for: value.id, metric: "weight", unit: read.unit, on: seen), "no hint in the other unit")
        XCTAssertNotNil(store.correctionHint(for: value.id, metric: "weight", unit: fresh.unit, on: store.screen))
    }

    /// Re-check N2: the revision moves only when the record or the per-test units change,
    /// so a page keyed on it never asks the engine again for nothing.
    func testTheRevisionMovesOnlyOnAChange() async throws {
        let store = try store()
        let before = store.revision
        await store.showPhone().value // the same file, read again
        XCTAssertEqual(store.revision, before, "the same record")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-19")))
        XCTAssertGreaterThan(store.revision, before)
    }

    /// Re-check N4 (US-25 AC9): of two quick row taps only the latest opens anything,
    /// and a tap whose history was still being read when an erase landed opens nothing.
    func testOnlyTheLatestTapOpensAndNoneAfterAnErase() async throws {
        let store = try store()
        let first = store.tap()
        let second = store.tap()
        XCTAssertFalse(store.isLatest(first), "a later tap came")
        XCTAssertTrue(store.isLatest(second))
        guard case .erased = await store.erasePhone(historyJSON: nil, keepChat: { _, _ in true }) else { return XCTFail("not erased") }
        XCTAssertFalse(store.isLatest(second), "an erase came")
        XCTAssertTrue(store.isLatest(store.tap()))
    }

    func testThePlanFollowsTheStoredRecord() async throws {
        let store = try store()
        let engine = try HealthEngine()
        let shown = store.recordJSON
        XCTAssertThrowsError(try engine.blocking { try $0.plan(recordJSON: shown, now: .now, deviceId: "test") }, "an empty record has no height or sex")

        await XCTAssertSaved(await store.apply(.profile(sex: "male", birthYear: 1975, birthMonth: 6, height: 178)))
        await XCTAssertSaved(await store.apply(.add(metric: "systolic_bp", value: 150, day: "2026-10-20")))
        await XCTAssertSaved(await store.apply(.add(metric: "diastolic_bp", value: 95, day: "2026-10-20")))
        let record = store.recordJSON
        let sections = try engine.blocking { try $0.planView(record: record, units: "{}", now: .now, deviceId: "test") }.sections
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

    func testJSONThatIsNotARecordIsNeverOverwritten() async throws {
        // Adversary R4: the engine's migration turned `null` into an empty record.
        try Data("null".utf8).write(to: file)
        let store = try store()
        XCTAssertNotNil(store.problem)
        if case .saved = await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) {
            XCTFail("an edit must not write over a file that is not a record")
        }
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "null")
    }

    func testAnUnreadableRecordIsNeverOverwritten() async throws {
        try Data("not a record".utf8).write(to: file)
        let store = try store()
        XCTAssertNil(store.myData)
        XCTAssertNotNil(store.problem)
        if case .saved = await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) {
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

    func testAValueIsReadInTheUnitsTheSheetShowedWhenItOpened() async throws {
        let store = try store()
        let (_, other) = otherUnits(store)
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        await store.switchUnits(for: weight, to: other).value
        XCTAssertEqual(store.units(for: "weight"), other)
        store.pinScreen()
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")))
        store.unpinScreen()
        // 80 typed in the weight's own units: 80 kg, or 80 lb (36.3 kg).
        XCTAssertEqual(try storedWeight(store), other == "si" ? 80 : 36.287, accuracy: 0.01)
    }

    func testTheMasterSwitchClearsEveryChoice() async throws {
        let store = try store()
        let (record, other) = otherUnits(store)
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        await store.switchUnits(for: weight, to: other).value
        XCTAssertFalse(store.unitChoices.isEmpty)
        await XCTAssertSaved(await store.apply(.units(other)))
        XCTAssertTrue(store.unitChoices.isEmpty)
        XCTAssertEqual(store.units(for: "weight"), other)
        _ = record
    }

    func testSwitchingBackToTheRecordsUnitsDropsTheChoice() async throws {
        let store = try store()
        let (record, other) = otherUnits(store)
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        await store.switchUnits(for: weight, to: other).value
        await store.switchUnits(for: weight, to: record).value
        XCTAssertTrue(store.unitChoices.isEmpty)
    }

    /// Codex R1: a master switch that cannot be saved keeps the choices with the record
    /// they belong to, so labels and reading still agree.
    func testAFailedMasterSwitchKeepsEveryChoice() async throws {
        let store = try store()
        let (record, other) = otherUnits(store)
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        await store.switchUnits(for: weight, to: other).value
        // A folder where the record file was: the write fails.
        try FileManager.default.removeItem(at: file)
        try FileManager.default.createDirectory(at: file, withIntermediateDirectories: false)
        guard case .refused = await store.apply(.units(other)) else { return XCTFail("the switch was saved") }
        XCTAssertEqual(store.myData?.unitSystem, record)
        XCTAssertEqual(store.units(for: "weight"), other)
        XCTAssertFalse(store.unitChoices.isEmpty)
    }

    func testAnEraseClearsEveryChoice() async throws {
        let store = try store()
        let (_, other) = otherUnits(store)
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        await store.switchUnits(for: weight, to: other).value
        let erased = await store.erasePhone(historyJSON: nil) { _, _ in true }
        XCTAssertEqual(erased, .erased(chatErased: true))
        XCTAssertTrue(store.unitChoices.isEmpty)
    }

    /// US-25 AC20: Lp(a)'s menu writes the record's `profile.lpaUnit`, as the web's control
    /// does; the row, its history and a typed value follow it. On disk before the screen.
    func testLpaUnitMenuWritesTheRecordAndATypedValueIsReadInIt() async throws {
        let store = try store()
        await XCTAssertSaved(await store.setLpaUnit("mg/L").value)
        XCTAssertEqual(store.myData?.lpaUnit, "mg/L")
        let onDisk = try JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any]
        let profile = try XCTUnwrap(onDisk?["profile"] as? [String: Any])
        XCTAssertEqual(profile["lpaUnit"] as? String, "mg/L")
        XCTAssertNotNil((profile["fieldStamps"] as? [String: Any])?["lpaUnit"], "field-stamped, so it merges per field")
        XCTAssertEqual(store.myData?.bloodTests.first { $0.metric == "lpa" }?.unit, "mg/L")
        await XCTAssertSaved(await store.apply(.add(metric: "lpa", value: 500, day: "2026-10-20"), as: store.screen))
        let lpaHistory = await store.history(for: "lpa")
        XCTAssertEqual(lpaHistory?.unit, "mg/L")
        XCTAssertEqual(lpaHistory?.rows.first?.value, "500")
        let record = try JSONSerialization.jsonObject(with: Data(store.recordJSON.utf8)) as? [String: Any]
        let lpa = (record?["measurements"] as? [[String: Any]])?.first { $0["metricType"] as? String == "lpa" }
        XCTAssertEqual(try XCTUnwrap(lpa?["value"] as? Double), 125, accuracy: 1e-9, "500 mg/L is 125 nmol/L")
        // Choosing it again writes nothing.
        let before = try Data(contentsOf: file)
        await XCTAssertSaved(await store.setLpaUnit("mg/L").value)
        XCTAssertEqual(try Data(contentsOf: file), before)
    }

    /// US-25 AC20 (review R1): the entry sheet's own picker sets the unit, so a first Lp(a)
    /// value is typed in the lab's unit; the sheet's screen carries it, so the value is
    /// read in the unit shown at Save.
    func testAnLpaUnitChosenInTheOpenSheetReadsItsValue() async throws {
        let store = try store()
        let row = try XCTUnwrap(store.myData?.bloodTests.first { $0.metric == "lpa" })
        var seen = store.screen // the entry sheet opens, showing the default unit
        let sheet = ValueEntrySheet(title: row.label, unit: row.unit, current: nil, asksForDay: true) { _, _ in .saved }
            .lpaUnits(store, row) { seen = seen.showing(lpaUnit: $0) }
        let choose = try XCTUnwrap(sheet.chooseUnit)
        let refusal = await choose("mg/L")
        XCTAssertNil(refusal)
        XCTAssertEqual(seen.lpaUnit, "mg/L")
        await XCTAssertSaved(await store.apply(.add(metric: "lpa", value: 500, day: "2026-10-20"), as: seen))
        let record = try JSONSerialization.jsonObject(with: Data(store.recordJSON.utf8)) as? [String: Any]
        let lpa = (record?["measurements"] as? [[String: Any]])?.first { $0["metricType"] as? String == "lpa" }
        XCTAssertEqual(try XCTUnwrap(lpa?["value"] as? Double), 125, accuracy: 1e-9, "500 mg/L is 125 nmol/L")
    }

    /// US-25 AC21 (merge review R1): Lp(a)'s menu holds entry from the tap itself, before its
    /// task first runs, so a tap queued behind it cannot open a sheet on the old unit.
    func testAnLpaUnitChoiceHoldsEntryFromTheTap() async throws {
        let store = try store()
        let choosing = store.setLpaUnit("mg/L")
        XCTAssertEqual(store.unitSwitches, 1, "held before the task has run")
        await XCTAssertSaved(await choosing.value)
        XCTAssertEqual(store.unitSwitches, 0)
    }

    /// US-25 AC20 (merge review R3): a correction keeps its sheet when Lp(a)'s unit is chosen
    /// in it. The sheet's item gets a new screen, never a new id, so it is not re-presented.
    func testACorrectionKeepsItsSheetWhenItsScreenMoves() async throws {
        let store = try store()
        await XCTAssertSaved(await store.apply(.add(metric: "lpa", value: 100, day: "2026-10-19")))
        let lpaHistory = await store.history(for: "lpa")
        let value = try XCTUnwrap(lpaHistory?.rows.first)
        let row = try XCTUnwrap(store.myData?.bloodTests.first { $0.metric == "lpa" })
        let seen = store.screen
        let before = MetricDetailView.Editing.correct(value, row, seen)
        let after = MetricDetailView.Editing.correct(value, row, seen.showing(lpaUnit: "mg/L"))
        XCTAssertEqual(before.id, after.id)
    }

    /// US-25 AC20: on the phone's file too, an Lp(a) value or correction typed before its unit
    /// changed under the sheet is refused; another test's value saves. A refused choice says why.
    func testAnLpaValueTypedBeforeItsUnitChangedIsRefusedOnThePhone() async throws {
        let store = try store()
        await XCTAssertSaved(await store.apply(.add(metric: "lpa", value: 100, day: "2026-10-19")))
        let lpaHistory = await store.history(for: "lpa")
        let rowId = try XCTUnwrap(lpaHistory?.rows.first?.id)
        let before = try XCTUnwrap(store.myData?.lpaUnit)
        let seen = store.screen // the sheet opens
        // A change the sheet did not make (applyNow, as an import would come in).
        await XCTAssertSaved(await store.applyNow(.lpaUnit(before == "mg/L" ? "nmol/L" : "mg/L")))
        guard case .refused(let message, _) = await store.apply(.add(metric: "lpa", value: 50, day: "2026-10-20"), as: seen) else {
            return XCTFail("a value typed in the old unit must not be read in the new one")
        }
        XCTAssertTrue(message.contains("Close this"), message)
        guard case .refused = await store.apply(.correct(id: rowId, value: 90), as: seen) else { return XCTFail("the correction too") }
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20"), as: seen))
        let refused = await store.chooseLpaUnit("g/L").value
        XCTAssertEqual(refused, "Lp(a) is in nmol/L, mg/dL or mg/L.")
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
        let shown = store.recordJSON
        XCTAssertEqual(try engine.blocking { try $0.labReview(extractionJSON: letter, now: .now, recordJSON: shown, sourceFileName: "Letter.pdf", deviceId: "test") }.document?.alreadySaved, true)
    }

    /// US-52 AC13d (R5): a document save's record lands on the phone's file only over the
    /// record the save began from; an edit made while it ran is never written over.
    func testADocumentSaveNeverWritesOverAnEditMadeWhileItRan() async throws {
        let store = try store()
        let before = store.recordJSON
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-01")))
        let edited = store.recordJSON
        // A save that began on `before` answers a record without the edit: refused.
        let stale = try await store.commitPhoneDocument(before, over: before)
        XCTAssertFalse(stale)
        XCTAssertEqual(store.recordJSON, edited)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), edited)
        let current = try await store.commitPhoneDocument(edited, over: edited)
        XCTAssertTrue(current)
    }
}
