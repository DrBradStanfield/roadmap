import XCTest
@testable import HealthRoadmap

/// US-25 AC16f: once the store takes in an erase, the record it holds is the erased one, even
/// when the engine cannot draw it. Every reader of the store's record or rows then reads the
/// erased record, with no guard of its own. One test per reader, each through the store and
/// the reader's own entry point, or the engine call it makes on the store's record (the chat's).
@MainActor
final class EraseHeldUndrawnTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Erase Held \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        UnitChoices().save()
    }

    /// The bundled engine, whose screen draw fails while `__screenFails` is set, and which counts
    /// the cloud session's edits in `__cloudEdits`.
    private func engine() throws -> HealthEngine {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let source = try String(contentsOf: url, encoding: .utf8) + """

        globalThis.__screenFails = false;
        globalThis.__cloudEdits = 0;
        HealthEngine = Object.assign({}, HealthEngine, { screenJson: (door => function () {
          if (__screenFails) throw new Error('test: the screen draw fails');
          return door.apply(this, arguments);
        })(HealthEngine.screenJson), cloudEdit: (door => function () {
          __cloudEdits += 1;
          return door.apply(this, arguments);
        })(HealthEngine.cloudEdit) });

        """
        return try HealthEngine(source: source, sourceURL: url)
    }

    private struct Erased {
        let store: RecordStore
        let engine: HealthEngine
        /// The erased record the session handed over.
        let record: String
    }

    /// A store holding a profile, a weight and an LDL, then a cloud erase whose draw fails. The
    /// draw works again afterwards, so only the erase's own draw failed. `before` runs on the
    /// filled store, before the erase.
    private func erasedUndrawn(before: (RecordStore, HealthEngine) async throws -> Void = { _, _ in }) async throws -> Erased {
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        await XCTAssertSaved(await store.apply(.profile(sex: "female", birthYear: 1970, birthMonth: 3, height: 165)))
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 87.3, day: "2026-10-20")))
        await XCTAssertSaved(await store.apply(.add(metric: "ldl", value: 2.9, day: "2026-09-10")))
        try await before(store, engine)
        let (filled, deviceId) = (store.recordJSON, store.deviceId)
        let erased = try await engine.eraseOnPhone(recordJSON: filled, historyJSON: nil, now: .now, deviceId: deviceId).record
        XCTAssertNotEqual(erased, filled)
        _ = try engine.blocking { try $0.evaluate("__screenFails = true") }
        let erasures = store.erasures
        XCTAssertFalse(store.heldUndrawn, "a drawn record is not held (S67)")
        await store.showErased(HealthEngine.CloudView(record: erased, erase: "e1", session: 1, order: 1)).value
        _ = try engine.blocking { try $0.evaluate("__screenFails = false") }
        XCTAssertEqual(store.erasures, erasures + 1, "the store took the erase in")
        XCTAssertTrue(store.heldUndrawn, "the erase is held with no drawing (S67)")
        return Erased(store: store, engine: engine, record: erased)
    }

    func testTheChatContextIsTheErasedRecords_US25_AC16f() async throws {
        let now = try Date("2026-11-13T08:00:00.000Z", strategy: .iso8601)
        let erased = try await erasedUndrawn()
        let store = erased.store
        // ChatView's read: the context it sends is built from the store's record.
        let context = try await erased.engine.chatContext(recordJSON: store.recordJSON, now: now, deviceId: store.deviceId)
        let expected = try await erased.engine.chatContext(recordJSON: erased.record, now: now, deviceId: store.deviceId)
        XCTAssertEqual(context, expected, "the chat is told only the erased record")
    }

    func testTheExportIsTheErasedRecord_US25_AC16f() async throws {
        let erased = try await erasedUndrawn()
        // RecordSection's Export: the file it shares.
        XCTAssertEqual(RecordExport(json: erased.store.recordJSON).json, erased.record)
    }

    func testAppleHealthIsWrittenNothingFromBeforeTheErase_US25_AC16f() async throws {
        let erased = try await erasedUndrawn()
        let suite = "EraseHeldUndrawnTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let health = FakeHealthStore()
        let sync = AppleHealthSync(store: erased.store, engine: erased.engine, client: health, memory: HealthSyncMemory(defaults: defaults))
        await sync.connect()
        await sync.refresh()
        // The pass ran to its end: writes were read, from the erased record, and none was due.
        guard case .upToDate = sync.status else { return XCTFail("status \(sync.status)") }
        XCTAssertTrue(health.saved.isEmpty, "no value from the record the erase replaced")
    }

    func testRemindersComeFromTheErasedRecord_US25_AC16f() async throws {
        var scheduler: ReminderScheduler?
        let erased = try await erasedUndrawn { store, engine in
            let made = ReminderScheduler(center: FakeNotificationCenter(), folder: self.folder, erasures: { store.erasures }) { firstSeen in
                try await engine.reminders(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId, firstSeen: firstSeen)
            }
            await made.refresh()
            XCTAssertTrue(made.reminders?.upcoming.contains { $0.category == "blood_test_lipids" } == true, "the LDL's reminder before the erase")
            scheduler = made
        }
        let reminders = try XCTUnwrap(scheduler)
        await reminders.refresh()
        let categories = try XCTUnwrap(reminders.reminders?.upcoming.map(\.category))
        XCTAssertFalse(categories.contains("blood_test_lipids"), "no reminder from the record the erase replaced")
        let expected = try await erased.engine.reminders(recordJSON: erased.record, now: .now, deviceId: erased.store.deviceId)
        XCTAssertEqual(categories, expected.upcoming.map(\.category))
    }

    /// A newer cloud record whose draw failed is never shown, so it never makes the older erase
    /// stale (Codex R1): the erase is held, and the store's record and rows are the erased ones.
    func testANewerRecordThatFailedToDrawNeverMakesTheEraseStale_US25_AC16f() async throws {
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 87.3, day: "2026-10-20")))
        let (filled, deviceId) = (store.recordJSON, store.deviceId)
        let erased = try await engine.eraseOnPhone(recordJSON: filled, historyJSON: nil, now: .now, deviceId: deviceId).record
        _ = try engine.blocking { try $0.evaluate("__screenFails = true") }
        await store.showCloud(HealthEngine.CloudView(record: filled, erase: "e0", session: 1, order: 2)).value
        _ = try engine.blocking { try $0.evaluate("__screenFails = false") }
        XCTAssertEqual(store.recordJSON, filled, "not drawn: nothing moved")
        await store.showErased(HealthEngine.CloudView(record: erased, erase: "e1", session: 1, order: 1)).value
        XCTAssertEqual(store.recordJSON, erased, "the erase is held, not dropped as stale")
        XCTAssertNil(store.myData?.vitals.first { $0.metric == "weight" }?.latest)
        XCTAssertEqual(store.screenErasures, store.erasures)
    }

    /// Codex R1 on the merge: an Apple Health pass cannot see an erase held with no drawing (its gate
    /// reads the drawing), so the held record takes no edit until it is drawn; none reaches the session.
    func testAnEraseHeldUndrawnTakesNoEdit_US25_AC16f() async throws {
        let erased = try await erasedUndrawn()
        let store = erased.store
        let before = try erased.engine.blocking { try $0.evaluate("__cloudEdits").toInt32() }
        let sample = HealthSample(id: UUID(), metric: "weight", value: 70, at: .now, timeZone: .gmt)
        guard case .refused = await store.applyNow(.appleHealth([sample])) else { return XCTFail("an import landed in the held erase") }
        guard case .refused = await store.applyNow(.add(metric: "weight", value: 70, day: "2026-11-13")) else { return XCTFail("an edit landed") }
        XCTAssertEqual(try erased.engine.blocking { try $0.evaluate("__cloudEdits").toInt32() }, before, "nothing reached the session")
        XCTAssertEqual(store.recordJSON, erased.record)
    }

    func testMyDataDrawsNoRowFromBeforeTheErase_US25_AC16f() async throws {
        let erased = try await erasedUndrawn()
        let store = erased.store
        XCTAssertNil(store.myData?.vitals.first { $0.metric == "weight" }?.latest, "no weight row from the record the erase replaced")
        XCTAssertNil(store.myData, "the erased record could not be drawn: My data says it did not load")
        XCTAssertNil(store.plan)
        XCTAssertEqual(store.screenErasures, store.erasures, "the screen no longer shows a record from before the erase")
    }

    /// US-25 AC16g (lead S46): an erase that finished after CloudSync moved on to another session
    /// is counted, but never drawn over the record the store holds now, which is not the one erased.
    func testAnEraseFromASessionNoLongerShownIsCountedAndReplacesNothing_US25_AC16g() async throws {
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 87.3, day: "2026-10-20")))
        let (filled, deviceId) = (store.recordJSON, store.deviceId)
        let erased = try await engine.eraseOnPhone(recordJSON: filled, historyJSON: nil, now: .now, deviceId: deviceId).record
        await store.showCloud(HealthEngine.CloudView(record: filled, erase: "e2", session: 2, order: 1)).value
        let erasures = store.erasures
        await store.showErased(HealthEngine.CloudView(record: erased, erase: "e1", session: 1, order: 2), stillShown: { false }).value
        XCTAssertEqual(store.erasures, erasures + 1, "the erase is counted")
        XCTAssertEqual(store.recordJSON, filled, "session 2's record stays")
        XCTAssertEqual(store.cloudErase, "e2")
        XCTAssertTrue(store.predatesErase, "not proven read after the erase: nothing is charted from it")
    }

    /// US-25 AC16g: the same session, still held by the store, takes the erase even after
    /// CloudSync moved on (a Disconnect whose phone read has not landed yet).
    func testAnEraseOfTheSessionTheStoreStillHoldsIsHeld_US25_AC16g() async throws {
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 87.3, day: "2026-10-20")))
        let (filled, deviceId) = (store.recordJSON, store.deviceId)
        let erased = try await engine.eraseOnPhone(recordJSON: filled, historyJSON: nil, now: .now, deviceId: deviceId).record
        await store.showCloud(HealthEngine.CloudView(record: filled, erase: "e0", session: 1, order: 1)).value
        await store.showErased(HealthEngine.CloudView(record: erased, erase: "e1", session: 1, order: 2), stillShown: { false }).value
        XCTAssertEqual(store.recordJSON, erased)
        XCTAssertNil(store.myData?.vitals.first { $0.metric == "weight" }?.latest)
    }

    /// US-25 AC16g: an erase that came back with no record still counts; the record held is
    /// marked as predating it, so nothing is charted from it.
    func testAnEraseWithNoRecordIsCountedAndMarksTheRecordHeld_US25_AC16g() async throws {
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 87.3, day: "2026-10-20")))
        let (filled, erasures) = (store.recordJSON, store.erasures)
        await store.showErased(nil).value
        XCTAssertEqual(store.erasures, erasures + 1)
        XCTAssertEqual(store.recordJSON, filled, "no record to put in its place")
        XCTAssertTrue(store.predatesErase)
    }
}
