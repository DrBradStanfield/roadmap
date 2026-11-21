import XCTest
@testable import HealthRoadmap

/// Lead S52 (US-25 AC16f, AC16g, AC21): while the store holds a record an erase has since replaced,
/// its draw failed (`predatesErase`), nothing outside the store reads it and nothing writes to it.
/// Two ways into that window: an erase that came back with no record (`showErased(nil)`), and an
/// erase that finished after CloudSync moved on to another session. The window ends with a good draw.
@MainActor
final class PredatesEraseReadersTests: XCTestCase {
    private var folder: URL!
    private var defaultsSuite: String!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Predates Erase \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defaultsSuite = "PredatesEraseReadersTests-\(UUID().uuidString)"
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        UserDefaults().removePersistentDomain(forName: defaultsSuite)
        UnitChoices().save()
    }

    /// EraseHeldUndrawnTests' engine: its screen draw fails while `__screenFails` is set, it counts the cloud session's edits in `__cloudEdits`, and
    /// keeps the record each shared upload step was given in `__stepRecords`.
    private func engine() throws -> HealthEngine {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let source = try String(contentsOf: url, encoding: .utf8) + """

        globalThis.__screenFails = false;
        globalThis.__cloudEdits = 0;
        globalThis.__stepRecords = [];
        HealthEngine = Object.assign({}, HealthEngine, { uploadStepJson: (door => function () {
          __stepRecords.push(arguments[2]);
          return door.apply(this, arguments);
        })(HealthEngine.uploadStepJson), screenJson: (door => function () {
          if (__screenFails) throw new Error('test: the screen draw fails');
          return door.apply(this, arguments);
        })(HealthEngine.screenJson), cloudEdit: (door => function () {
          __cloudEdits += 1;
          return door.apply(this, arguments);
        })(HealthEngine.cloudEdit) });

        """
        return try HealthEngine(source: source, sourceURL: url)
    }

    private func cloudEdits(_ engine: HealthEngine) throws -> Int32 {
        try engine.blocking { try $0.evaluate("__cloudEdits").toInt32() }
    }

    /// Every record the shared upload's steps were given, from the latest pick (`steps(from:)`).
    private func stepRecords(_ engine: HealthEngine) throws -> [String] {
        let text: String = try engine.blocking { try $0.evaluate("JSON.stringify(__stepRecords.splice(0))").toString() } ?? "[]"
        return (try? JSONDecoder().decode([String].self, from: Data(text.utf8))) ?? []
    }

    /// A picture picked into the shared upload, held at its consent so nothing is sent: its steps
    /// read the record as the sheet's session reads it. The session is ended.
    private func pickedUpload(_ w: Window) async throws -> [String] {
        _ = try stepRecords(w.engine)
        let upload = UploadSession(engine: w.engine, store: w.store, frame: .milliseconds(1))
        defer { upload.end() }
        let started = await upload.start({ UploadTestKit.pictures(1) }, needsConsent: true)
        XCTAssertEqual(started, .running)
        try await UploadTestKit.until("consent") {
            if case .drawn(let text) = upload.model.state { upload.page(text)?.phase == "consent" } else { false }
        }
        return try stepRecords(w.engine)
    }

    private enum Way: CaseIterable { case noRecord, movedSession }

    private struct Window {
        let store: RecordStore
        let engine: HealthEngine
        /// The record the store held before the erase, and still holds.
        let filled: String
        /// The same record erased, as the session would hand it over.
        let erased: String
        /// The store's mark before the erase: what an in-flight chat edit carries.
        let asked: RecordStore.Mark
    }

    /// A store holding a profile, a weight and an LDL, then an erase it holds no drawing of.
    /// `before` runs on the filled store, before the erase.
    private func window(_ way: Way, before: (RecordStore, HealthEngine) async throws -> Void = { _, _ in }) async throws -> Window {
        let engine = try engine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        await XCTAssertSaved(await store.apply(.profile(sex: "female", birthYear: 1970, birthMonth: 3, height: 165)))
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 87.3, day: "2026-10-20")))
        await XCTAssertSaved(await store.apply(.add(metric: "ldl", value: 2.9, day: "2026-09-10")))
        let filled = store.recordJSON
        let erased = try await engine.eraseOnPhone(recordJSON: filled, historyJSON: nil, now: .now, deviceId: store.deviceId).record
        switch way {
        case .noRecord:
            try await before(store, engine)
            let asked = store.mark
            await store.showErased(nil).value
            XCTAssertTrue(store.predatesErase)
            return Window(store: store, engine: engine, filled: filled, erased: erased, asked: asked)
        case .movedSession:
            await store.showCloud(HealthEngine.CloudView(record: filled, erase: "e2", session: 2, order: 1)).value
            try await before(store, engine)
            let asked = store.mark
            await store.showErased(HealthEngine.CloudView(record: erased, erase: "e1", session: 1, order: 2), stillShown: { false }).value
            XCTAssertTrue(store.predatesErase)
            XCTAssertEqual(store.recordJSON, filled, "the store still holds the record from before the erase")
            return Window(store: store, engine: engine, filled: filled, erased: erased, asked: asked)
        }
    }

    private func memory() throws -> HealthSyncMemory {
        HealthSyncMemory(defaults: try XCTUnwrap(UserDefaults(suiteName: defaultsSuite)))
    }

    private struct NoRecord: Error {}

    /// HealthRoadmapApp's reminders read, on `store`.
    private func scheduler(_ store: RecordStore, _ engine: HealthEngine, _ center: FakeNotificationCenter) -> ReminderScheduler {
        ReminderScheduler(center: center, folder: folder, erasures: { store.erasures }) { firstSeen in
            guard let json = store.readable?.json else { throw NoRecord() }
            return try await engine.reminders(recordJSON: json, now: .now, deviceId: store.deviceId, firstSeen: firstSeen)
        }
    }

    // MARK: Readers

    func testNothingOutsideTheStoreReadsTheRecord_S52() async throws {
        for way in Way.allCases {
            let w = try await window(way)
            XCTAssertNil(w.store.readable, "\(way)")
            XCTAssertNil(w.store.myData, "\(way): My data and Settings say the record did not load")
            XCTAssertNil(w.store.plan, "\(way)")
            XCTAssertNil(w.store.topics, "\(way)")
            // ChatView's read: no record, so it throws ContextRefused ("Your record could not be prepared for the chat.").
            XCTAssertNil(w.store.readable?.json, "\(way): the chat is told nothing")
            try FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    func testRemindersAreClearedAndNoneArePending_S52() async throws {
        for way in Way.allCases {
            let center = FakeNotificationCenter()
            var made: ReminderScheduler?
            let w = try await window(way) { store, engine in
                let reminders = self.scheduler(store, engine, center)
                let on = await reminders.optIn()
                XCTAssertTrue(on)
                XCTAssertNotNil(reminders.reminders, "\(way): read before the erase")
                made = reminders
            }
            let reminders = try XCTUnwrap(made)
            await reminders.refresh()
            XCTAssertNil(reminders.reminders, "\(way): no reminder from the record the erase replaced")
            XCTAssertEqual(center.pending, [], "\(way): none pending")
            // The erase words say reminders are deleted: the opt-in ends though nothing could be read.
            XCTAssertFalse(reminders.optedIn, "\(way): the erase ends the opt-in")
            for name in ["reminders-opt-in", "reminders-first-seen"] {
                XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appending(path: name).path(percentEncoded: false)), "\(way): \(name) is gone")
            }
            _ = w
            try FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    func testAppleHealthIsWrittenNothing_S52() async throws {
        for way in Way.allCases {
            let w = try await window(way)
            let health = FakeHealthStore()
            let sync = AppleHealthSync(store: w.store, engine: w.engine, client: health, memory: try memory())
            await sync.connect()
            await sync.refresh()
            XCTAssertTrue(health.saved.isEmpty, "\(way): the typed weight from before the erase is not written")
            UserDefaults().removePersistentDomain(forName: defaultsSuite)
            try FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    /// DataEraser's steps after the record: Apple Health's erase records no erase it read from the
    /// held record, and the units step sends the session nothing.
    func testTheEraserStepsReadNoRecord_S52() async throws {
        for way in Way.allCases {
            let w = try await window(way)
            let memory = try memory()
            let sync = AppleHealthSync(store: w.store, engine: w.engine, client: FakeHealthStore(), memory: memory)
            _ = await sync.erased(wasConnected: false)
            // The erase is still marked as seen (US-72 AC10), with no epoch read from the record it replaced.
            let seen = way == .noRecord ? EraseSeen(epoch: 0, source: "phone") : nil
            XCTAssertEqual(memory.eraseSeen, seen, "\(way)")
            let edits = try cloudEdits(w.engine)
            let units = await w.store.apply(.units("conventional"))
            XCTAssertEqual(units, .refused(message: RecordStore.recordChanged, existingId: nil), "\(way)")
            XCTAssertEqual(try cloudEdits(w.engine), edits, "\(way): keepUnits sends the session nothing")
            UserDefaults().removePersistentDomain(forName: defaultsSuite)
            try FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    /// The shared upload's steps are given no record in the window, so nothing dedups against the
    /// record the erase replaced; its Save is refused (testNothingIsWritten_S52).
    func testALabUploadIsGivenNoRecord_S52() async throws {
        for way in Way.allCases {
            let w = try await window(way)
            let records = try await pickedUpload(w)
            XCTAssertFalse(records.isEmpty, "\(way): the pick stepped")
            XCTAssertEqual(Set(records), [""], "\(way): the upload's no-record input, so no dedup against the old record")
            XCTAssertEqual(w.store.recordJSON, w.filled, "\(way): nothing was filed")
            try FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    // MARK: Writers

    func testNothingIsWritten_S52() async throws {
        for way in Way.allCases {
            let w = try await window(way)
            let store = w.store
            let edits = try cloudEdits(w.engine)
            let refused = RecordStore.ApplyResult.refused(message: RecordStore.recordChanged, existingId: nil)

            let typed = await store.apply(.add(metric: "weight", value: 70, day: "2026-11-13"))
            XCTAssertEqual(typed, refused, "\(way): a typed edit")
            let units = await store.apply(.units("conventional"))
            XCTAssertEqual(units, refused, "\(way): keepUnits")
            // The shared upload's one Save: refused before the engine is asked, whatever the state.
            guard case .failure(let upload) = await store.saveUpload(state: "{}", originals: [:], read: { _ in nil }, as: store.screen) else {
                return XCTFail("\(way): an upload save landed")
            }
            XCTAssertEqual(upload.message, RecordStore.recordChanged, "\(way): an upload save")
            // A chat edit asked before the erase meets the moved mark; one asked in the window, the store's guard.
            let inFlight = await store.applyChatEdit(.add(metric: "weight", value: 71, day: "2026-11-13"), on: w.asked)
            guard case .refused = inFlight.result else { return XCTFail("\(way): an in-flight chat edit landed") }
            XCTAssertFalse(inFlight.changed)
            let now = await store.applyChatEdit(.add(metric: "weight", value: 72, day: "2026-11-13"), on: store.mark)
            XCTAssertEqual(now.result, refused, "\(way): a chat edit made in the window")

            XCTAssertEqual(store.recordJSON, w.filled, "\(way): nothing landed")
            XCTAssertEqual(try cloudEdits(w.engine), edits, "\(way): nothing reached the session")
            try FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    /// An Apple Health import is refused and keeps its anchor, so the batch comes again later.
    func testAnAppleHealthImportLandsNothingAndKeepsItsAnchor_S52() async throws {
        for way in Way.allCases {
            let w = try await window(way)
            let health = FakeHealthStore()
            health.pending[.weight] = [HealthSample(id: UUID(), metric: "weight", value: 70, at: .now, timeZone: .gmt)]
            let memory = try memory()
            let sync = AppleHealthSync(store: w.store, engine: w.engine, client: health, memory: memory)
            await sync.connect()
            guard case .failed(let words) = sync.status else { return XCTFail("\(way): status \(sync.status)") }
            XCTAssertEqual(words, RecordStore.recordChanged, "\(way)")
            XCTAssertNil(memory.anchor(for: .weight), "\(way): the batch is read again later")
            XCTAssertEqual(w.store.recordJSON, w.filled, "\(way): the import did not land")
            UserDefaults().removePersistentDomain(forName: defaultsSuite)
            try FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    // An erase held with no drawing is not the window: RedrawHeldEraseTests'
    // testAnEraseHeldUndrawnStillTakesALabReportAndADocument_US25_AC16f shows a lab report and a
    // document land there, on a real cloud session (lead S56).

    // MARK: The window ends

    /// A good draw ends the window: every reader reads the record drawn, and every writer reaches it.
    func testAGoodDrawEndsTheWindow_S52() async throws {
        let center = FakeNotificationCenter()
        var made: ReminderScheduler?
        let w = try await window(.movedSession) { store, engine in
            let reminders = self.scheduler(store, engine, center)
            _ = await reminders.optIn()
            made = reminders
        }
        let store = w.store
        let reminders = try XCTUnwrap(made)
        let health = FakeHealthStore()
        let sync = AppleHealthSync(store: store, engine: w.engine, client: health, memory: try memory())
        await sync.connect()
        XCTAssertTrue(health.saved.isEmpty)

        await store.showCloud(HealthEngine.CloudView(record: w.filled, erase: "e3", session: 2, order: 3)).value
        XCTAssertFalse(store.predatesErase)
        XCTAssertEqual(store.readable?.json, w.filled)
        XCTAssertNotNil(store.myData)
        XCTAssertNotNil(store.plan)
        XCTAssertNotNil(store.topics)
        await reminders.refresh()
        XCTAssertNotNil(reminders.reminders, "reminders read the record again")
        await sync.refresh()
        XCTAssertFalse(health.saved.isEmpty, "Apple Health is written the typed weight")
        let records = try await pickedUpload(w)
        XCTAssertFalse(records.isEmpty)
        XCTAssertEqual(Set(records), [w.filled], "the lab upload dedups against the record drawn")
        let edits = try cloudEdits(w.engine)
        _ = await store.apply(.add(metric: "weight", value: 70, day: "2026-11-13"))
        XCTAssertEqual(try cloudEdits(w.engine), edits + 1, "a typed edit reaches the session again")
    }

    /// On the phone's file, the phone's own read ends it, and a typed edit saves.
    func testThePhonesReadEndsTheWindowAndAnEditSaves_S52() async throws {
        let w = try await window(.noRecord)
        await w.store.showPhone().value
        XCTAssertFalse(w.store.predatesErase)
        XCTAssertNotNil(w.store.readable)
        await XCTAssertSaved(await w.store.apply(.add(metric: "weight", value: 70, day: "2026-11-13")))
    }

    // MARK: Relaunch (finding)

    /// Nothing in the store keeps the window across a relaunch: `erasures` and `screenErasures` both
    /// start at 0, and the reopened store reads whatever the phone's file holds. What keeps a
    /// pre-erase record out after a relaunch is the engine's cloud erase writing the erased record
    /// to the phone's file (ios/engine/cloud.ts cloudErase), not this store.
    func testARelaunchStartsOutsideTheWindowOnThePhonesFile_S52() async throws {
        let w = try await window(.noRecord)
        let onDisk = try String(contentsOf: folder.appending(path: "health-roadmap.json"), encoding: .utf8)
        let reopened = try RecordStore(folder: folder, engine: w.engine, deviceId: "test")
        XCTAssertFalse(reopened.predatesErase)
        XCTAssertEqual(reopened.readable?.json, onDisk, "the phone's file, whatever it holds")
    }
}
