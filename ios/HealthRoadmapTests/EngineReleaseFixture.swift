import CryptoKit
import Foundation
@testable import HealthRoadmap

/// Builds signed test releases for the over-the-air update tests (US-25 AC18): a
/// throwaway key, canonical manifests, and engine bundles made from the app's own
/// bundled engine with a new version stamped on (or a door broken).
struct EngineReleaseFixture {
    let key = Curve25519.Signing.PrivateKey()
    var keyId = "daily"
    let bundled: BundledEngine

    init() throws {
        bundled = try BundledEngine()
    }

    var keys: [String: Curve25519.Signing.PublicKey] { [keyId: key.publicKey] }

    /// A version `days` after the bundled engine's, and that instant.
    func version(daysAfterBundled days: Int) -> (version: Int, date: Date) {
        let date = ManifestCheck.versionDate(bundled.facts.version)!.addingTimeInterval(TimeInterval(days) * 86_400)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let c = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: date)
        return (Int(String(format: "%04d%02d%02d%02d%02d", c.year!, c.month!, c.day!, c.hour!, c.minute!))!, date)
    }

    /// The bundled engine re-stamped as `version`; `broken` makes the plan door throw.
    func bundle(version: Int, broken: Bool = false) -> Data {
        var source = bundled.source + "\nHealthEngine = Object.assign({}, HealthEngine, { engineVersion: \(version) });\n"
        if broken { source += "HealthEngine.planJson = function () { throw new Error('broken on purpose'); };\n" }
        return Data(source.utf8)
    }

    /// A canonical manifest for `bundle`, with `edit` applied to its fields.
    func manifest(version: Int, issued: Date, bundle: Data, edit: (inout [String: Any]) -> Void = { _ in }) -> Data {
        let iso = Date.ISO8601FormatStyle()
        var fields: [String: Any] = [
            "appId": EngineRelease.appId, "bridge": EngineRelease.bridge, "channel": "production", "format": 1,
            "issuedAt": issued.formatted(iso), "keyId": keyId, "minAppBuild": 1, "minVersion": 0,
            "notAfter": issued.addingTimeInterval(30 * 86_400).formatted(iso), "schemaVersion": bundled.facts.schemaVersion,
            "sha256": ManifestCheck.sha256(bundle), "size": bundle.count, "version": version,
        ]
        edit(&fields)
        return try! JSONSerialization.data(withJSONObject: fields, options: [.sortedKeys, .withoutEscapingSlashes])
    }

    /// The `manifest.sig` file for `manifest`: base64 Ed25519 over the domain and the bytes.
    func signatureFile(_ manifest: Data, with signer: Curve25519.Signing.PrivateKey? = nil) -> Data {
        let signature = try! (signer ?? key).signature(for: ManifestCheck.domain + manifest)
        return Data((signature.base64EncodedString() + "\n").utf8)
    }

    /// A whole staged release.
    func staged(daysAfterBundled days: Int, broken: Bool = false) -> EngineFolder.Staged {
        let (version, date) = version(daysAfterBundled: days)
        let bundle = bundle(version: version, broken: broken)
        let manifest = manifest(version: version, issued: date, bundle: bundle)
        return EngineFolder.Staged(version: version, bundle: bundle, manifest: manifest, signature: signatureFile(manifest))
    }

    /// A fresh, empty folder for one test.
    static func folder() throws -> EngineFolder {
        let base = FileManager.default.temporaryDirectory.appending(path: "engine test \(UUID().uuidString)", directoryHint: .isDirectory)
        return try EngineFolder(base: base)
    }
}
