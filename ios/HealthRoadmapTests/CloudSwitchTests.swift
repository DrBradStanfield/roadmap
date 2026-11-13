import XCTest
@testable import HealthRoadmap

/// US-25 AC11n (iPhone survey S3 PR 3, lead S24): the one-step cloud switch. Google Drive
/// holds the record (a read-only fake, enough to open and copy down) and the switch goes to
/// the fake Dropbox, which takes writes. A fresh CloudSync on the same folder and Keychain
/// plays the relaunch. Sign-ins and reads are held on gates, never a fixed delay.
@MainActor
final class CloudSwitchTests: XCTestCase, CloudFixtures {
    private var folder: URL!
    private var tokens: TokenStore!
    private var dropbox: CloudSyncTests.FakeDropbox!
    private var drive: CloudSyncTests.DriveOnFile!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Cloud Switch \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
        try tokens.save(OAuthTokens(accessToken: "token-g", refreshToken: "r-g", expiresAt: .distantFuture), for: .googleDrive)
        dropbox = CloudSyncTests.FakeDropbox()
        drive = CloudSyncTests.DriveOnFile(record: try record(days: ["2026-09-01"], device: "web"), dropbox: dropbox)
        drive.online = true
        answer()
    }

    override func tearDown() async throws {
        tokens.delete(.dropbox)
        tokens.delete(.googleDrive)
        try? FileManager.default.removeItem(at: folder)
    }

    /// Drive, Google's sign-in and the fake Dropbox; `dropboxToken` answers Dropbox's token exchange instead.
    private func answer(dropboxToken: StubHTTP.Answer? = nil) {
        let (drive, scope) = (drive!, CloudProvider.driveFileScope)
        StubHTTP.handler = { request in
            switch (request.url.host, request.url.path) {
            case ("oauth2.googleapis.com", "/token"):
                .init(body: Data(#"{"access_token":"token-g","refresh_token":"r-g2","expires_in":3600,"scope":"\#(scope)"}"#.utf8))
            case ("www.googleapis.com", "/drive/v3/about"):
                .init(body: Data(#"{"user":{"permissionId":"test-account-g"}}"#.utf8))
            case (_, "/oauth2/token") where dropboxToken != nil:
                dropboxToken!
            default:
                drive.answer(request)
            }
        }
    }

    /// An engine whose copy-down throws: it closes the session, then rejects, as an engine
    /// failing partway would. A close without the copy-down passes through.
    private func throwingEngine() throws -> HealthEngine {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let throwing = """
            HealthEngine = (function (e) {
              var o = Object.assign({}, e);
              o.cloudClose = function (copyDown) {
                if (!copyDown) return e.cloudClose(false);
                return e.cloudClose(false).then(function () { throw new Error('test-close-fails'); });
              };
              return o;
            })(HealthEngine);
            """
        return try HealthEngine(source: try String(contentsOf: url, encoding: .utf8) + "\n" + throwing, sourceURL: nil, session: StubHTTP.session())
    }

    /// The app's parts on the test folder, Google Drive on file.
    private func app(engine: HealthEngine? = nil) throws -> (store: RecordStore, sync: CloudSync) {
        if text("sync-provider") == nil { try Data("google-drive".utf8).write(to: folder.appending(path: "sync-provider")) }
        let engine = try engine ?? HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        return (store, CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session())))
    }

    /// Google Drive on file and its record open.
    private func driveOpen(engine: HealthEngine? = nil) async throws -> (store: RecordStore, sync: CloudSync) {
        let parts = try app(engine: engine)
        await parts.sync.start()
        XCTAssertTrue(parts.sync.recordOpen, "Drive's record is open")
        XCTAssertEqual(activeDays(parts.store.recordJSON), ["2026-09-01"])
        return parts
    }

    /// What a relaunch on the same folder and Keychain reads.
    private func relaunched() throws -> CloudSync {
        let engine = try HealthEngine(session: StubHTTP.session())
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "ios-test")
        return CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
    }

    private func text(_ name: String) -> String? {
        try? String(contentsOf: folder.appending(path: name), encoding: .utf8)
    }

    private let noSignIn: OAuthClient.Authenticate = { _, _ in
        XCTFail("no sign-in sheet shows")
        throw OAuthClient.Failure.cancelled
    }

    private let cancelledSignIn: OAuthClient.Authenticate = { _, _ in throw OAuthClient.Failure.cancelled }

    private let stopped = "Google Drive could not be reached, so your record there could not be copied to this iPhone. Try again once it answers."
    private let notConnected = "Google Drive is disconnected and Dropbox did not connect. Your record is on this iPhone only."

    /// Still on Google Drive, as a relaunch reads it: nothing removed and nothing of Dropbox kept.
    private func assertStillOnDrive(_ sync: CloudSync, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertEqual(sync.provider, .googleDrive, file: file, line: line)
        XCTAssertEqual(text("sync-provider"), "google-drive", file: file, line: line)
        XCTAssertEqual(tokens.load(.googleDrive)?.refreshToken, "r-g", "Drive's sign-in stays", file: file, line: line)
        XCTAssertNil(tokens.load(.dropbox), "no sign-in started", file: file, line: line)
        XCTAssertNil(dropbox.file, "nothing reached Dropbox", file: file, line: line)
        XCTAssertEqual(try relaunched().provider, .googleDrive, "a relaunch reads the same", file: file, line: line)
    }

    /// On the phone with the record whole, no cloud's tokens, and a Connect row for every cloud.
    private func assertOnThePhone(_ sync: CloudSync, _ store: RecordStore, file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertNil(sync.provider, file: file, line: line)
        XCTAssertEqual(sync.status, .onPhone, file: file, line: line)
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-09-01"], "the record copied down is whole", file: file, line: line)
        XCTAssertEqual(activeDays(try String(contentsOf: store.file, encoding: .utf8)), ["2026-09-01"], file: file, line: line)
        XCTAssertNil(tokens.load(.googleDrive), "the old cloud's tokens are gone", file: file, line: line)
        XCTAssertNil(tokens.load(.dropbox), file: file, line: line)
        XCTAssertNil(text("sync-provider"), file: file, line: line)
        XCTAssertNil(text("sync-account"), file: file, line: line)
        let phase = WelcomeConnect.phase(provider: sync.provider, status: sync.status, recordOpen: sync.recordOpen)
        XCTAssertEqual(phase, .choosing, file: file, line: line)
        XCTAssertTrue(WelcomeConnect.showsConnect(phase), "a Connect row for every cloud, the old one included", file: file, line: line)
        XCTAssertNil(try relaunched().provider, "a relaunch reads the same", file: file, line: line)
    }

    // MARK: The switch

    func testASwitchFromAnOpenCloudCopiesDownThenConnectsTheNewOne_US25_AC11n() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (store, sync) = try await driveOpen()
        guard case .moved = try await sync.switchTo(.dropbox, authenticate: signIn()) else { return XCTFail("the switch connects") }
        XCTAssertEqual(sync.provider, .dropbox)
        XCTAssertTrue(sync.recordOpen)
        XCTAssertEqual(activeDays(dropbox.record), ["2026-09-01", "2026-10-01"], "Drive's record was copied down, then lifted into Dropbox")
        XCTAssertEqual(activeDays(store.recordJSON), ["2026-09-01", "2026-10-01"])
        XCTAssertNil(tokens.load(.googleDrive), "the old cloud is signed out")
        XCTAssertEqual(text("sync-provider"), "dropbox")
        XCTAssertEqual(text("sync-account"), "dbid:A")
        XCTAssertEqual(sync.syncedBefore, .dropbox)
        XCTAssertEqual(try relaunched().provider, .dropbox)
        XCTAssertEqual(drive.unexpected, [], "nothing was written to Drive")
    }

    /// Owner D1 (a): the copy-down could not reach the cloud with a session open.
    func testASwitchStopsWhenTheCloudCannotBeReached_US25_AC11n() async throws {
        let (_, sync) = try await driveOpen()
        drive.online = false
        let outcome = try await sync.switchTo(.dropbox, authenticate: noSignIn)
        guard case .stopped(.unreachable) = outcome else { return XCTFail("the switch stops: \(outcome)") }
        XCTAssertEqual(SyncStatusText.switchEnded(outcome, from: .googleDrive, to: .dropbox, connected: sync.provider), stopped)
        try assertStillOnDrive(sync)
    }

    /// US-25 AC16i (S50b): an erase made here that Drive has not taken, over a passing failure,
    /// stops a switch before anything closes: the session stays open, no sign-in starts.
    func testASwitchWaitsWhileAnEraseIsUnsentOverAPassingFailure_US25_AC16i() async throws {
        let (_, sync) = try await driveOpen()
        // The erase reads the record, then Drive stops answering, as a dead network does.
        drive.onMedia = { [drive] in drive?.online = false }
        let erased = try await sync.erase(chatHistory: nil) { _ in true }
        XCTAssertEqual(erased?.success, false)
        XCTAssertEqual(erased?.erased, true, "made here, not sent")
        let outcome = try await sync.switchTo(.dropbox, authenticate: noSignIn)
        guard case .stopped(.eraseUnsent) = outcome else { return XCTFail("the switch waits on the erase: \(outcome)") }
        XCTAssertEqual(SyncStatusText.switchEnded(outcome, from: .googleDrive, to: .dropbox, connected: sync.provider), EraseText.unsent(.googleDrive))
        guard case .open = sync.connection else { return XCTFail("nothing closed: \(sync.connection)") }
        try assertStillOnDrive(sync)
    }

    /// Owner's ruling: an engine throw during a switch's copy-down is a stop too.
    func testASwitchStopsWhenTheEngineThrowsOnTheCopyDown_US25_AC11n() async throws {
        let (_, sync) = try await driveOpen(engine: try throwingEngine())
        let outcome = try await sync.switchTo(.dropbox, authenticate: noSignIn)
        guard case .stopped(.unreachable) = outcome else { return XCTFail("the switch stops: \(outcome)") }
        XCTAssertEqual(SyncStatusText.switchEnded(outcome, from: .googleDrive, to: .dropbox, connected: sync.provider), stopped)
        XCTAssertTrue(sync.recordOpen, "the record opens again")
        try assertStillOnDrive(sync)
    }

    /// A plain Disconnect never stops (US-25 AC11m): not on an unreachable cloud, not on a throw.
    func testADisconnectGoesOnWhenTheCloudCannotBeReachedOrTheEngineThrows_US25_AC11n() async throws {
        let (store, sync) = try await driveOpen()
        drive.online = false
        let unreachable = await sync.disconnectOutcome()
        XCTAssertEqual(unreachable, .done(copied: false))
        try assertOnThePhone(sync, store)

        try Data("google-drive".utf8).write(to: folder.appending(path: "sync-provider"))
        try tokens.save(OAuthTokens(accessToken: "token-g", refreshToken: "r-g", expiresAt: .distantFuture), for: .googleDrive)
        drive.online = true
        let (thrown, throwing) = try await driveOpen(engine: try throwingEngine())
        let thrownOutcome = await throwing.disconnectOutcome()
        XCTAssertEqual(thrownOutcome, .done(copied: false))
        try assertOnThePhone(throwing, thrown)
    }

    /// Never on "none": with no session open (a failed open) the switch goes on.
    func testASwitchWithNoSessionOpenNeverStops_US25_AC11n() async throws {
        drive.online = false
        let (store, sync) = try app()
        await sync.start()
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)))
        guard case .moved = try await sync.switchTo(.dropbox, authenticate: signIn()) else { return XCTFail("the switch connects") }
        XCTAssertEqual(sync.provider, .dropbox)
        XCTAssertNil(tokens.load(.googleDrive))
        XCTAssertEqual(activeDays(store.recordJSON), [], "the phone's record, which never held Drive's, went up")
    }

    // MARK: Condition 1: the new cloud's sign-in does not finish

    func testACancelledSignInAfterTheDisconnectLeavesTheRecordOnThePhone_US25_AC11n() async throws {
        let (store, sync) = try await driveOpen()
        let outcome = try await sync.switchTo(.dropbox, authenticate: cancelledSignIn)
        guard case .failed(let error) = outcome else { return XCTFail("disconnected, then the connect threw: \(outcome)") }
        XCTAssertEqual(error as? OAuthClient.Failure, .cancelled)
        XCTAssertEqual(SyncStatusText.switchEnded(outcome, from: .googleDrive, to: .dropbox, connected: sync.provider), notConnected)
        try assertOnThePhone(sync, store)
    }

    func testAFailedSignInAfterTheDisconnectSaysItsErrorThenWhereTheRecordIs_US25_AC11n() async throws {
        let (store, sync) = try await driveOpen()
        answer(dropboxToken: .init(status: 500))
        let outcome = try await sync.switchTo(.dropbox, authenticate: signIn())
        guard case .failed(let error) = outcome else { return XCTFail("disconnected, then the connect threw: \(outcome)") }
        XCTAssertEqual(error.localizedDescription, "Dropbox sign-in failed (500). Try again.")
        XCTAssertEqual(SyncStatusText.switchEnded(outcome, from: .googleDrive, to: .dropbox, connected: sync.provider),
                       "Dropbox sign-in failed (500). Try again. " + notConnected)
        try assertOnThePhone(sync, store)
    }

    // MARK: Condition 3: a second tap while a switch runs

    func testASecondSwitchOrConnectWhileTheFirstClosesIsRefused_US25_AC11n() async throws {
        let (_, sync) = try await driveOpen()
        let gate = StubHTTP.Gate()
        let (reading, read) = AsyncStream.makeStream(of: Void.self)
        drive.mediaGate = gate
        drive.onMedia = { read.yield() }
        let authenticate = signIn()
        let first = Task { try await sync.switchTo(.dropbox, authenticate: authenticate) }
        for await _ in reading { break } // the copy-down
        XCTAssertEqual(sync.status, .disconnecting)
        let second = try await sync.switchTo(.dropbox, authenticate: noSignIn)
        guard case .stopped(.refused) = second else { return XCTFail("refused by the closing cell: \(second)") }
        XCTAssertNil(SyncStatusText.switchEnded(second, from: .googleDrive, to: .dropbox, connected: sync.provider), "said silently")
        do {
            try await sync.connect(.dropbox, authenticate: noSignIn)
            XCTFail("a connect while closing is dropped")
        } catch {
            XCTAssertEqual(error as? OAuthClient.Failure, .cancelled)
        }
        gate.open()
        guard case .moved = try await first.value else { return XCTFail("the first switch goes on") }
        XCTAssertEqual(sync.provider, .dropbox)
        XCTAssertTrue(sync.recordOpen)
    }

    /// During the switch's own sign-in no cloud is connected: another switch is refused, and a
    /// Connect's sign-in that wins the race is kept while the switch's is dropped by its cell.
    func testASwitchOrConnectDuringASwitchsSignInIsSettledByTheState_US25_AC11n() async throws {
        dropbox.put(try record(days: ["2026-10-01"], device: "web"))
        let (_, sync) = try await driveOpen()
        let switching = heldSignIn()
        let first = Task { try await sync.switchTo(.dropbox, authenticate: switching.authenticate) }
        for await _ in switching.shown { break }
        XCTAssertNil(sync.provider)
        let second = try await sync.switchTo(.dropbox, authenticate: noSignIn)
        guard case .stopped(.refused) = second else { return XCTFail("no cloud to switch from: \(second)") }
        let connecting = heldSignIn()
        let connect = Task { try await sync.connect(.dropbox, authenticate: connecting.authenticate) }
        for await _ in connecting.shown { break }
        connecting.release()
        try await connect.value
        XCTAssertEqual(sync.provider, .dropbox)
        switching.release()
        let outcome = try await first.value
        guard case .failed(let error) = outcome else { return XCTFail("the switch's late sign-in is dropped: \(outcome)") }
        XCTAssertEqual(error as? OAuthClient.Failure, .cancelled)
        XCTAssertNil(SyncStatusText.switchEnded(outcome, from: .googleDrive, to: .dropbox, connected: sync.provider),
                     "Dropbox is connected, so the on-the-phone sentence would be false")
        XCTAssertEqual(sync.provider, .dropbox)
        XCTAssertTrue(sync.recordOpen)
    }

    // MARK: US-54 AC2d: Sign in again, then a switch

    /// A sign-in to the old cloud still under way when a switch runs is voided by its
    /// Disconnect: it never connects the account signed in with, and keeps no tokens.
    func testASignInAgainVoidedByASwitchKeepsNothing_US54_AC2d() async throws {
        drive.online = false
        let (_, sync) = try app()
        await sync.start()
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)), "the welcome sheet at failed")
        let again = heldSignIn()
        let signingIn = Task { try await sync.connect(.googleDrive, authenticate: again.authenticate) }
        for await _ in again.shown { break }
        guard case .moved = try await sync.switchTo(.dropbox, authenticate: signIn()) else { return XCTFail("the switch connects") }
        again.release()
        do {
            try await signingIn.value
            XCTFail("the voided sign-in never connects")
        } catch {
            XCTAssertEqual(error as? OAuthClient.Failure, .cancelled, "dropped silently")
        }
        XCTAssertEqual(sync.provider, .dropbox)
        XCTAssertNil(tokens.load(.googleDrive), "the voided sign-in's tokens were not kept")
        XCTAssertEqual(text("sync-provider"), "dropbox")
        XCTAssertEqual(text("sync-account"), "dbid:A")
    }

    // MARK: R2: the dialog promises a copy only when a session is open to copy from

    private let copies = "Your record in Google Drive stays there as it is. This iPhone copies it, connects Dropbox, and saves there from now on."
    private let copiesNothing = "Your record in Google Drive stays there as it is. This iPhone connects Dropbox and saves there from now on."

    /// The record open: the dialog says it copies, and the switch does copy. A day added to
    /// Drive's file after the open reaches the phone through the copy-down.
    func testWithTheRecordOpenTheDialogPromisesACopyAndTheSwitchCopies_US25_AC11n() async throws {
        let (store, sync) = try await driveOpen()
        XCTAssertEqual(SyncStatusText.switchMessage(from: .googleDrive, to: .dropbox, recordOpen: sync.recordOpen), copies)
        drive.text = String(decoding: try JSONSerialization.data(withJSONObject: try record(days: ["2026-09-01", "2026-09-15"], device: "web")), as: UTF8.self)
        guard case .failed = try await sync.switchTo(.dropbox, authenticate: cancelledSignIn) else { return XCTFail("disconnected, then cancelled") }
        XCTAssertEqual(activeDays(try String(contentsOf: store.file, encoding: .utf8)), ["2026-09-01", "2026-09-15"], "copied down")
    }

    /// No session open (the welcome sheet's failed): the dialog promises no copy, and the switch
    /// copies nothing, though Drive answers by then: its close answers 'none'.
    func testWithNoSessionOpenTheDialogPromisesNoCopyAndTheSwitchCopiesNothing_US25_AC11n() async throws {
        drive.online = false
        let (store, sync) = try app()
        await sync.start()
        XCTAssertEqual(sync.status, .problem(SyncProblem(kind: .unreachable)), "the welcome sheet at failed")
        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 79, day: "2026-10-02")))
        XCTAssertEqual(SyncStatusText.switchMessage(from: .googleDrive, to: .dropbox, recordOpen: sync.recordOpen), copiesNothing)
        drive.online = true
        let before = try Data(contentsOf: store.file)
        guard case .failed = try await sync.switchTo(.dropbox, authenticate: cancelledSignIn) else { return XCTFail("disconnected, then cancelled") }
        XCTAssertEqual(try Data(contentsOf: store.file), before, "nothing was copied")
        XCTAssertEqual(activeDays(try String(contentsOf: store.file, encoding: .utf8)), ["2026-10-02"], "the phone's own record, without Drive's day")
    }

    // MARK: R1: the sign-in belongs to the screen, which stays through the switch

    /// Structural only: the row keeps no web sign-in session of its own, and the two screens
    /// that draw it each hold one. It cannot show that SwiftUI keeps a session alive while
    /// the row goes; only a real switch on a device shows that.
    func testTheSwitchRowsSignInIsTheScreens_US25_AC11n() throws {
        let (_, sync) = try app()
        let ownsSession = { (view: Any) in
            Mirror(reflecting: view).children.contains { String(describing: type(of: $0.value)).contains("WebAuthenticationSession") }
        }
        let row = SwitchCloudRow(sync: sync, provider: .dropbox, authenticate: cancelledSignIn, message: .constant(nil))
        XCTAssertFalse(ownsSession(row), "the row reads no session it would take with it")
        XCTAssertTrue(ownsSession(SyncView(sync: sync)), "Sync, which stays, holds it")
        XCTAssertTrue(ownsSession(WelcomeView(sync: sync, start: {})), "the welcome screen, which stays, holds it")
    }

    // MARK: The words (owner-approved, exact)

    func testTheSwitchWords_US25_AC11n() {
        XCTAssertEqual(SyncStatusText.switchRow(.dropbox), "Switch to Dropbox")
        XCTAssertEqual(SyncStatusText.switchRow(.googleDrive), "Switch to Google Drive")
        XCTAssertEqual(SyncStatusText.switchMessage(from: .googleDrive, to: .dropbox, recordOpen: true), copies)
        XCTAssertEqual(SyncStatusText.switchMessage(from: .dropbox, to: .googleDrive, recordOpen: true),
                       "Your record in Dropbox stays there as it is. This iPhone copies it, connects Google Drive, and saves there from now on.")
        XCTAssertEqual(SyncStatusText.switchMessage(from: .googleDrive, to: .dropbox, recordOpen: false), copiesNothing)
        XCTAssertEqual(SyncStatusText.switchMessage(from: .dropbox, to: .googleDrive, recordOpen: false),
                       "Your record in Dropbox stays there as it is. This iPhone connects Google Drive and saves there from now on.")
        typealias Outcome = CloudSync.SwitchOutcome
        let words = { (outcome: Outcome, connected: CloudProvider?) in
            SyncStatusText.switchEnded(outcome, from: .dropbox, to: .googleDrive, connected: connected)
        }
        XCTAssertEqual(words(.stopped(.unreachable), .dropbox),
                       "Dropbox could not be reached, so your record there could not be copied to this iPhone. Try again once it answers.")
        XCTAssertEqual(words(.stopped(.failed), .dropbox), "Couldn't disconnect from Dropbox. Try again.")
        XCTAssertNil(words(.stopped(.refused), .dropbox))
        XCTAssertNil(words(.moved, .googleDrive))
        let sentence = "Dropbox is disconnected and Google Drive did not connect. Your record is on this iPhone only."
        XCTAssertEqual(words(.failed(OAuthClient.Failure.cancelled), nil), sentence)
        XCTAssertEqual(words(.failed(OAuthClient.Failure.unreachable("Google Drive did not answer. Check the connection and try again.")), nil),
                       "Google Drive did not answer. Check the connection and try again. " + sentence)
        // Another cloud connected meanwhile: only the error's own words, never the false sentence.
        XCTAssertNil(words(.failed(OAuthClient.Failure.cancelled), .dropbox))
        XCTAssertEqual(words(.failed(OAuthClient.Failure.refused("Disconnect from Dropbox first, then connect Google Drive.")), .dropbox),
                       "Disconnect from Dropbox first, then connect Google Drive.")
    }
}
