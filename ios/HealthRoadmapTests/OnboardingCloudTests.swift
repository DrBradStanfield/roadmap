import XCTest
@testable import HealthRoadmap

/// US-54 AC5d (iPhone survey S6, re-check R1 and R2 of PR 1570; owner's ruling (c)): an
/// onboarding page whose record moves under it, by a cloud record landing after its pin or by
/// another device's erase, is refused once and plans again from the record now shown. No tap
/// saves into a record the page never showed, and no page is refused for good. End to end
/// through the store, CloudSync, the engine's session and the stubbed Dropbox (CloudSyncTests'
/// own parts). The view's effects are run here by hand, as OnboardingView+Flow runs them.
@MainActor
final class OnboardingCloudTests: XCTestCase, CloudFixtures {
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Onboarding Cloud \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
    }

    private func app() throws -> (store: RecordStore, sync: CloudSync) {
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        return (store, CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session())))
    }

    /// A tap on `mode`'s page: the save's claim, the store's answer, and where the flow lands,
    /// with the view's one trigger (`moved: !store.pinStillShown`).
    private func tap(_ mode: OnboardingFlow.Mode, _ edit: RecordEdit, _ store: RecordStore, step: OnboardingStep)
        async -> (RecordStore.ApplyResult, OnboardingFlow.Mode, [OnboardingFlow.Effect]) {
        let (claimed, claim) = OnboardingFlow.transition(mode, .tapped)
        XCTAssertEqual(claim, [.save(step)], "the tap claims the save")
        let result = await store.apply(edit)
        let landing = OnboardingFlow.landing(.applied(result), step: step, moved: !store.pinStillShown)
        let (next, effects) = OnboardingFlow.transition(claimed, .landed(landing, next: nil))
        return (result, next, effects)
    }

    /// The view's restart effect: take the record now shown, then begin's plan from it.
    private func replan(_ mode: OnboardingFlow.Mode, _ store: RecordStore, onlyMissing: Bool) throws -> OnboardingFlow.Mode {
        store.repinScreen()
        let profile = try XCTUnwrap(store.myData?.profile)
        let first = OnboardingSteps.first(profile, onlyMissing: onlyMissing, healthAsked: true, skip: [], weightDay: nil, hasWeight: false)
        return OnboardingFlow.transition(mode, .replanned(.init(step: first))).0
    }

    /// R1: a relaunch of an "I already use Health Roadmap" run on the sex page (no Back) pins the
    /// phone's copy before the cloud's record is handed over. The tap is refused once, with the
    /// store's words; the flow plans again; the next tap saves, against the record now shown.
    func testACloudRecordLandingAfterThePinRefusesOnceThenSaves_R1() async throws {
        dropbox.put(try record(days: [], device: "web"))
        let (store, sync) = try app()
        store.pinScreen()  // begin pins the phone's copy
        defer { store.unpinScreen() }
        await sync.start()
        XCTAssertNotNil(store.cloudErase, "the cloud's record landed after the pin")

        var (result, mode, effects) = await tap(.page(.init(step: .sex), .editing(message: nil)), .profile(sex: "female"), store, step: .sex)
        XCTAssertEqual(result, .refused(message: RecordStore.recordChanged, existingId: nil))
        XCTAssertEqual(effects, [.restart], "refused once, then plans again")
        mode = try replan(mode, store, onlyMissing: true)
        XCTAssertEqual(mode, .page(.init(step: .sex), .editing(message: RecordStore.recordChanged)), "the cloud's record lacks sex too")

        (result, mode, effects) = await tap(mode, .profile(sex: "female"), store, step: .sex)
        XCTAssertEqual(result, .saved(), "the next tap saves")
        XCTAssertEqual(store.myData?.profile.sex, "female")
        XCTAssertFalse(effects.contains(.restart))
    }

    /// R1, when the cloud's record already holds the answer: the plan moves past the page and
    /// the refused tap wrote nothing.
    func testACloudRecordHoldingTheAnswerMovesPastThePage_R1() async throws {
        let engine = try HealthEngine()
        let web = try engine.blocking { engine -> String in
            try XCTUnwrap(engine.apply(.profile(sex: "male"), to: try engine.newRecord(now: .now, deviceId: "web"), now: .now, deviceId: "web").record)
        }
        dropbox.put(try XCTUnwrap(JSONSerialization.jsonObject(with: Data(web.utf8)) as? [String: Any]))
        let (store, sync) = try app()
        store.pinScreen()
        defer { store.unpinScreen() }
        await sync.start()

        let (_, waiting, effects) = await tap(.page(.init(step: .sex), .editing(message: nil)), .profile(sex: "female"), store, step: .sex)
        XCTAssertEqual(effects, [.restart])
        XCTAssertEqual(try replan(waiting, store, onlyMissing: true).step, .birth, "past the sex page")
        XCTAssertEqual(store.myData?.profile.sex, "male", "the refused tap wrote nothing")
    }

    /// R2: another device's erase, the tap made before its draw lands and again after. Neither
    /// saves into the erased record; once the erase is shown, the flow plans again from it.
    func testATapAroundAnotherDevicesEraseNeverSavesIntoIt_R2() async throws {
        let before = try record(days: ["2026-10-01"], device: "web")
        dropbox.put(before)
        let (store, sync) = try app()
        await sync.start()
        store.pinScreen()  // the weight page shows the pre-erase record
        defer { store.unpinScreen() }
        dropbox.put(erasedOnTheWeb(before))
        await sync.syncNow()

        // Before the draw: the session holds the erase, the screen may not yet. Refused either way.
        var mode = OnboardingFlow.Mode.page(.init(step: .weight), .editing(message: nil))
        var (result, next, effects) = await tap(mode, .add(metric: "weight", value: 80, day: "2026-10-02"), store, step: .weight)
        guard case .refused = result else { return XCTFail("a tap before the erase's draw must not save") }
        mode = next
        await drawn(store) { self.activeDays(store.recordJSON) == [] }
        if !effects.contains(.restart) {
            // Words, and a repin taken before the draw: after it, the next tap meets the moved record.
            XCTAssertEqual(effects, [.repin])
            (result, next, effects) = await tap(mode, .add(metric: "weight", value: 80, day: "2026-10-02"), store, step: .weight)
            guard case .refused = result else { return XCTFail("a tap after the erase's draw must not save") }
            mode = next
        }
        XCTAssertEqual(effects, [.restart], "once the erase is shown, the flow plans again")
        XCTAssertEqual(activeDays(store.recordJSON), [], "nothing saved into the erased record")
        mode = try replan(mode, store, onlyMissing: false)
        XCTAssertTrue(store.pinStillShown, "the page now holds the erased record, shown")
        await sync.background()
        XCTAssertEqual(activeDays(dropbox.record), [], "nor into the cloud's")
    }

    /// The web's erase of `before`: a higher eraseEpoch, and the rows it removed listed
    /// (as CloudSyncTests.testAnEraseFromAnotherDeviceIsTakenIn makes it).
    private func erasedOnTheWeb(_ before: [String: Any]) -> [String: Any] {
        var erased = before
        erased["erasedRows"] = ["fromEpoch": 1, "ids": ((before["measurements"] as? [[String: Any]]) ?? []).compactMap { $0["id"] as? String }]
        erased["measurements"] = []
        var meta = before["meta"] as! [String: Any]
        meta["eraseEpoch"] = 1
        meta["erasedAt"] = "2026-10-21T09:00:00.000Z"
        meta["updatedAt"] = "2026-10-21T09:00:00.000Z"
        meta["lamport"] = ((meta["lamport"] as? Int) ?? 0) + 10
        erased["meta"] = meta
        return erased
    }
}
