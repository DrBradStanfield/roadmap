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

    /// EraseHeldUndrawnTests' engine: it counts the cloud session's edits in `__cloudEdits`, and
    /// keeps the record each lab review was given in `__reviewRecords`.
    private func engine() throws -> HealthEngine {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let source = try String(contentsOf: url, encoding: .utf8) + """

        globalThis.__cloudEdits = 0;
        globalThis.__reviewRecords = [];
        HealthEngine = Object.assign({}, HealthEngine, { cloudEdit: (door => function () {
          __cloudEdits += 1;
          return door.apply(this, arguments);
        })(HealthEngine.cloudEdit), labReviewJson: (door => function () {
          __reviewRecords.push(arguments[2]);
          return door.apply(this, arguments);
        })(HealthEngine.labReviewJson) });

        """
        return try HealthEngine(source: source, sourceURL: url)
    }

    private func cloudEdits(_ engine: HealthEngine) throws -> Int32 {
        try engine.blocking { try $0.evaluate("__cloudEdits").toInt32() }
    }

    private func lastReviewRecord(_ engine: HealthEngine) throws -> String {
        try engine.blocking { try $0.evaluate("__reviewRecords[__reviewRecords.length - 1]").toString() }
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
        ReminderScheduler(center: center, folder: folder) { firstSeen in
            guard let json = store.readable?.json else { throw NoRecord() }
            return try await engine.reminders(recordJSON: json, now: .now, deviceId: store.deviceId, firstSeen: firstSeen)
        }
    }

    private let dated = #"""
    {"classification":"lab_report","reportDate":"2026-10-01",
     "values":[{"metric":"ldl","valueSI":3.1,"displayValue":3.1,"displayUnit":"mmol/L","displaySystem":"si","confidence":"high"}],
     "additionalValues":[], "refusedValues":[]}
    """#
    private let letter = ##"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Cardiology follow-up","documentDate":"2026-09-14","contentMarkdown":"# Letter","metadata":{}}}"##

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
            XCTAssertNil(memory.eraseSeen, "\(way): no erase epoch read from the record the erase replaced")
            let edits = try cloudEdits(w.engine)
            let units = await w.store.apply(.units("conventional"))
            XCTAssertEqual(units, .refused(message: RecordStore.recordChanged, existingId: nil), "\(way)")
            XCTAssertEqual(try cloudEdits(w.engine), edits, "\(way): keepUnits sends the session nothing")
            UserDefaults().removePersistentDomain(forName: defaultsSuite)
            try FileManager.default.removeItem(at: folder)
            try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        }
    }

    func testALabReviewIsGivenNoRecord_S52() async throws {
        for way in Way.allCases {
            let w = try await window(way)
            let result = LabResult(name: "Letter.pdf", truncated: false, extractionJSON: letter, failure: nil)
            _ = await LabReportSave.saveWaiting(result, held: nil, engine: w.engine, store: w.store)
            XCTAssertEqual(try lastReviewRecord(w.engine), "", "\(way): the review's no-record input, so no dedup against the old record")
            XCTAssertEqual(w.store.recordJSON, w.filled, "\(way): the letter was not filed")
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
            guard case .failure(let labs) = await store.importLabs(extractionJSON: dated, refs: ["v0"], reportDay: "2026-10-01") else {
                return XCTFail("\(way): a lab import landed")
            }
            XCTAssertEqual(labs.message, RecordStore.recordChanged, "\(way): a lab import")
            let choice = DocumentChoice(kind: .document, sourceFileName: "Letter.pdf", title: "Cardiology follow-up", documentDate: nil, mimeType: "")
            let filed = await store.saveDocument(extractionJSON: letter, choice: choice, original: nil)
            XCTAssertEqual(filed, .refused(RecordStore.recordChanged), "\(way): a document save")
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
        _ = await LabReportSave.saveWaiting(LabResult(name: "Letter.pdf", truncated: false, extractionJSON: letter, failure: nil),
                                            held: nil, engine: w.engine, store: store)
        XCTAssertEqual(try lastReviewRecord(w.engine), w.filled, "the lab review dedups against the record drawn")
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
