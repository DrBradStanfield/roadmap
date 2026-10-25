import XCTest
@testable import HealthRoadmap

/// US-25 AC18: the update check against a stubbed GitHub. It fetches only the
/// manifest, its signature and then the bundle, carries nothing of the user's, and
/// stages only what verifies.
@MainActor
final class EngineUpdaterTests: XCTestCase {
    private var fixture: EngineReleaseFixture!
    private var folder: EngineFolder!
    private var release: EngineFolder.Staged!
    private var now = Date()
    private let log = RequestLog()
    private var seen: [StubHTTP.Request] {
        get { log.requests }
        set { log.requests = newValue }
    }
    private let base = URL(string: "https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/ios/engine-release/")!

    override func setUpWithError() throws {
        fixture = try EngineReleaseFixture()
        folder = try EngineReleaseFixture.folder()
        release = fixture.staged(daysAfterBundled: 2)
        now = ManifestCheck.versionDate(release.version)!.addingTimeInterval(3600)
        seen = []
        serve(release)
    }

    private func serve(_ release: EngineFolder.Staged, bundle: Data? = nil, delay: TimeInterval = 0) {
        let dir = "/DrBradStanfield/roadmap/main/ios/engine-release/bridge-\(EngineRelease.bridge)/"
        let log = log
        StubHTTP.handler = { request in
            log.requests.append(request)
            switch request.url.path() {
            case dir + "manifest.json": return .init(body: release.manifest)
            case dir + "manifest.sig": return .init(body: release.signature)
            case dir + "\(ManifestCheck.sha256(release.bundle)).js": return .init(body: bundle ?? release.bundle, delay: delay)
            default: return .init(status: 404)
            }
        }
    }

    private func updater(at time: Date? = nil) -> EngineUpdater {
        EngineUpdater(folder: folder, bundled: fixture.bundled.facts, session: StubHTTP.session(configuration: EngineHTTP.configuration()), base: base,
                      keys: fixture.keys, appBuild: 5, now: { [now] in time ?? now })
    }

    func testAVerifiedReleaseIsStagedForTheNextLaunch() async throws {
        let outcome = await updater().checkIfDue()
        XCTAssertEqual(outcome, .staged(release.version))
        XCTAssertEqual(folder.stagedVersions(), [release.version])
        let staged = try folder.read(release.version)
        XCTAssertEqual(staged.bundle, release.bundle)
        XCTAssertEqual(staged.manifest, release.manifest)
        XCTAssertEqual(try folder.readState(bundled: 0).highWater, release.version)
    }

    func testTheRequestsCarryNothingOfTheUser() async throws {
        await updater().checkIfDue()
        XCTAssertEqual(seen.map(\.method), ["GET", "GET", "GET"])
        for request in seen {
            XCTAssertEqual(request.url.host(), "raw.githubusercontent.com")
            XCTAssertNil(request.url.query())
            XCTAssertTrue(request.body.isEmpty)
            XCTAssertNil(request.headers["cookie"])
            XCTAssertNil(request.headers["authorization"])
            // Only what the system adds: no header of ours but the plain User-Agent.
            let ours = Set(request.headers.keys).subtracting(["user-agent", "accept", "accept-encoding", "accept-language", "connection", "host"])
            XCTAssertEqual(ours, [], "unexpected headers")
        }
        XCTAssertEqual(seen.last?.headers["user-agent"], "HealthRoadmap")
    }

    func testAtMostOneCheckInSixHours() async throws {
        await updater().checkIfDue()
        seen = []
        let soon = await updater(at: now.addingTimeInterval(5 * 3600)).checkIfDue()
        XCTAssertEqual(soon, .notDue)
        XCTAssertTrue(seen.isEmpty)
        let later = await updater(at: now.addingTimeInterval(7 * 3600)).checkIfDue()
        XCTAssertEqual(later, .upToDate, "the same release is not fetched again")
        XCTAssertEqual(seen.count, 2, "manifest and signature only")
    }

    func testABadSignatureFetchesNoBundle() async throws {
        serve(EngineFolder.Staged(version: release.version, bundle: release.bundle, manifest: release.manifest,
                                  signature: fixture.signatureFile(release.manifest, with: .init())))
        let outcome = await updater().checkIfDue()
        XCTAssertEqual(outcome, .refused("badSignature"))
        XCTAssertEqual(seen.count, 2)
        XCTAssertEqual(folder.stagedVersions(), [])
    }

    func testRollbackIsRefused() async throws {
        var state = EngineFolder.State()
        state.highWater = release.version
        try folder.write(state)
        let outcome = await updater().checkIfDue()
        XCTAssertEqual(outcome, .upToDate)
        XCTAssertEqual(folder.stagedVersions(), [])
    }

    func testABundleWhoseHashDiffersIsNotStaged() async throws {
        var other = release.bundle
        other[other.count - 2] ^= 1
        serve(release, bundle: other)
        let outcome = await updater().checkIfDue()
        XCTAssertEqual(outcome, .refused("hashMismatch"))
        XCTAssertEqual(folder.stagedVersions(), [])
        XCTAssertEqual(try folder.readState(bundled: 0).highWater, 0)
    }

    func testAnOversizeBundleIsNotRead() async throws {
        serve(release, bundle: release.bundle + Data(repeating: 32, count: 10))
        let outcome = await updater().checkIfDue()
        XCTAssertEqual(outcome, .failed)
        XCTAssertEqual(folder.stagedVersions(), [])
    }

    func testANetworkFailureKeepsWhatIsThere() async throws {
        StubHTTP.handler = { _ in .init(offline: true) }
        let outcome = await updater().checkIfDue()
        XCTAssertEqual(outcome, .failed)
        XCTAssertEqual(folder.stagedVersions(), [])
    }

    /// Review R4: the check's last write re-reads the state, so a trial confirmed
    /// while the bundle downloads is kept.
    func testATrialConfirmedDuringADownloadIsKept() async throws {
        let onTrial = fixture.version(daysAfterBundled: 1).version
        var state = EngineFolder.State()
        state.trying = onTrial
        try folder.write(state)
        serve(release, delay: 1)
        let check = Task { await updater().checkIfDue() }
        try await Task.sleep(for: .milliseconds(400))
        EngineTrial(version: onTrial, folder: folder, bundled: fixture.bundled.facts.version).confirm()
        let outcome = await check.value
        XCTAssertEqual(outcome, .staged(release.version))
        let after = try folder.readState(bundled: 0)
        XCTAssertNil(after.trying)
        XCTAssertEqual(after.proven, [onTrial])
        XCTAssertEqual(after.highWater, release.version)
    }

    /// US-25 AC21 (Codex and adversary R1): the check's first pass reads the state,
    /// stamps lastCheck and writes it back. A trial confirmed while that pass runs must
    /// not be overwritten. `now()` is called inside the pass, so it pauses there: it
    /// asks the main actor to confirm and waits. On main, the pass and the confirm are
    /// serialized and the confirm runs after the pass.
    func testATrialConfirmedDuringTheFirstPassIsKept() async throws {
        let onTrial = fixture.version(daysAfterBundled: 1).version
        var state = EngineFolder.State()
        state.trying = onTrial
        try folder.write(state)
        let trial = EngineTrial(version: onTrial, folder: folder, bundled: fixture.bundled.facts.version)
        let time = now
        let paused = EngineUpdater(
            folder: folder, bundled: fixture.bundled.facts, session: StubHTTP.session(configuration: EngineHTTP.configuration()),
            base: base, keys: fixture.keys, appBuild: 5,
            now: {
                Task { @MainActor in trial.confirm() }
                Thread.sleep(forTimeInterval: 0.3)
                return time
            })
        let outcome = await paused.checkIfDue()
        XCTAssertEqual(outcome, .staged(release.version))
        XCTAssertTrue(trial.confirmed)
        let after = try folder.readState(bundled: 0)
        XCTAssertNil(after.trying)
        XCTAssertEqual(after.proven, [onTrial], "the first pass overwrote the confirmed trial")
    }

    func testTheFloorOnlyRises() async throws {
        let bundle = release.bundle
        let manifest = fixture.manifest(version: release.version, issued: ManifestCheck.versionDate(release.version)!, bundle: bundle) {
            $0["minVersion"] = self.release.version
        }
        serve(EngineFolder.Staged(version: release.version, bundle: bundle, manifest: manifest, signature: fixture.signatureFile(manifest)))
        _ = await updater().checkIfDue()
        XCTAssertEqual(try folder.readState(bundled: 0).floor, release.version)
    }
}
