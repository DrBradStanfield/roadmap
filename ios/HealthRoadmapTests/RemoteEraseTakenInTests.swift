import UserNotifications
import XCTest
@testable import HealthRoadmap

/// Leads S70 and S63 (US-25 AC16j): an erase made on another device that this phone takes in moves the
/// store's erase count in the step that lands it (`land`, `Mark.erased(by:)`), as this phone's own
/// erase does. So the kept charts drop at once (S70), the reminders opt-in and first-seen days end
/// even when the record cannot be read (S63), and the open chat drops. A same-session view whose
/// erase moved is held even when the engine cannot draw it (AC16f), never the pre-erase record
/// shown. An undrawn edit, a link change or a connect is no evidence of an erase.
@MainActor
final class RemoteEraseTakenInTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Remote Erase \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        // A run killed before its tearDown can leave a per-test unit saved on the simulator.
        UnitChoices().save()
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        UnitChoices().save()
    }

    /// The bundled engine; its screen draw fails while `__screenFails` is set (RedrawHeldEraseTests).
    private func engine() throws -> HealthEngine {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let source = try String(contentsOf: url, encoding: .utf8) + """

        globalThis.__screenFails = false;
        HealthEngine = Object.assign({}, HealthEngine, { screenJson: (door => function () {
          if (__screenFails) throw new Error('test: the screen draw fails');
          return door.apply(this, arguments);
        })(HealthEngine.screenJson) });

        """
        return try HealthEngine(source: source, sourceURL: url, session: StubHTTP.session())
    }

    private func screenFails(_ fails: Bool, _ engine: HealthEngine) throws {
        _ = try engine.blocking { try $0.evaluate("__screenFails = \(fails)") }
    }

    /// A web record with one weight per day given, as the cloud holds it before the erase.
    private func weighed(_ engine: HealthEngine, days: [String] = ["2026-10-01"]) throws -> String {
        var json = try engine.blocking { try $0.newRecord(now: .now, deviceId: "web") }
        for (index, day) in days.enumerated() {
            json = try XCTUnwrap(engine.blocking { try $0.apply(.add(metric: "weight", value: 80 + Double(index), day: day), to: json, now: .now, deviceId: "web") }.record)
        }
        return json
    }

    /// Another device's erase of `record`: the engine's own erase, so its eraseEpoch is one higher.
    private func erased(_ record: String, _ engine: HealthEngine) throws -> String {
        try engine.blocking { try $0.eraseOnPhone(recordJSON: record, historyJSON: nil, now: .now, deviceId: "web") }.record
    }

    private func store(_ engine: HealthEngine) throws -> RecordStore {
        try RecordStore(folder: folder, engine: engine, deviceId: "test")
    }

    /// A cloud record with a weight drawn (session 1, order 1) and its chart kept.
    private func charted(_ engine: HealthEngine) async throws -> (RecordStore, String) {
        let store = try store(engine)
        let before = try weighed(engine)
        await store.showCloud(HealthEngine.CloudView(record: before, erase: "e1", session: 1, order: 1)).value
        _ = await store.chart(for: "weight")
        XCTAssertNotNil(store.shownChart(for: "weight"), "the pre-erase chart is kept")
        XCTAssertEqual(store.erasures, 0)
        return (store, before)
    }

    // MARK: S70

    /// S70: a remote erase that lands drops the kept chart in the same step, so an open value page
    /// never draws the pre-erase values while its re-read runs.
    func testARemoteEraseDropsTheKeptChart_S70() async throws {
        let engine = try engine()
        let (store, before) = try await charted(engine)
        let kept = try XCTUnwrap(store.shownChart(for: "weight"))
        let shownAt = store.revision
        let erased = try erased(before, engine)

        await store.showCloud(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 2)).value

        XCTAssertEqual(store.recordJSON, erased, "the erase landed")
        XCTAssertNil(store.shownChart(for: "weight"), "no pre-erase chart is handed back")
        // The open page still holds its read at the old revision: with no kept chart it never draws values.
        let page = MetricRead.page(.chart(revision: shownAt, kept), revision: store.revision, problem: nil,
                                   kept: store.shownChart(for: "weight"), hasReadings: false, screenHasReading: nil)
        if case .chart = page { XCTFail("the open page draws the pre-erase chart") }
        XCTAssertEqual(store.erasures, 1, "a remote erase is counted")
        XCTAssertFalse(store.predatesErase, "the record shown is the erased one")
    }

    // MARK: S63

    /// S63 shape (a): the session read the erase but the engine cannot draw it. Same session, its
    /// erase moved: the erased record is held with no drawing (AC16f), never the pre-erase one shown.
    func testARemoteEraseTheEngineCannotDrawIsHeld_S63() async throws {
        let engine = try engine()
        let (store, before) = try await charted(engine)
        let erased = try erased(before, engine)
        try screenFails(true, engine)

        await store.showCloud(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 2)).value

        XCTAssertEqual(store.recordJSON, erased, "the erased record is the one held")
        XCTAssertEqual(store.hold, .heldUndrawn)
        XCTAssertNil(store.myData, "My data says the record did not load")
        XCTAssertNil(store.shownChart(for: "weight"))
        XCTAssertEqual(store.erasures, 1)
        XCTAssertFalse(store.predatesErase)
    }

    /// S63: a remote erase the engine cannot draw, with a reminders read that fails: the opt-in and
    /// the first-seen days go, and nothing stays pending.
    func testARemoteEraseEndsRemindersWhenTheReadFails_S63() async throws {
        let engine = try engine()
        let (store, before) = try await charted(engine)
        let center = FakeNotificationCenter()
        center.status = .allowed
        center.pending = [UNNotificationRequest(identifier: "reminder.2027-01-15", content: UNMutableNotificationContent(), trigger: nil)]
        let optIn = folder.appending(path: "reminders-opt-in"), firstSeen = folder.appending(path: "reminders-first-seen")
        try Data("0".utf8).write(to: optIn)
        try Data(#"{"blood_test_lipids":"2026-10-01"}"#.utf8).write(to: firstSeen)
        let scheduler = ReminderScheduler(center: center, folder: folder, erasures: { store.erasures }) { _ in
            throw HealthEngine.EngineError.callFailed("unreadable")
        }
        XCTAssertTrue(scheduler.optedIn)

        let erased = try erased(before, engine)
        try screenFails(true, engine)
        await store.showCloud(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 2)).value
        await scheduler.refresh()

        XCTAssertFalse(scheduler.optedIn, "the erase ends the opt-in")
        XCTAssertFalse(FileManager.default.fileExists(atPath: optIn.path(percentEncoded: false)), "the opt-in file goes")
        XCTAssertFalse(FileManager.default.fileExists(atPath: firstSeen.path(percentEncoded: false)), "the first-seen days go")
        XCTAssertEqual(center.pending.count, 0)
    }

    /// The guard on S63: an edit the engine cannot draw (lead H17), a same-erase re-read it cannot
    /// draw, and a link change are no erase. The count stays, and reminders stay on.
    func testAnUndrawnEditIsNotAnErase_S63() async throws {
        let engine = try engine()
        let (store, before) = try await charted(engine)
        let center = FakeNotificationCenter()
        center.status = .allowed
        try Data("0".utf8).write(to: folder.appending(path: "reminders-opt-in"))
        let scheduler = ReminderScheduler(center: center, folder: folder, erasures: { store.erasures }) { _ in
            throw HealthEngine.EngineError.callFailed("unreadable")
        }
        let edited = try weighed(engine, days: ["2026-10-01", "2026-10-02"])
        try screenFails(true, engine)

        let held = await store.draw(edited, order: 2, as: .cloudEdited(erase: "e1"), holdUndrawn: true)
        XCTAssertEqual(held, .held, "the session took the edit; it is held undrawn")
        XCTAssertEqual(store.hold, .heldUndrawn)
        await store.showCloud(HealthEngine.CloudView(record: before, erase: "e1", session: 1, order: 3)).value
        store.link(.init(account: "dropbox:B", pending: PhoneFiles(record: nil, pending: nil)))
        await store.redraw().value
        await scheduler.refresh()

        XCTAssertEqual(store.erasures, 0, "no erase moved")
        XCTAssertFalse(store.predatesErase)
        XCTAssertTrue(scheduler.optedIn, "a failed draw ends no reminders")
    }

    // MARK: Mark.erased(by:)

    func testMarkErasedByTable() {
        typealias Mark = RecordStore.Mark
        let base = Mark(erase: "e1", epoch: 1, erasures: 0)
        let rows: [(now: Mark, want: Bool, why: String)] = [
            (Mark(erase: "e1", epoch: 1, erasures: 0), false, "all equal"),
            (Mark(erase: "e1", epoch: 1, erasures: 1), true, "the count moved"),
            (Mark(erase: "e1", epoch: 2, erasures: 0), true, "both epochs known and moved"),
            (Mark(erase: "e1", epoch: nil, erasures: 0), false, "an undrawn record: no epoch, no evidence"),
            (Mark(erase: "e2", epoch: 1, erasures: 0), true, "both cloud erases known and moved"),
            (Mark(erase: nil, epoch: 1, erasures: 0), false, "a disconnect: one cloud erase nil"),
            (Mark(erase: "e2", epoch: nil, erasures: 0), true, "undrawn, but the cloud erase moved"),
        ]
        for row in rows { XCTAssertEqual(base.erased(by: row.now), row.want, row.why) }
        // From an undrawn mark, a phone mark (no cloud erase): only a moved count is evidence.
        XCTAssertFalse(Mark(erase: "e1", epoch: nil, erasures: 0).erased(by: Mark(erase: "e1", epoch: 4, erasures: 0)), "undrawn before")
        XCTAssertFalse(Mark(erase: nil, epoch: 0, erasures: 0).erased(by: Mark(erase: "e1", epoch: 0, erasures: 0)), "a connect")
        XCTAssertTrue(Mark(erase: nil, epoch: nil, erasures: 2).erased(by: Mark(erase: nil, epoch: nil, erasures: 3)), "the count alone")
    }

    // MARK: PR 1599's scenario, every order

    /// Codex R1 on PR 1599, re-derived for S63's hold: a record drawn at e1 (order 1), then the
    /// session's erase view E (e2, order 3) and an older pre-erase answer P (e1, order 2), in every
    /// order and with E drawable or not. P never lands over E: once E is in, P is stale.
    func testAnOlderPreEraseAnswerNeverLandsOverARemoteErase_EveryOrder_S63() async throws {
        let engine = try engine()
        let before = try weighed(engine)
        let older = try weighed(engine, days: ["2026-10-01", "2026-10-02"])
        let erased = try erased(before, engine)
        let e = HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 3)
        let p = HealthEngine.CloudView(record: older, erase: "e1", session: 1, order: 2)

        for drawable in [true, false] {
            for eFirst in [true, false] {
                let why = "E \(drawable ? "drawn" : "held undrawn"), \(eFirst ? "E then P" : "P then E")"
                try screenFails(false, engine)
                let store = try store(engine)
                await store.showCloud(HealthEngine.CloudView(record: before, erase: "e1", session: 1, order: 1)).value
                if !eFirst { await store.showCloud(p).value; XCTAssertEqual(store.recordJSON, older, why) }
                try screenFails(!drawable, engine)
                await store.showCloud(e).value
                try screenFails(false, engine)
                if eFirst { await store.showCloud(p).value }

                XCTAssertEqual(store.recordJSON, erased, "the erase is the record held: \(why)")
                XCTAssertEqual(store.hold, drawable ? .readable : .heldUndrawn, why)
                XCTAssertEqual(store.cloudErase, "e2", why)
                XCTAssertEqual(store.erasures, 1, "counted once: \(why)")
                XCTAssertFalse(store.predatesErase, why)
            }
        }
    }

    /// The same, with this phone's own erase (showErased) as E: drawable or not, in either order,
    /// the pre-erase answer never lands over it, and the erase is counted once.
    func testAnOlderPreEraseAnswerNeverLandsOverAnOwnErase_EveryOrder_S63() async throws {
        let engine = try engine()
        let before = try weighed(engine)
        let older = try weighed(engine, days: ["2026-10-01", "2026-10-02"])
        let erased = try erased(before, engine)
        let e = HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 3)
        let p = HealthEngine.CloudView(record: older, erase: "e1", session: 1, order: 2)

        for drawable in [true, false] {
            for eFirst in [true, false] {
                let why = "own erase \(drawable ? "drawn" : "held undrawn"), \(eFirst ? "E then P" : "P then E")"
                try screenFails(false, engine)
                let store = try store(engine)
                await store.showCloud(HealthEngine.CloudView(record: before, erase: "e1", session: 1, order: 1)).value
                if !eFirst { await store.showCloud(p).value }
                try screenFails(!drawable, engine)
                await store.showErased(e).value
                try screenFails(false, engine)
                if eFirst { await store.showCloud(p).value }

                XCTAssertEqual(store.recordJSON, erased, why)
                XCTAssertEqual(store.erasures, 1, "own erase counted once: \(why)")
                XCTAssertFalse(store.predatesErase, why)
            }
        }
    }

    /// Codex R1 / adversary F2 on PR 1768: during this phone's cloud erase, the session's save loop
    /// sends the erased record as news, which lands and is counted. The erase's own result then
    /// arrives stale (`showErased`, `.stale`): it holds that same erase, so it counts nothing more.
    func testAnOwnCloudEraseCountsOnceWhenItsNewsLandsFirst_S63() async throws {
        let engine = try engine()
        let (store, before) = try await charted(engine)
        let erased = try erased(before, engine)

        await store.showCloud(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 3)).value
        XCTAssertEqual(store.erasures, 1, "the news lands the erase and counts it")
        await store.showErased(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 2)).value

        XCTAssertEqual(store.erasures, 1, "the erase's own stale result counts nothing more")
        XCTAssertFalse(store.predatesErase)
        XCTAssertEqual(store.recordJSON, erased)
    }

    /// Codex R1 on 73a7b728, adversary re-check F1: the news can be stamped BEFORE the erase's own
    /// result (the flush announces it, the door stamps its answer later). The result then lands
    /// (drawn or held) on the same erase land already counted: it counts nothing more.
    func testAnOwnCloudEraseCountsOnceWhenItsNewsIsStampedFirst_S63() async throws {
        for drawable in [true, false] {
            let engine = try engine()
            let (store, before) = try await charted(engine)
            let erased = try erased(before, engine)
            await store.showCloud(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 2)).value
            XCTAssertEqual(store.erasures, 1, "the news lands the erase and counts it")
            try screenFails(!drawable, engine)
            await store.showErased(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 3)).value

            XCTAssertEqual(store.erasures, 1, "the erase's own later result counts nothing more (\(drawable ? "drawn" : "held"))")
            XCTAssertFalse(store.predatesErase)
            XCTAssertEqual(store.recordJSON, erased)
        }
    }

    /// Adversary re-check F3: `land` remembers an erase in `countedErases` only when it counted it.
    /// From an unreadable phone file (a problem, no epoch, no cloud erase) a cloud record at e2 is no
    /// evidence of an erase, so nothing is counted or remembered, and the erase's own result then
    /// counts it. A store-level invariant, not a reachable user path: the session's news reaches the
    /// store only once its session is shown (`HealthEngine.CloudView.session`: news from any other
    /// is dropped).
    func testAnEraseLandNeverCountedIsCountedByItsOwnResult_S63() async throws {
        let engine = try engine()
        try Data("null".utf8).write(to: folder.appending(path: "health-roadmap.json"))
        let store = try store(engine)
        XCTAssertNotNil(store.problem, "the phone's file is not a record")
        let erased = try erased(try weighed(engine), engine)

        await store.showCloud(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 1)).value
        XCTAssertEqual(store.recordJSON, erased)
        XCTAssertEqual(store.erasures, 0, "no epoch and no cloud erase before: no evidence, nothing counted")
        await store.showErased(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 2)).value

        XCTAssertEqual(store.erasures, 1, "land never counted e2, so its own result does")
        XCTAssertFalse(store.predatesErase)
    }

    /// Adversary re-check F2, owner's yes: the news lands the erase (counted), a reopen's new session
    /// shows the same erased record, then the erase's own result fails (its session no longer shown).
    /// The record shown holds that erase by construction: nothing is counted again, and nothing is
    /// marked as predating it (US-25 AC16g, AC16j).
    func testAFailedOwnEraseResultWhoseEraseLandCountedCountsNothingMore_S63() async throws {
        let engine = try engine()
        let (store, before) = try await charted(engine)
        let erased = try erased(before, engine)
        await store.showCloud(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 2)).value
        await store.showCloud(HealthEngine.CloudView(record: erased, erase: "e2", session: 2, order: 3)).value
        XCTAssertEqual(store.erasures, 1, "the news counted it; the reopen's same erase is no evidence")

        await store.showErased(HealthEngine.CloudView(record: erased, erase: "e2", session: 1, order: 4), stillShown: { false }).value

        XCTAssertEqual(store.erasures, 1, "counted once")
        XCTAssertFalse(store.predatesErase, "the record shown is the erased one")
        XCTAssertEqual(store.recordJSON, erased)
    }

    /// AC16g still holds for an erase that came back with no record: it is counted and marks the
    /// record as predating it, even after an erase land counted with no cloud erase (this phone's
    /// own file), so a missing view never matches a remembered erase.
    func testAnEraseWithNoRecordIsStillCountedAndPredatesAfterAPhoneErase_AC16g() async throws {
        let engine = try engine()
        let store = try store(engine)
        guard case .erased = await store.erasePhone(historyJSON: nil, keepChat: { _, _ in true }) else { return XCTFail("not erased") }
        XCTAssertEqual(store.erasures, 1)

        await store.showErased(nil).value

        XCTAssertEqual(store.erasures, 2, "an erase with no record is counted (AC16g)")
        XCTAssertTrue(store.predatesErase, "and the record shown is marked as predating it")
    }

    /// A stale own erase result under a later record at ANOTHER erase (its news never landed) is still
    /// counted: the later record proves it was read after the erase, not that the erase was counted.
    func testAStaleOwnEraseUnderALaterEraseIsStillCounted_S63() async throws {
        let engine = try engine()
        let (store, before) = try await charted(engine)
        let first = try erased(before, engine), second = try erased(first, engine)

        await store.showCloud(HealthEngine.CloudView(record: second, erase: "e3", session: 1, order: 3)).value
        XCTAssertEqual(store.erasures, 1, "e3 landed and counted")
        await store.showErased(HealthEngine.CloudView(record: first, erase: "e2", session: 1, order: 2)).value

        XCTAssertEqual(store.erasures, 2, "e2 was never counted: its own result counts it")
        XCTAssertFalse(store.predatesErase)
        XCTAssertEqual(store.recordJSON, second)
    }

    // MARK: Behaviour changes

    /// Behaviour change (a): the open chat drops on a remote erase. ChatView drops its transcript on
    /// a move of `store.erasures` (ChatView.swift .onChange), and a reply in flight checks the same
    /// count (`live()`), so it is dropped and never saved. Pinned at the store: the count moves once,
    /// and a mark taken before the erase (a question's `asked`) no longer holds.
    func testARemoteEraseMovesTheCountTheOpenChatDropsOn() async throws {
        let engine = try engine()
        let (store, before) = try await charted(engine)
        let askedAt = store.erasures, asked = store.mark

        await store.showCloud(HealthEngine.CloudView(record: try erased(before, engine), erase: "e2", session: 1, order: 2)).value

        XCTAssertNotEqual(store.erasures, askedAt, "the chat's onChange and live() see the erase")
        XCTAssertFalse(asked.holds(at: store.mark), "a reply's edits never apply to the erased record")
        // A re-read of the erased record moves nothing more.
        await store.showCloud(HealthEngine.CloudView(record: store.recordJSON, erase: "e2", session: 1, order: 3)).value
        XCTAssertEqual(store.erasures, askedAt + 1)
    }

    /// Behaviour change (b): a switch to another account's record at another erase moves the count,
    /// but nothing treats it as the person erasing: Apple Health stays connected with its anchors,
    /// the per-test units are kept, and the after-erase questions do not start (DataEraser's
    /// `startsOver`, which RootView follows, stays still).
    func testASwitchToAnotherEraseMovesTheCountButKeepsHealthUnitsAndQuestions() async throws {
        let suite = "RemoteEraseTakenInTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let memory = HealthSyncMemory(defaults: defaults)
        let health = FakeHealthStore()
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try store(engine)
        let tokens = TokenStore(service: "test.\(UUID().uuidString)")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let appleHealth = AppleHealthSync(store: store, engine: engine, client: health, memory: memory)
        let eraser = DataEraser(store: store, sync: sync, chat: ChatHistoryStore(engine: engine, folder: folder, deviceId: "test"),
                                reminders: nil, health: appleHealth, live: nil)
        let units = UnitChoices().setting("weight", to: "conventional")
        store.publish(units)
        await appleHealth.connect()
        XCTAssertTrue(appleHealth.connected)

        let pending = PhoneFiles(record: nil, pending: nil)
        let recordA = try weighed(engine)
        store.link(.init(account: "dropbox:A", pending: pending))
        await store.showCloud(HealthEngine.CloudView(record: recordA, erase: "e-a", session: 1)).value
        await appleHealth.refresh()
        let counted = store.erasures
        // B's record: another account's, erased once (a higher epoch and its own erase identity).
        store.link(.init(account: "googleDrive:B", pending: pending))
        await store.showCloud(HealthEngine.CloudView(record: try erased(recordA, engine), erase: "e-b", session: 2)).value
        await appleHealth.refresh()

        XCTAssertEqual(store.erasures, counted + 1, "the switch moves the count")
        XCTAssertTrue(appleHealth.connected, "Apple Health stays connected")
        XCTAssertTrue(memory.connected)
        XCTAssertEqual(health.stops, 0, "nothing stopped observing")
        XCTAssertEqual(store.unitChoices, units, "the per-test units are kept")
        XCTAssertEqual(UnitChoices.saved(), units, "and saved")
        XCTAssertEqual(eraser.startsOver, 0, "the after-erase questions do not start")
        XCTAssertNil(eraser.held, "no erase words")
    }
}
