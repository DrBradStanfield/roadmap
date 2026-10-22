import XCTest
@testable import HealthRoadmap

/// US-25 AC4 and AC11, with the engine off the main thread (ios/architecture.md D2,
/// stage 2): record changes land one at a time in the order they were asked for, an
/// edit is checked against the screen captured when it was asked for, and a cloud
/// record handed over during an edit lands after it.
@MainActor
final class RecordPipelineTests: XCTestCase {
    private var folder: URL!
    private var engine: HealthEngine!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Record Pipeline \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        engine = try HealthEngine()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        UnitChoices().save()
    }

    private var file: URL { folder.appending(path: "health-roadmap.json") }

    private func store() throws -> RecordStore {
        try RecordStore(folder: folder, engine: engine, deviceId: "test")
    }

    /// Holds the engine's queue for a moment, so every change asked for meanwhile waits.
    private func stallEngine(_ seconds: Double = 0.3) {
        engine.queue.async { Thread.sleep(forTimeInterval: seconds) }
    }

    private func weights(_ record: String) -> [(day: String, value: Double, status: String)] {
        let object = (try? JSONSerialization.jsonObject(with: Data(record.utf8))) as? [String: Any]
        return ((object?["measurements"] as? [[String: Any]]) ?? []).compactMap { row in
            guard row["metricType"] as? String == "weight", let value = row["value"] as? Double,
                  let day = row["recordedAt"] as? String, let status = row["status"] as? String else { return nil }
            return (String(day.prefix(10)), value, status)
        }
    }

    func testTwoAppliesStartedBackToBackLandInOrder() async throws {
        let store = try store()
        // Values are typed in the record's units and stored in kilograms.
        let kg = store.myData?.unitSystem == "conventional" ? 0.45359237 : 1
        stallEngine()
        // Same day twice: the first is saved, the second finds the day taken.
        let first = Task { await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) }
        let second = Task { await store.apply(.add(metric: "weight", value: 82, day: "2026-10-20")) }
        // Two days: both kept, neither written over the other.
        let third = Task { await store.apply(.add(metric: "weight", value: 81, day: "2026-10-21")) }
        let fourth = Task { await store.apply(.add(metric: "weight", value: 83, day: "2026-10-22")) }

        let firstResult = await first.value
        let secondResult = await second.value
        let thirdResult = await third.value
        let fourthResult = await fourth.value
        XCTAssertEqual(firstResult, .saved)
        guard case .refused(_, let existingId?) = secondResult else { return XCTFail("the second edit did not see the first: \(secondResult)") }
        XCTAssertEqual(thirdResult, .saved)
        XCTAssertEqual(fourthResult, .saved)

        let onDisk = try String(contentsOf: file, encoding: .utf8)
        XCTAssertEqual(onDisk, store.recordJSON, "the screen shows what is on disk")
        let rows = weights(onDisk)
        XCTAssertEqual(rows.map(\.day), ["2026-10-20", "2026-10-21", "2026-10-22"], "in the order asked, none lost")
        for (stored, typed) in zip(rows.map(\.value), [80.0, 81, 83]) { XCTAssertEqual(stored, typed * kg, accuracy: 0.01) }
        XCTAssertEqual(rows.map(\.status), ["active", "active", "active"])
        XCTAssertNotNil(existingId)
    }

    func testASheetThatUnpinsMidSaveStillSavesWithItsCapturedScreen() async throws {
        let store = try store()
        let recordUnits = store.myData?.unitSystem ?? "si"
        let other = recordUnits == "si" ? "conventional" : "si"
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        // The sheet opens showing weight in the record's units...
        store.pinScreen()
        // ...and weight's own units change behind it.
        await store.switchUnits(for: weight, to: other).value
        XCTAssertEqual(store.units(for: "weight"), other)

        stallEngine()
        // Something is already waiting, so the save's own job starts only after the unpin.
        let before = Task { await store.apply(.profile(sex: "male")) }
        let save = Task { await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) }
        await Task.yield()
        store.unpinScreen()
        let beforeResult = await before.value
        let saveResult = await save.value
        XCTAssertEqual(beforeResult, .saved)
        XCTAssertEqual(saveResult, .saved)
        // 80 in the units the sheet showed: 80 kg on a metric record, 80 lb (36.3 kg) on a US one.
        let stored = try XCTUnwrap(weights(store.recordJSON).last?.value)
        XCTAssertEqual(stored, recordUnits == "si" ? 80 : 36.287, accuracy: 0.01)
    }

    func testAShowCloudArrivingDuringAnEditLandsAfterIt() async throws {
        let store = try store()
        let cloudRecord = try engine.blocking { engine -> String in
            let empty = try engine.newRecord(now: .now, deviceId: "web")
            return try XCTUnwrap(engine.apply(.add(metric: "weight", value: 70, day: "2026-10-01"), to: empty, now: .now, deviceId: "web").record)
        }
        stallEngine()
        let edit = Task { await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) }
        await Task.yield()
        let shown = store.showCloud(HealthEngine.CloudView(record: cloudRecord, erase: "e1", session: 1))
        let result = await edit.value
        await shown.value
        XCTAssertEqual(result, .saved, "the edit was asked for on the phone's file and lands there")
        XCTAssertEqual(weights(try String(contentsOf: file, encoding: .utf8)).map(\.day), ["2026-10-20"])
        XCTAssertEqual(store.cloudErase, "e1", "then the cloud record is shown")
        XCTAssertEqual(store.recordJSON, cloudRecord)
    }

    /// The erase guard holds across the wait: an edit asked for on the phone's screen,
    /// whose turn comes after a cloud record landed, is refused, never sent to the cloud.
    func testAnEditAskedForBeforeTheCloudLandedIsRefusedAfterIt() async throws {
        let store = try store()
        let cloudRecord = try engine.blocking { try $0.newRecord(now: .now, deviceId: "web") }
        stallEngine()
        let edit = Task { await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) }
        await Task.yield()
        let shown = store.showCloud(HealthEngine.CloudView(record: cloudRecord, erase: "e1", session: 1))
        let late = Task { await store.apply(.add(metric: "weight", value: 81, day: "2026-10-21")) }
        let result = await edit.value
        XCTAssertEqual(result, .saved)
        await shown.value
        guard case .refused = await late.value else { return XCTFail("an edit asked for on the phone's screen reached the cloud record") }
    }

    /// An import (applyNow) reads the screen when its turn comes, not when it was asked
    /// for: queued behind a cloud record, it is checked against that record and never
    /// refused by the erase guard. A sheet's edit, captured early, still is.
    func testAnImportQueuedBehindACloudRecordIsCheckedAgainstIt() async throws {
        let store = try store()
        let cloudRecord = try engine.blocking { try $0.newRecord(now: .now, deviceId: "web") }
        stallEngine()
        let shown = store.showCloud(HealthEngine.CloudView(record: cloudRecord, erase: "e1", session: 1))
        let sheet = Task { await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) }
        let import_ = Task { await store.applyNow(.add(metric: "weight", value: 80, day: "2026-10-20")) }
        await shown.value
        let guardWords = "Your record changed while this was open"
        guard case .refused(let sheetWords, _) = await sheet.value else { return XCTFail("the sheet's edit was saved") }
        XCTAssertTrue(sheetWords.hasPrefix(guardWords), "a sheet's edit is checked against the screen it was asked on")
        // No session is open in this test, so the engine's session refuses it, in its own words:
        // the import reached the cloud path, past the erase guard.
        guard case .refused(let importWords, _) = await import_.value else { return XCTFail("no session, yet saved") }
        XCTAssertFalse(importWords.hasPrefix(guardWords), "the import was checked against the record as it is now")
    }

    /// US-25 AC17e: a value typed while the record's units changed behind the sheet is
    /// refused on the phone, as the cloud session refuses it, and nothing is stored.
    func testASheetSaveCapturedBeforeAUnitsSwitchIsRefused() async throws {
        let store = try store()
        let other = store.myData?.unitSystem == "si" ? "conventional" : "si"
        store.pinScreen()
        stallEngine()
        let switched = Task { await store.applyNow(.units(other)) }
        let sheet = Task { await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) }
        let switchResult = await switched.value
        XCTAssertEqual(switchResult, .saved)
        guard case .refused(let words, _) = await sheet.value else { return XCTFail("a value typed in the old units was saved") }
        XCTAssertTrue(words.hasPrefix("Your units changed while this was open"))
        XCTAssertEqual(weights(try String(contentsOf: file, encoding: .utf8)).count, 0, "nothing stored")
        store.unpinScreen()
    }

    func testAnOlderCloudRecordNeverReplacesANewerOne() async throws {
        let store = try store()
        let older = try engine.blocking { try $0.newRecord(now: .now, deviceId: "web") }
        let newer = try engine.blocking { engine -> String in
            try XCTUnwrap(engine.apply(.add(metric: "weight", value: 70, day: "2026-10-01"), to: older, now: .now, deviceId: "web").record)
        }
        store.showCloud(HealthEngine.CloudView(record: newer, erase: "e1", session: 1, order: 5))
        await store.showCloud(HealthEngine.CloudView(record: older, erase: "e1", session: 1, order: 3)).value
        XCTAssertEqual(store.recordJSON, newer, "news of a re-read made before an edit never hides the edit")
    }
}
