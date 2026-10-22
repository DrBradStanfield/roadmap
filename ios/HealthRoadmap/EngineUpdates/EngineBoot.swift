import CryptoKit
import Foundation
import os

/// Picks the engine at launch (US-25 AC18, ios/architecture.md D3). A downloaded engine
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
        let bundledVersion = bundled.facts.version
        guard let folder, var state = try? folder.readState(bundled: bundledVersion) else { return nil }

        // A trial that never finished: that launch crashed or hung before the user's
        // own record was shown. Judged only on a foreground launch (R8): a
        // background launch leaves the mark for the next foreground one.
        if foreground, let trying = state.trying {
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
                // The mark stays until the user's own record is shown (My data or the plan).
                if trial { engine.trial = EngineTrial(version: version, folder: folder, bundled: bundledVersion) }
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
        try quarantine.blocking { engine in
            engine.attach(nil, phone: PhoneFiles(record: nil, pending: nil))
            try EngineSelfTest.run(engine, version: manifest.version, schemaVersion: manifest.schemaVersion)
        }
        // Then the real context, from the same bytes.
        return try HealthEngine(source: source, sourceURL: folder?.url.appending(path: "\(manifest.version).js"), session: session)
    }
}

/// A downloaded engine on its first foreground launch (US-25 AC18). Its "trying"
/// mark stays set until it has shown the user's own record, so a crash or hang on the
/// real record, not only on the self-test's fixture, counts against it at the next
/// launch. My data (`RecordStore.confirmEngineTrial`, which also plans the record) and
/// PlanView confirm only when the plan worked; the first one wins.
@MainActor
final class EngineTrial {
    let version: Int
    private let folder: EngineFolder
    private let bundled: Int
    private(set) var confirmed = false

    init(version: Int, folder: EngineFolder, bundled: Int) {
        self.version = version
        self.folder = folder
        self.bundled = bundled
    }

    /// Whether the engine plans `recordJSON`: a plan, or health-core's own PlanError
    /// (no height or sex), which is the engine working. Any other throw is a failure.
    static func planned(_ engine: isolated HealthEngine, recordJSON: String, deviceId: String) -> Bool {
        do {
            _ = try engine.plan(recordJSON: recordJSON, now: .now, deviceId: deviceId)
            return true
        } catch HealthEngine.EngineError.callFailed(let why) where why.hasPrefix("PlanError: ") {
            return true
        } catch {
            return false
        }
    }

    /// The engine drew and planned the user's record: it is proven.
    func confirm() {
        guard !confirmed, var state = try? folder.readState(bundled: bundled) else { return }
        confirmed = true
        if state.trying == version { state.trying = nil }
        if !state.proven.contains(version) { state.proven.append(version) }
        try? folder.write(state)
    }
}
