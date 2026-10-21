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

    private func boot(foreground: Bool = true) throws -> EngineBoot.Choice {
        try EngineBoot(folder: folder, bundled: fixture.bundled, keys: fixture.keys, appBuild: 5, session: StubHTTP.session(), foreground: foreground).start()
    }

    private func version(_ choice: EngineBoot.Choice) throws -> Int? {
        try choice.engine.evaluate("HealthEngine.engineVersion").toNumber()?.intValue
    }

    func testAStagedEngineRunsAfterItsSelfTest() throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        let choice = try boot()
        XCTAssertEqual(choice.version, release.version)
        XCTAssertEqual(try version(choice), release.version)
        XCTAssertEqual(try folder.readState().trying, release.version, "on trial until the user's plan renders")
        XCTAssertEqual(try folder.readState().proven, [])
        choice.engine.trial?.confirm()
        let state = try folder.readState()
        XCTAssertNil(state.trying, "the trial finished")
        XCTAssertEqual(state.proven, [release.version])
    }

    func testALaunchThatEndsBeforeThePlanRendersCountsAgainstTheEngine() throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        XCTAssertEqual(try boot().version, release.version) // never confirmed: a hang on the real record
        XCTAssertNil(try boot().version)
        XCTAssertEqual(try folder.readState().bad, [release.version])
    }

    func testABackgroundLaunchLeavesAnOpenTrialForTheNextForegroundOne() throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        _ = try boot()
        XCTAssertNil(try boot(foreground: false).version, "not proven, so not run in the background")
        XCTAssertEqual(try folder.readState().trying, release.version)
        XCTAssertEqual(try folder.readState().bad, [])
    }

    func testThePlanScreenConfirmsATrialOnceThePlanRenders() async throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        let choice = try boot()
        let records = FileManager.default.temporaryDirectory.appending(path: "plan trial \(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: records, withIntermediateDirectories: true)
        let store = try RecordStore(folder: records, engine: choice.engine, deviceId: "test")
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 844))
        window.rootViewController = UIHostingController(rootView: PlanView(engine: choice.engine, store: store, showMyData: {}))
        window.makeKeyAndVisible()
        var waited = 0
        while try folder.readState().trying != nil, waited < 100 {
            try await Task.sleep(for: .milliseconds(50))
            waited += 1
        }
        XCTAssertNil(try folder.readState().trying)
        XCTAssertEqual(try folder.readState().proven, [release.version])
        window.isHidden = true
    }

    func testTheNewestOfTwoRuns() throws {
        let older = fixture.staged(daysAfterBundled: 1)
        let newer = fixture.staged(daysAfterBundled: 2)
        try folder.stage(older)
        try folder.stage(newer)
        XCTAssertEqual(try boot().version, newer.version)
    }

    func testAFailedSelfTestFallsBackToTheBundledEngine() throws {
        let release = fixture.staged(daysAfterBundled: 2, broken: true)
        try folder.stage(release)
        let choice = try boot()
        XCTAssertNil(choice.version)
        XCTAssertEqual(try version(choice), fixture.bundled.facts.version)
        let state = try folder.readState()
        XCTAssertEqual(state.bad, [release.version])
        XCTAssertNil(state.trying)
        XCTAssertEqual(folder.stagedVersions(), [], "a bad engine is deleted")
    }

    func testAFailedNewerEngineFallsBackToTheLastGoodOne() throws {
        let good = fixture.staged(daysAfterBundled: 1)
        let broken = fixture.staged(daysAfterBundled: 2, broken: true)
        try folder.stage(good)
        try folder.stage(broken)
        XCTAssertEqual(try boot().version, good.version)
    }

    func testATrialThatNeverFinishedIsACrashAndFallsBack() throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        var state = EngineFolder.State()
        state.trying = release.version // the last launch died during its trial
        try folder.write(state)
        let choice = try boot()
        XCTAssertNil(choice.version)
        XCTAssertEqual(try folder.readState().bad, [release.version])
        XCTAssertEqual(folder.stagedVersions(), [])
    }

    func testATamperedFileOnDiskFallsBack() throws {
        let release = fixture.staged(daysAfterBundled: 2)
        var tampered = release.bundle
        tampered[tampered.count - 3] ^= 1
        try folder.stage(EngineFolder.Staged(version: release.version, bundle: tampered, manifest: release.manifest, signature: release.signature))
        XCTAssertNil(try boot().version)
        XCTAssertEqual(try folder.readState().bad, [release.version])
    }

    func testAnEngineSignedByAKeyNoLongerPinnedIsRefused() throws {
        try folder.stage(fixture.staged(daysAfterBundled: 2))
        let other = try EngineReleaseFixture()
        let choice = try EngineBoot(folder: folder, bundled: fixture.bundled, keys: other.keys, appBuild: 5, session: StubHTTP.session(), foreground: true).start()
        XCTAssertNil(choice.version)
    }

    func testABackgroundLaunchNeverTriesANewEngine() throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        XCTAssertNil(try boot(foreground: false).version)
        let state = try folder.readState()
        XCTAssertNil(state.trying)
        XCTAssertEqual(state.bad, [])
        XCTAssertEqual(folder.stagedVersions(), [release.version], "kept for a foreground launch")
        let trial = try boot(foreground: true)
        XCTAssertEqual(trial.version, release.version)
        trial.engine.trial?.confirm()
        XCTAssertEqual(try boot(foreground: false).version, release.version, "proven now, so a background launch may run it")
    }

    func testAnUnreadableStateIsNotNowNeverBad() throws {
        let release = fixture.staged(daysAfterBundled: 2)
        try folder.stage(release)
        // A folder where the state file should be: reading it fails, as before first unlock.
        try FileManager.default.createDirectory(at: folder.url.appending(path: "state.json"), withIntermediateDirectories: true)
        XCTAssertNil(try boot().version)
        XCTAssertEqual(folder.stagedVersions(), [release.version])
    }

    func testAnAppUpdateWithANewerBundledEngineDeletesOlderDownloads() throws {
        let release = fixture.staged(daysAfterBundled: -1)
        try folder.stage(release)
        XCTAssertNil(try boot().version)
        XCTAssertEqual(folder.stagedVersions(), [])
    }

    func testTheSelfTestRunsInAQuarantineWithNoNetwork() async throws {
        let engine = try HealthEngine(source: fixture.bundled.source, sourceURL: nil, session: StubHTTP.session(), quarantined: true)
        var asked = 0
        StubHTTP.handler = { _ in asked += 1; return .init() }
        let answer = try await engine.settle(engine.evaluate("""
            fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: 'Bearer native-token:dropbox' } })
              .then(() => 'sent', (e) => 'refused')
            """))
        XCTAssertEqual(answer, "refused")
        XCTAssertEqual(asked, 0)
        try EngineSelfTest.run(engine, version: fixture.bundled.facts.version, schemaVersion: fixture.bundled.facts.schemaVersion)
    }
}
