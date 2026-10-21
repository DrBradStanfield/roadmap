import XCTest
@testable import HealthRoadmap

/// US-25 AC17: which engine runs at launch. A staged engine runs only after it is
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
        let state = try folder.readState()
        XCTAssertNil(state.trying, "the trial finished")
        XCTAssertEqual(state.proven, [release.version])
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
        XCTAssertEqual(try boot(foreground: true).version, release.version)
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
