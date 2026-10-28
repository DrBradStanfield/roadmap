import CryptoKit
import Foundation
import os

/// Looks for a newer engine (US-25 AC18, ios/architecture.md D3): at launch and on each
/// return to the foreground, at most once in 6 hours. Two small GETs to GitHub, with no
/// health data, device id, cookie or custom header; the bundle is fetched only after
/// the manifest's signature and fields pass. A verified bundle is staged for the next
/// launch, never run now. Any failure keeps the current engine and says nothing.
/// The network GETs, the signature and hash checks and the staging of a bundle run off
/// the main actor (US-25 AC21). Each read-modify-write of the state file (the check's two
/// passes) runs on it, with no suspension inside, as `EngineTrial.confirm()` does: the
/// two are serialized, so neither overwrites the other's write (review R1, R4).
@MainActor
final class EngineUpdater {
    enum Outcome: Equatable {
        case notDue, busy, upToDate, staged(Int), refused(String), failed
    }

    private let folder: EngineFolder
    private let bundled: BundledEngine.Facts
    private let session: URLSession
    private let base: URL
    private let keys: [String: Curve25519.Signing.PublicKey]
    private let appId: String
    private let appBuild: Int
    private let now: @Sendable () -> Date
    private var running = false

    private static let log = Logger(subsystem: "com.drstanfield.healthroadmap", category: "engine-update")

    init(folder: EngineFolder, bundled: BundledEngine.Facts, session: URLSession = EngineUpdater.session(),
         base: URL = EngineRelease.baseURL, keys: [String: Curve25519.Signing.PublicKey] = EngineRelease.trustedKeys,
         appId: String = EngineRelease.appId, appBuild: Int = EngineRelease.appBuild, now: @escaping @Sendable () -> Date = Date.init) {
        self.folder = folder
        self.bundled = bundled
        self.session = session
        self.base = base.appending(path: "bridge-\(EngineRelease.bridge)/")
        self.keys = keys
        self.appId = appId
        self.appBuild = appBuild
        self.now = now
    }

    /// Ephemeral and plain: no cookies, no cache, short timeouts, no redirects.
    static func session() -> URLSession {
        let configuration = EngineHTTP.configuration()
        configuration.timeoutIntervalForRequest = 15
        configuration.timeoutIntervalForResource = 60
        return URLSession(configuration: configuration, delegate: NoRedirects.shared, delegateQueue: nil)
    }

    @discardableResult
    func checkIfDue() async -> Outcome {
        guard !running else { return .busy }
        running = true
        defer { running = false }
        let outcome = await check()
        if outcome != .notDue { Self.log.notice("engine update check: \(String(describing: outcome), privacy: .public)") }
        return outcome
    }

    private enum Start: Sendable { case stop(Outcome), go(EngineFolder.State, Date) }

    @concurrent
    nonisolated private func check() async -> Outcome {
        let state: EngineFolder.State, time: Date
        switch await start() {
        case .stop(let outcome): return outcome
        case .go(let read, let at): (state, time) = (read, at)
        }

        guard let manifestBytes = await get("manifest.json", limit: EngineRelease.maxSmallBytes),
              let signatureFile = await get("manifest.sig", limit: EngineRelease.maxSmallBytes)
        else { return .failed }
        let expect = ManifestCheck.Expect(
            appId: appId, appBuild: appBuild, schemaVersion: bundled.schemaVersion,
            above: max(bundled.version, state.highWater), floor: state.floor, now: time
        )
        let manifest: EngineManifest
        do {
            manifest = try ManifestCheck.verify(manifestBytes, signature: ManifestCheck.signature(signatureFile), keys: keys, expect: expect)
        } catch ManifestCheck.Refusal.notNewer {
            return .upToDate
        } catch {
            return .refused(String(describing: error))
        }

        guard let bundle = await get("\(manifest.sha256).js", limit: manifest.size) else { return .failed }
        guard bundle.count == manifest.size, ManifestCheck.sha256(bundle) == manifest.sha256 else { return .refused("hashMismatch") }

        do {
            try folder.stage(EngineFolder.Staged(version: manifest.version, bundle: bundle, manifest: manifestBytes, signature: signatureFile))
            try await record(version: manifest.version, minVersion: manifest.minVersion, at: time)
        } catch {
            return .failed
        }
        return .staged(manifest.version)
    }

    /// Pass one, on the main actor: is a check due? If so, stamp it.
    private func start() -> Start {
        guard var state = try? folder.readState(bundled: bundled.version) else { return .stop(.failed) }
        let time = now()
        if let last = state.lastCheck, time.timeIntervalSince(last) < EngineRelease.checkInterval, time >= last { return .stop(.notDue) }
        state.lastCheck = time
        guard (try? folder.write(state)) != nil else { return .stop(.failed) }
        return .go(state, time)
    }

    /// Pass two, on the main actor: read the state again, since a trial may have been
    /// confirmed during the download (review R4). The check owns only highWater, floor
    /// and lastCheck.
    private func record(version: Int, minVersion: Int, at time: Date) throws {
        var latest = try folder.readState(bundled: bundled.version)
        latest.highWater = max(latest.highWater, version)
        latest.floor = max(latest.floor, minVersion)
        latest.lastCheck = time
        try folder.write(latest)
    }

    /// One GET, read up to `limit` bytes; nil on any failure, a non-200 or more bytes.
    @concurrent
    nonisolated private func get(_ name: String, limit: Int) async -> Data? {
        var request = URLRequest(url: base.appending(path: name))
        request.cachePolicy = .reloadIgnoringLocalAndRemoteCacheData
        guard let (bytes, response) = try? await session.bytes(for: request, delegate: NoRedirects.shared),
              (response as? HTTPURLResponse)?.statusCode == 200,
              response.expectedContentLength <= Int64(limit)
        else { return nil }
        var data = Data()
        data.reserveCapacity(min(limit, EngineRelease.maxBundleBytes))
        do {
            for try await byte in bytes {
                data.append(byte)
                if data.count > limit { return nil }
            }
        } catch {
            return nil
        }
        return data
    }
}
