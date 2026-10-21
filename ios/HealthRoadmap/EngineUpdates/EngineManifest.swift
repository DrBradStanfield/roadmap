import CryptoKit
import Foundation

/// A release's signed description (US-25 AC18). Written by ios/scripts/release-engine.mjs
/// as canonical JSON: keys sorted, no whitespace, nothing else.
struct EngineManifest: Codable, Equatable {
    let appId: String
    let bridge: String
    let channel: String
    let format: Int
    let issuedAt: String
    let keyId: String
    let minAppBuild: Int
    let minVersion: Int
    let notAfter: String
    let schemaVersion: Int
    let sha256: String
    let size: Int
    let version: Int
}

/// Decides whether a manifest may be trusted. The signature is checked over the exact
/// bytes before anything reads them; then every field. Pure, so tests call it directly.
enum ManifestCheck {
    /// Signatures cover this prefix plus the manifest bytes (engine-signing.mjs DOMAIN).
    static let domain = Data("health-roadmap-engine-manifest/v1\n".utf8)

    enum Refusal: Error, Equatable {
        case badSignature, notCanonical, wrongFormat, wrongApp, wrongChannel, wrongBridge, wrongSchema
        case appTooOld, notNewer, belowFloor, expired, fromTheFuture, badFields
    }

    /// What this phone requires of a manifest.
    struct Expect {
        var bridge = EngineRelease.bridge
        var appId = EngineRelease.appId
        var appBuild = EngineRelease.appBuild
        /// The bundled engine's record schema: an update may never change it.
        var schemaVersion: Int
        /// The version must be above this: max(bundled engine, highest accepted).
        var above: Int
        /// The stored floor: no version below it, ever.
        var floor: Int
        /// The phone's clock when deciding to install; nil when re-checking a staged
        /// bundle at launch, which never expires a bundle already installed.
        var now: Date?
    }

    static func verify(_ bytes: Data, signature: Data, keys: [String: Curve25519.Signing.PublicKey], expect: Expect) throws -> EngineManifest {
        let signed = domain + bytes
        let signers = Set(keys.filter { $0.value.isValidSignature(signature, for: signed) }.keys)
        guard !signers.isEmpty else { throw Refusal.badSignature }

        guard let manifest = try? JSONDecoder().decode(EngineManifest.self, from: bytes) else { throw Refusal.notCanonical }
        // The bytes must be the one canonical spelling: no duplicate or unknown keys, no padding.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        guard (try? encoder.encode(manifest)) == bytes else { throw Refusal.notCanonical }
        guard signers.contains(manifest.keyId) else { throw Refusal.badSignature }

        guard manifest.format == 1 else { throw Refusal.wrongFormat }
        guard manifest.appId == expect.appId else { throw Refusal.wrongApp }
        guard manifest.channel == EngineRelease.channel else { throw Refusal.wrongChannel }
        guard manifest.bridge == expect.bridge else { throw Refusal.wrongBridge }
        guard manifest.schemaVersion == expect.schemaVersion else { throw Refusal.wrongSchema }
        guard manifest.minAppBuild <= expect.appBuild else { throw Refusal.appTooOld }
        guard manifest.sha256.count == 64, manifest.sha256.allSatisfy(\.isHexDigit), manifest.sha256 == manifest.sha256.lowercased(),
              manifest.size > 0, manifest.size <= EngineRelease.maxBundleBytes, manifest.minVersion <= manifest.version,
              let versionDate = versionDate(manifest.version)
        else { throw Refusal.badFields }
        guard manifest.version > expect.above else { throw Refusal.notNewer }
        guard manifest.version >= expect.floor else { throw Refusal.belowFloor }

        if let now = expect.now {
            guard let issued = try? Date(manifest.issuedAt, strategy: .iso8601),
                  let notAfter = try? Date(manifest.notAfter, strategy: .iso8601)
            else { throw Refusal.badFields }
            let latest = now.addingTimeInterval(EngineRelease.clockSkew)
            guard issued <= latest, versionDate <= latest else { throw Refusal.fromTheFuture }
            guard now < notAfter else { throw Refusal.expired }
        }
        return manifest
    }

    /// A version, UTC yyyymmddHHMM, as an instant; nil if it is not one.
    static func versionDate(_ version: Int) -> Date? {
        let text = String(version)
        guard text.count == 12 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        let digits = Array(text)
        func part(_ from: Int, _ count: Int) -> Int? { Int(String(digits[from..<from + count])) }
        guard let year = part(0, 4), let month = part(4, 2), let day = part(6, 2), let hour = part(8, 2), let minute = part(10, 2),
              (1...12).contains(month), (1...31).contains(day), hour < 24, minute < 60
        else { return nil }
        return calendar.date(from: DateComponents(year: year, month: month, day: day, hour: hour, minute: minute))
    }

    /// A `manifest.sig` file's signature: base64 text, a trailing newline allowed.
    /// Anything else gives empty bytes, which no key verifies.
    static func signature(_ file: Data) -> Data {
        let text = String(decoding: file, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return Data(base64Encoded: text) ?? Data()
    }

    /// Lowercase hex SHA-256 of `data`.
    static func sha256(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }
}
