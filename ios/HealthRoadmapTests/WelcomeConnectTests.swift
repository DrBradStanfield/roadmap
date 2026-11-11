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
        let statuses: [CloudSync.Status] = [.onPhone, .connecting, .synced(.now), .saving, .problem(unreachable)]
        // With a cloud and no open record: an open shows as opening, a failure as failed.
        let connected: [Phase] = [.opening, .opening, .opening, .opening, .failed(unreachable)]
        for (status, expected) in zip(statuses, connected) {
            XCTAssertEqual(WelcomeConnect.phase(provider: .dropbox, status: status, recordOpen: false), expected, "\(status)")
            // An open record wins over any status.
            XCTAssertEqual(WelcomeConnect.phase(provider: .dropbox, status: status, recordOpen: true), .opened, "\(status)")
            // No cloud: the person chooses one.
            XCTAssertEqual(WelcomeConnect.phase(provider: nil, status: status, recordOpen: false), .choosing, "\(status)")
            XCTAssertEqual(WelcomeConnect.phase(provider: nil, status: status, recordOpen: true), .opened, "\(status)")
        }
    }

    func testWhatEachTapDoes_US54_AC2b() {
        typealias D = WelcomeConnect.Decision
        let phases: [Phase] = [.choosing, .opening, .failed(unreachable), .opened]
        let rows: [(WelcomeConnect.Event, Bool, [D])] = [
            (.getStarted, false, [.start, .showSheetAndOpen, .showSheetAndOpen, .goOn]),
            (.existing, false, [.showSheet, .showSheetAndOpen, .showSheetAndOpen, .goOn]),
            (.tryAgain, true, [.nothing, .open, .open, .nothing]),
            (.phaseChanged, true, [.nothing, .nothing, .nothing, .goOn]),
            (.phaseChanged, false, [.nothing, .nothing, .nothing, .nothing]),
        ]
        for (event, sheetShown, expected) in rows {
            for (phase, decision) in zip(phases, expected) {
                XCTAssertEqual(WelcomeConnect.decide(event, phase: phase, sheetShown: sheetShown), decision, "\(event) \(phase) sheet \(sheetShown)")
            }
        }
    }

    /// The relaunch: a cloud on file and the launch open under way (or not yet begun:
    /// `.connecting` is set at init, before `start()` runs). Get started opens the sheet
    /// and starts an open; it never says the open failed.
    func testGetStartedDuringTheLaunchOpenStartsAnOpen_US54_AC2b() {
        let phase = WelcomeConnect.phase(provider: .dropbox, status: .connecting, recordOpen: false)
        XCTAssertEqual(phase, .opening)
        XCTAssertEqual(WelcomeConnect.decide(.getStarted, phase: phase, sheetShown: false), .showSheetAndOpen)
    }

    /// Going on closes the sheet, so it happens once: an open that lands with the sheet
    /// closed does nothing, Get started then goes on, and a later change decides nothing.
    func testTheScreenGoesOnOnce_US54_AC2b() {
        XCTAssertEqual(WelcomeConnect.decide(.phaseChanged, phase: .opened, sheetShown: false), .nothing)
        XCTAssertEqual(WelcomeConnect.decide(.getStarted, phase: .opened, sheetShown: false), .goOn)
        XCTAssertEqual(WelcomeConnect.decide(.phaseChanged, phase: .opened, sheetShown: true), .goOn)
        // After goOn the sheet is closed.
        XCTAssertEqual(WelcomeConnect.decide(.phaseChanged, phase: .opened, sheetShown: false), .nothing)
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
