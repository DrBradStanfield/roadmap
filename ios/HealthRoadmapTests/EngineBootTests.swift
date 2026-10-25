import SwiftUI
import XCTest
@testable import HealthRoadmap

/// US-25 AC18: which engine runs at launch. A staged engine runs only after it is
/// checked again and passes its quarantined self-test; a failure, a crash during its
/// trial, or a tampered file falls back to the bundled engine.
@MainActor
final class EngineBootTests: XCTestCase {
    private var fixture: EngineReleaseFixture!
    private var folder: EngineFolder!

    override func setUpWithError() throws {
        fixture = try EngineReleaseFixture()
        folder = try EngineReleaseFixture.folder()
    }

    private func boot(foreground: Bool = true) async throws -> EngineBoot.Choice {
        try await EngineBoot(folder: folder, bundled: fixture.bundled, keys: fixture.keys, appBuild: 5, session: StubHTTP.session(), foreground: foreground).start()
    }

    private func version(_ choice: EngineBoot.Choice) throws -> Int? {
        try choice.engine.blocking { try $0.evaluate("HealthEngine.engineVersion").toNumber()?.intValue }
    }

    func testAStagedEngineRunsAfterItsSelfTest() async throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        let choice = try await boot()
        XCTAssertEqual(choice.version, release.version)
        XCTAssertEqual(try version(choice), release.version)
        XCTAssertEqual(try folder.readState(bundled: 0).trying, release.version, "on trial until the user's record is shown")
        XCTAssertEqual(try folder.readState(bundled: 0).proven, [])
        choice.engine.trial?.confirm()
        let state = try folder.readState(bundled: 0)
        XCTAssertNil(state.trying, "the trial finished")
        XCTAssertEqual(state.proven, [release.version])
    }

    func testALaunchThatEndsBeforeTheRecordIsShownCountsAgainstTheEngine() async throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        let launch1 = try await boot()
        XCTAssertEqual(launch1.version, release.version) // never confirmed: a hang on the real record
        let launch2 = try await boot()
        XCTAssertNil(launch2.version)
        XCTAssertEqual(try folder.readState(bundled: 0).bad, [release.version])
    }

    func testABackgroundLaunchLeavesAnOpenTrialForTheNextForegroundOne() async throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        _ = try await boot()
        let launch3 = try await boot(foreground: false)
        XCTAssertNil(launch3.version, "not proven, so not run in the background")
        XCTAssertEqual(try folder.readState(bundled: 0).trying, release.version)
        XCTAssertEqual(try folder.readState(bundled: 0).bad, [])
    }

    /// The trial confirms in one place: the store, once it has drawn the user's own record
    /// and its plan (here health-core's PlanError), whichever tab is open, and on any later
    /// draw (a unit switch) had the first one failed.
    func testTheStoreConfirmsATrialOnceItDrawsTheRecord() async throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        let choice = try await boot()
        XCTAssertNotNil(choice.engine.trial)
        let records = FileManager.default.temporaryDirectory.appending(path: "data trial \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: records, withIntermediateDirectories: true)
        let store = try RecordStore(folder: records, engine: choice.engine, deviceId: "test")
        XCTAssertNotNil(store.myData, "the engine read the user's record")
        XCTAssertNil(try folder.readState(bundled: 0).trying)
        XCTAssertEqual(try folder.readState(bundled: 0).proven, [release.version])
        await XCTAssertSaved(await store.apply(.profile(sex: "male", birthYear: 1975, birthMonth: 6, height: 178)))
        XCTAssertEqual(try folder.readState(bundled: 0).proven, [release.version], "a later draw changes nothing")
    }

    /// Review R5: a plan screen whose engine threw on the user's record never confirms.
    func testThePlanScreenNeverConfirmsAnEngineThatThrewOnTheRecord() async throws {
        let release = fixture.staged(daysAfterBundled: 2, throwsOnRealRecords: true)
        try folder.stage(release)
        let choice = try await boot()
        XCTAssertEqual(choice.version, release.version, "it passed its self-test")
        let records = FileManager.default.temporaryDirectory.appending(path: "plan throws \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: records, withIntermediateDirectories: true)
        let store = try RecordStore(folder: records, engine: choice.engine, deviceId: "test")
        let shown = store.recordJSON
        XCTAssertThrowsError(try choice.engine.blocking { try $0.plan(recordJSON: shown, now: .now, deviceId: "test") })
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = UIHostingController(rootView: PlanView(store: store, showMyData: {}))
        window.makeKeyAndVisible()
        try await Task.sleep(for: .seconds(2))
        XCTAssertEqual(try folder.readState(bundled: 0).trying, release.version, "still on trial")
        XCTAssertEqual(try folder.readState(bundled: 0).proven, [])
        window.isHidden = true
        let launch4 = try await boot()
        XCTAssertNil(launch4.version, "the next launch counts it against the engine")
    }

    /// Review R8: missing fields take defaults; a corrupt file is moved aside, not "locked".
    func testAStateWithMissingFieldsDecodesWithDefaults() async throws {
        try Data(#"{"highWater":7}"#.utf8).write(to: folder.url.appending(path: "state.json"))
        let state = try folder.readState(bundled: 0)
        XCTAssertEqual(state.highWater, 7)
        XCTAssertEqual(state.bad, [])
        XCTAssertNil(state.trying)
    }

    func testACorruptStateStartsAgainAboveTheBundledEngine() async throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        try Data("{not json".utf8).write(to: folder.url.appending(path: "state.json"))
        let choice = try await boot()
        XCTAssertNil(choice.version, "a rebuilt state runs no download: every staged version is deleted")
        XCTAssertEqual(folder.stagedVersions(), [])
        let names = try FileManager.default.contentsOfDirectory(atPath: folder.url.path(percentEncoded: false))
        XCTAssertEqual(names.filter { $0.hasPrefix("state.corrupt-") }.count, 1, "the corrupt file is kept aside")
        XCTAssertEqual(try folder.readState(bundled: 0).highWater, fixture.bundled.facts.version)
    }

    /// Review N5: the watermarks live in the Keychain too, so a corrupt state file
    /// cannot lower the floor or bring back a revoked version.
    func testACorruptStateKeepsTheFloorAndRunsNoRevokedVersion() async throws {
        let revoked = fixture.staged(daysAfterBundled: 2)
        let newer = fixture.version(daysAfterBundled: 3).version
        try folder.stage(revoked)
        var state = EngineFolder.State()
        state.highWater = newer
        state.floor = newer // a release raised the floor above `revoked`
        try folder.write(state)
        try Data("{not json".utf8).write(to: folder.url.appending(path: "state.json"))
        let launch5 = try await boot()
        XCTAssertNil(launch5.version, "the revoked version never runs")
        let after = try folder.readState(bundled: 0)
        XCTAssertEqual(after.floor, newer)
        XCTAssertEqual(after.highWater, newer)
        XCTAssertEqual(folder.stagedVersions(), [])
    }

    /// Review N1: the store's confirm needs the record planned; an engine whose plan throws is never proven.
    func testTheStoreNeverConfirmsAnEngineWhosePlanThrows() async throws {
        let release = fixture.staged(daysAfterBundled: 2, throwsOnRealRecords: true)
        try folder.stage(release)
        let choice = try await boot()
        let records = FileManager.default.temporaryDirectory.appending(path: "data throws \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: records, withIntermediateDirectories: true)
        let store = try RecordStore(folder: records, engine: choice.engine, deviceId: "test")
        XCTAssertNotNil(store.myData, "My data drew the record")
        XCTAssertEqual(try folder.readState(bundled: 0).trying, release.version, "still on trial")
        XCTAssertEqual(try folder.readState(bundled: 0).proven, [])
    }

    func testTheNewestOfTwoRuns() async throws {
        let older = fixture.staged(daysAfterBundled: 1)
        let newer = fixture.staged(daysAfterBundled: 2)
        try folder.stage(older)
        try folder.stage(newer)
        let launch6 = try await boot()
        XCTAssertEqual(launch6.version, newer.version)
    }

    func testAFailedSelfTestFallsBackToTheBundledEngine() async throws {
        let release = fixture.staged(daysAfterBundled: 2, broken: true)
        try folder.stage(release)
        let choice = try await boot()
        XCTAssertNil(choice.version)
        XCTAssertEqual(try version(choice), fixture.bundled.facts.version)
        let state = try folder.readState(bundled: 0)
        XCTAssertEqual(state.bad, [release.version])
        XCTAssertNil(state.trying)
        XCTAssertEqual(folder.stagedVersions(), [], "a bad engine is deleted")
    }

    func testAFailedNewerEngineFallsBackToTheLastGoodOne() async throws {
        let good = fixture.staged(daysAfterBundled: 1)
        let broken = fixture.staged(daysAfterBundled: 2, broken: true)
        try folder.stage(good)
        try folder.stage(broken)
        let launch7 = try await boot()
        XCTAssertEqual(launch7.version, good.version)
    }

    func testATrialThatNeverFinishedIsACrashAndFallsBack() async throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        var state = EngineFolder.State()
        state.trying = release.version // the last launch died during its trial
        try folder.write(state)
        let choice = try await boot()
        XCTAssertNil(choice.version)
        XCTAssertEqual(try folder.readState(bundled: 0).bad, [release.version])
        XCTAssertEqual(folder.stagedVersions(), [])
    }

    func testATamperedFileOnDiskFallsBack() async throws {
        let release = fixture.staged(daysAfterBundled: 2)
        var tampered = release.bundle
        tampered[tampered.count - 3] ^= 1
        try folder.stage(EngineFolder.Staged(version: release.version, bundle: tampered, manifest: release.manifest, signature: release.signature))
        let launch8 = try await boot()
        XCTAssertNil(launch8.version)
        XCTAssertEqual(try folder.readState(bundled: 0).bad, [release.version])
    }

    func testAnEngineSignedByAKeyNoLongerPinnedIsRefused() async throws {
        try folder.stage(fixture.staged(daysAfterBundled: 2))
        let other = try EngineReleaseFixture()
        let choice = try await EngineBoot(folder: folder, bundled: fixture.bundled, keys: other.keys, appBuild: 5, session: StubHTTP.session(), foreground: true).start()
        XCTAssertNil(choice.version)
    }

    func testABackgroundLaunchNeverTriesANewEngine() async throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        let launch9 = try await boot(foreground: false)
        XCTAssertNil(launch9.version)
        let state = try folder.readState(bundled: 0)
        XCTAssertNil(state.trying)
        XCTAssertEqual(state.bad, [])
        XCTAssertEqual(folder.stagedVersions(), [release.version], "kept for a foreground launch")
        let trial = try await boot(foreground: true)
        XCTAssertEqual(trial.version, release.version)
        trial.engine.trial?.confirm()
        let launch10 = try await boot(foreground: false)
        XCTAssertEqual(launch10.version, release.version, "proven now, so a background launch may run it")
    }

    func testAnUnreadableStateIsNotNowNeverBad() async throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        // A folder where the state file should be: reading it fails, as before first unlock.
        try FileManager.default.createDirectory(at: folder.url.appending(path: "state.json"), withIntermediateDirectories: true)
        let launch11 = try await boot()
        XCTAssertNil(launch11.version)
        XCTAssertEqual(folder.stagedVersions(), [release.version])
    }

    func testAnAppUpdateWithANewerBundledEngineDeletesOlderDownloads() async throws {
        let release = fixture.staged(daysAfterBundled: -1)
        try folder.stage(release)
        let launch12 = try await boot()
        XCTAssertNil(launch12.version)
        XCTAssertEqual(folder.stagedVersions(), [])
    }

    func testTheSelfTestRunsInAQuarantineWithNoNetwork() async throws {
        let engine = try HealthEngine(source: fixture.bundled.source, sourceURL: nil, session: StubHTTP.session(), quarantined: true)
        var asked = 0
        StubHTTP.handler = { _ in asked += 1; return .init() }
        let answer = try await engine.settleScript("""
            fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: 'Bearer native-token:dropbox' } })
              .then(() => 'sent', (e) => 'refused')
            """)
        XCTAssertEqual(answer, "refused")
        XCTAssertEqual(asked, 0)
        let facts = fixture.bundled.facts
        try engine.blocking { try EngineSelfTest.run($0, version: facts.version, schemaVersion: facts.schemaVersion) }
    }
}
