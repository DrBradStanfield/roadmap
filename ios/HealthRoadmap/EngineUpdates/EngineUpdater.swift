import CryptoKit
import Foundation
import os

/// Looks for a newer engine (US-25 AC18, ios/architecture.md D3): at launch and on each
/// return to the foreground, at most once in 6 hours. Two small GETs to GitHub, with no
/// health data, device id, cookie or custom header; the bundle is fetched only after
/// the manifest's signature and fields pass. A verified bundle is staged for the next
/// launch, never run now. Any failure keeps the current engine and says nothing.
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
    private let now: () -> Date
    private var running = false

    private static let log = Logger(subsystem: "com.drbrad.healthroadmap", category: "engine-update")

    init(folder: EngineFolder, bundled: BundledEngine.Facts, session: URLSession = EngineUpdater.session(),
         base: URL = EngineRelease.baseURL, keys: [String: Curve25519.Signing.PublicKey] = EngineRelease.trustedKeys,
         appId: String = EngineRelease.appId, appBuild: Int = EngineRelease.appBuild, now: @escaping () -> Date = Date.init) {
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

    private func check() async -> Outcome {
        guard var state = try? folder.readState() else { return .failed }
        let time = now()
        if let last = state.lastCheck, time.timeIntervalSince(last) < EngineRelease.checkInterval, time >= last { return .notDue }
        state.lastCheck = time
        guard (try? folder.write(state)) != nil else { return .failed }

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
            state.highWater = manifest.version
            state.floor = max(state.floor, manifest.minVersion)
            try folder.write(state)
        } catch {
            return .failed
        }
        return .staged(manifest.version)
    }

    private func get(_ name: String, limit: Int) async -> Data? {
        await Self.get(base.appending(path: name), limit: limit, session: session)
    }

    /// One GET, read up to `limit` bytes; nil on any failure, a non-200 or more bytes.
    /// Nonisolated, so reading the bundle byte by byte stays off the main thread.
    nonisolated private static func get(_ url: URL, limit: Int, session: URLSession) async -> Data? {
        var request = URLRequest(url: url)
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
