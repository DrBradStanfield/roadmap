import CryptoKit
import Foundation
import os

/// Picks the engine at launch (US-25 AC17, ios/architecture.md D3). A downloaded engine
/// runs only from a fresh launch, never mid-session, and only after it is checked again
/// here: its stored manifest's signature and fields, its bytes' hash, then a self-test
/// in a quarantined context. The bytes checked are the bytes run: the file is read once.
/// Anything wrong, and the bundled engine runs.
@MainActor
struct EngineBoot {
    let folder: EngineFolder?
    let bundled: BundledEngine
    var keys = EngineRelease.trustedKeys
    var appId = EngineRelease.appId
    var appBuild = EngineRelease.appBuild
    var session: URLSession = EngineHTTP.shared
    /// False when iOS started the app in the background (a Health delivery): then no
    /// engine is tried for the first time, and a crash cannot count against one.
    var foreground: Bool

    /// Which engine runs, and why: for the log and the tests.
    struct Choice {
        let engine: HealthEngine
        /// The downloaded version running, nil for the bundled engine.
        let version: Int?
    }

    private static let log = Logger(subsystem: "com.drbrad.healthroadmap", category: "engine-update")

    func start() throws -> Choice {
        if let choice = downloaded() { return choice }
        return Choice(engine: try HealthEngine(source: bundled.source, sourceURL: bundled.url, session: session), version: nil)
    }

    private func downloaded() -> Choice? {
        // Unreadable before first unlock: not now, and nothing is marked.
        guard let folder, var state = try? folder.readState() else { return nil }
        let bundledVersion = bundled.facts.version

        // A trial that never finished: that launch crashed or hung.
        if let trying = state.trying {
            Self.log.notice("engine \(trying, privacy: .public) did not finish its trial launch: marked bad")
            state.bad.append(trying)
            state.trying = nil
        }
        // Older than the app's own engine (an App Store update), below the floor, or bad: gone.
        for version in folder.stagedVersions() where version <= bundledVersion || version < state.floor || state.bad.contains(version) {
            folder.remove(version)
        }
        state.proven.removeAll { $0 <= bundledVersion }
        guard (try? folder.write(state)) != nil else { return nil }

        for version in folder.stagedVersions() where foreground || state.proven.contains(version) {
            // Unreadable now (protected data): try another launch, never mark it.
            guard let staged = try? folder.read(version) else { return nil }
            let trial = foreground && !state.proven.contains(version)
            if trial {
                state.trying = version
                guard (try? folder.write(state)) != nil else { return nil }
            }
            do {
                let engine = try load(staged, floor: state.floor)
                if trial {
                    state.trying = nil
                    state.proven.append(version)
                    try? folder.write(state)
                }
                Self.log.notice("running downloaded engine \(version, privacy: .public)")
                return Choice(engine: engine, version: version)
            } catch {
                Self.log.error("engine \(version, privacy: .public) refused: \(String(describing: error), privacy: .public)")
                state.trying = nil
                state.bad.append(version)
                try? folder.write(state)
                folder.remove(version)
            }
        }
        return nil
    }

    enum LoadFailure: Error {
        case wrongVersion, hashMismatch, notText
    }

    /// Checks one staged engine end to end and returns the live engine built from it.
    func load(_ staged: EngineFolder.Staged, floor: Int) throws -> HealthEngine {
        let expect = ManifestCheck.Expect(
            appId: appId, appBuild: appBuild, schemaVersion: bundled.facts.schemaVersion,
            above: bundled.facts.version, floor: floor, now: nil
        )
        let manifest = try ManifestCheck.verify(staged.manifest, signature: ManifestCheck.signature(staged.signature), keys: keys, expect: expect)
        guard manifest.version == staged.version else { throw LoadFailure.wrongVersion }
        guard staged.bundle.count == manifest.size, ManifestCheck.sha256(staged.bundle) == manifest.sha256 else { throw LoadFailure.hashMismatch }
        guard let source = String(data: staged.bundle, encoding: .utf8) else { throw LoadFailure.notText }

        // Quarantine first: no network, no token, a phone file in memory.
        let quarantine = try HealthEngine(source: source, sourceURL: nil, session: session, quarantined: true)
        let port = QuarantinePort()
        quarantine.natives.cloud = port
        try EngineSelfTest.run(quarantine, version: manifest.version, schemaVersion: manifest.schemaVersion)
        // Then the real context, from the same bytes.
        return try HealthEngine(source: source, sourceURL: folder?.url.appending(path: "\(manifest.version).js"), session: session)
    }
}
