import XCTest
@testable import HealthRoadmap

/// US-54 AC2b (iPhone survey S2): the welcome screen's cloud connect reads its phase
/// from CloudSync and keeps no copy, so a relaunch with a cloud connected waits on
/// the launch open instead of saying it failed, and goes on once it lands.
@MainActor
final class WelcomeConnectTests: XCTestCase {
    private typealias Phase = WelcomeConnect.Phase
    private let unreachable = SyncProblem(kind: .unreachable)

    func testEveryStatusHasAPhase_US54_AC2b() {
        let statuses: [CloudSync.Status] = [.onPhone, .connecting, .synced(.now), .saving, .problem(unreachable), .disconnecting]
        // With a cloud and no open record: an open shows as opening, a failure as failed,
        // a Disconnect closing as choosing, where it ends (US-25 AC11m).
        let connected: [Phase] = [.opening, .opening, .opening, .opening, .failed(unreachable), .choosing]
        for (status, expected) in zip(statuses, connected) {
            XCTAssertEqual(WelcomeConnect.phase(provider: .dropbox, status: status, recordOpen: false), expected, "\(status)")
            // An open record wins over any status.
            XCTAssertEqual(WelcomeConnect.phase(provider: .dropbox, status: status, recordOpen: true), .opened, "\(status)")
            // No cloud: the person chooses one.
            XCTAssertEqual(WelcomeConnect.phase(provider: nil, status: status, recordOpen: false), .choosing, "\(status)")
            XCTAssertEqual(WelcomeConnect.phase(provider: nil, status: status, recordOpen: true), .opened, "\(status)")
        }
    }

    /// No second cloud can be chosen while a record opens, nor at failed, where a cloud is
    /// still connected (US-25 AC11l, US-54 AC2d).
    func testTheConnectButtonsHideWhileARecordOpens_US54_AC2b() {
        let rows: [(Phase, Bool)] = [(.choosing, true), (.opening, false), (.failed(unreachable), false), (.opened, false)]
        for (phase, shows) in rows {
            XCTAssertEqual(WelcomeConnect.showsConnect(phase), shows, "\(phase)")
        }
    }

    /// US-54 AC2d (review of PR 1329): at failed, and only there, the sheet shows one row to
    /// sign in to the connected cloud again and "Use a different cloud".
    func testOnlyAFailedOpenOffersSignInAgainAndADifferentCloud_US54_AC2d() {
        let rows: [(Phase, Bool)] = [(.choosing, false), (.opening, false), (.failed(unreachable), true), (.opened, false)]
        for (phase, shows) in rows {
            XCTAssertEqual(WelcomeConnect.showsRecovery(phase), shows, "\(phase)")
        }
        for kind in SyncProblem.Kind.allCases {
            XCTAssertTrue(WelcomeConnect.showsRecovery(.failed(SyncProblem(kind: kind))), "\(kind)")
        }
    }

    func testWhatEachTapDoes_US54_AC2b() {
        typealias D = WelcomeConnect.Decision
        let phases: [Phase] = [.choosing, .opening, .failed(unreachable), .opened]
        // (event, sheet shown, a connect error's alert up, decision per phase)
        let rows: [(WelcomeConnect.Event, Bool, Bool, [D])] = [
            (.getStarted, false, false, [.start, .showSheetAndOpen, .showSheetAndOpen, .goOn]),
            (.existing, false, false, [.showSheet, .showSheetAndOpen, .showSheetAndOpen, .goOn]),
            (.tryAgain, true, false, [.nothing, .open, .open, .nothing]),
            (.phaseChanged, true, false, [.nothing, .nothing, .nothing, .goOn]),
            (.phaseChanged, false, false, [.nothing, .nothing, .nothing, .nothing]),
            // US-25 AC11j: an alert on the sheet holds it; its dismissal goes on instead.
            (.phaseChanged, true, true, [.nothing, .nothing, .nothing, .nothing]),
            (.alertDismissed, true, false, [.nothing, .nothing, .nothing, .goOn]),
            (.alertDismissed, false, false, [.nothing, .nothing, .nothing, .nothing]),
            // US-54 AC2d: "Use a different cloud" disconnects, at failed only; the sheet stays.
            (.useDifferentCloud, true, false, [.nothing, .nothing, .disconnect, .nothing]),
            (.useDifferentCloud, true, true, [.nothing, .nothing, .disconnect, .nothing]),
        ]
        for (event, sheetShown, alertShown, expected) in rows {
            for (phase, decision) in zip(phases, expected) {
                XCTAssertEqual(WelcomeConnect.decide(event, phase: phase, sheetShown: sheetShown, alertShown: alertShown), decision,
                               "\(event) \(phase) sheet \(sheetShown) alert \(alertShown)")
            }
        }
    }

    /// The relaunch: a cloud on file and the launch open under way (or not yet begun:
    /// `.connecting` is set at init, before `start()` runs). Get started opens the sheet
    /// and starts an open; it never says the open failed.
    func testGetStartedDuringTheLaunchOpenStartsAnOpen_US54_AC2b() {
        let phase = WelcomeConnect.phase(provider: .dropbox, status: .connecting, recordOpen: false)
        XCTAssertEqual(phase, .opening)
        XCTAssertEqual(WelcomeConnect.decide(.getStarted, phase: phase, sheetShown: false, alertShown: false), .showSheetAndOpen)
    }

    /// Going on closes the sheet, so it happens once: an open that lands with the sheet
    /// closed does nothing, Get started then goes on, and a later change decides nothing.
    func testTheScreenGoesOnOnce_US54_AC2b() {
        XCTAssertEqual(WelcomeConnect.decide(.phaseChanged, phase: .opened, sheetShown: false, alertShown: false), .nothing)
        XCTAssertEqual(WelcomeConnect.decide(.getStarted, phase: .opened, sheetShown: false, alertShown: false), .goOn)
        XCTAssertEqual(WelcomeConnect.decide(.phaseChanged, phase: .opened, sheetShown: true, alertShown: false), .goOn)
        // After goOn the sheet is closed.
        XCTAssertEqual(WelcomeConnect.decide(.phaseChanged, phase: .opened, sheetShown: false, alertShown: false), .nothing)
    }

    /// US-25 AC11j (review of PR 1295): a connect refused while the record opened leaves its
    /// alert on the sheet. The open landing does not close the sheet under it; dismissing the
    /// alert goes on, once, and a later change with the sheet closed decides nothing.
    func testARefusalAlertHoldsTheSheetUntilDismissed_US25_AC11j() {
        XCTAssertEqual(WelcomeConnect.decide(.phaseChanged, phase: .opened, sheetShown: true, alertShown: true), .nothing)
        XCTAssertEqual(WelcomeConnect.decide(.alertDismissed, phase: .opened, sheetShown: true, alertShown: false), .goOn)
        // goOn closed the sheet.
        XCTAssertEqual(WelcomeConnect.decide(.phaseChanged, phase: .opened, sheetShown: false, alertShown: false), .nothing)
        XCTAssertEqual(WelcomeConnect.decide(.alertDismissed, phase: .opened, sheetShown: false, alertShown: false), .nothing)
    }

    /// US-54 AC2c: a failed open says what the Sync screen says for that problem, from the same
    /// source, except a cloud that could not be reached, which keeps AC2's sentence. Try again
    /// shows only where trying again can help: a revoked sign-in needs the Connect rows, a
    /// newer app's record an update; a full cloud's Try again checks the freed space.
    func testTheFailedRowSaysEachProblemInTheSyncScreensWords_US54_AC2c() {
        let sentence = "Signed in, but your record could not be opened yet. Check your connection, then try again."
        // (kind, the Sync screen's words or nil for AC2's sentence, Try again)
        let rows: [(SyncProblem.Kind, Bool, Bool)] = [
            (.unreachable, false, true),
            (.busy, true, true),
            (.signIn, true, false),
            (.tooNew, true, false),
            (.storageFull, true, true),
        ]
        XCTAssertEqual(Set(rows.map(\.0)), Set(SyncProblem.Kind.allCases), "one row per kind")
        for provider in CloudProvider.allCases {
            for (kind, syncWords, tryAgain) in rows {
                let problem = SyncProblem(kind: kind)
                let failure = WelcomeConnect.failure(problem, provider: provider)
                let expected = syncWords ? SyncStatusText.detail(.problem(problem), provider: provider) : sentence
                XCTAssertEqual(failure.words, expected, "\(kind) \(provider)")
                XCTAssertEqual(failure.offersTryAgain, tryAgain, "\(kind)")
            }
        }
    }

    // MARK: Through the real CloudSync, on a stubbed Dropbox

    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Welcome Connect \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-1", refreshToken: "r", expiresAt: .distantFuture), for: .dropbox)
        dropbox = CloudSyncTests.FakeDropbox()
        let fake = dropbox!
        StubHTTP.handler = { fake.answer($0) }
        let engine = try HealthEngine()
        let now = Date(timeIntervalSince1970: 1_792_000_000)
        let json = try engine.blocking { try $0.newRecord(now: now, deviceId: "web", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        dropbox.put(try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any])
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        try? FileManager.default.removeItem(at: folder)
    }

    /// The app after a relaunch: a cloud already on file.
    private func relaunched() throws -> CloudSync {
        try Data("dropbox".utf8).write(to: folder.appending(path: "sync-provider"))
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        return CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
    }

    private func phase(_ sync: CloudSync) -> Phase {
        WelcomeConnect.phase(provider: sync.provider, status: sync.status, recordOpen: sync.recordOpen)
    }

    func testARelaunchShowsOpeningThenOpened_US54_AC2b() async throws {
        let sync = try relaunched()
        XCTAssertEqual(phase(sync), .opening)
        await sync.start()
        XCTAssertEqual(phase(sync), .opened)
    }

    /// Get started's open, asked for while the launch open runs, returns at once
    /// (single-flight): the phase stays opening, then turns opened when the launch open lands.
    func testGetStartedDuringTheLaunchOpenWaitsForIt_US54_AC2b() async throws {
        dropbox.downloadDelay = 0.4
        let sync = try relaunched()
        let launch = Task { await sync.start() }
        try await Task.sleep(for: .milliseconds(100))
        await sync.foreground()
        XCTAssertEqual(phase(sync), .opening, "not failed while the launch open runs")
        await launch.value
        XCTAssertEqual(phase(sync), .opened)
    }

    /// No copy of an old failure: the phase follows the cloud through Try again.
    func testTryAgainAfterAFailedOpenFollowsTheCloud_US54_AC2b() async throws {
        dropbox.online = false
        let sync = try relaunched()
        await sync.start()
        XCTAssertEqual(phase(sync), .failed(unreachable))
        dropbox.online = true
        await sync.foreground()
        XCTAssertEqual(phase(sync), .opened)
    }
}
