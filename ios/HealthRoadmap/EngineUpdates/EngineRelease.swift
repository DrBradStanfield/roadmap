import CryptoKit
import Foundation

/// The fixed facts of over-the-air engine updates (US-25 AC18, ios/architecture.md D3):
/// where releases live, which keys may sign them, and the bridge this binary serves.
/// Release side: ios/scripts/release-engine.mjs; how to release: ios/engine-updates.md.
enum EngineRelease {
    /// The native bridge this binary serves: the first 16 hex digits of the SHA-256 of
    /// ios/engine/bridge-contract.json. EngineBridgeContractTests fails if they drift.
    static let bridge = "4bb43ea735cb5a3d"

    /// The signing keys this app trusts, by id: the daily key (Brad's login Keychain),
    /// the cold backup (the Passwords app) and the ci key (the GitHub `engine-signing`
    /// environment's secret, for the workflow). ios/engine/signing-keys.json holds the same;
    /// the release script refuses any other key. Rotation: ios/engine-updates.md.
    static let publicKeys: [String: String] = [
        "daily": "rVHa1bJ5T6wGMKwNSTz+Vjmw7wkm4mzcJja3krs52kg=",
        "cold": "Rd9GxYU0sK2GmpuCLeHHpkJTlwg5ppmr1o6C11zZhzg=",
        "ci": "IRVIQw6gXNjk4+7TterhMNIzlUE8Pen2a6f70TU1cdc=",
    ]

    /// Every door the engine must have (the contract's `doors`), checked by the self-test.
    static let doors = [
        "applyEditJson", "chatContextJson", "chatDeleteJson", "chatListJson", "chatMessagesJson",
        "chatRecordExchangeJson", "cloudClose", "cloudEdit", "cloudErase", "cloudFlush", "cloudHidden", "cloudLabImport",
        "cloudOpen", "cloudRefresh", "cloudVisible", "convertJson", "documentSave", "erasePhoneJson", "fileNamesJson", "healthWritesJson", "historyJson",
        "labReviewJson", "labSaveSummaryJson", "mergeJson", "newRecordJson", "numberJson",
        "planJson", "remindersJson", "screenJson", "sectionsJson", "settledJson",
    ]

    static let channel = "production"
    /// Largest bundle the app downloads. The engine is about 0.6 MB.
    static let maxBundleBytes = 8 * 1024 * 1024
    /// Largest manifest or signature it reads.
    static let maxSmallBytes = 16 * 1024
    /// At most one check per this many seconds.
    static let checkInterval: TimeInterval = 6 * 60 * 60
    /// A release dated further ahead of the phone's clock than this is refused.
    static let clockSkew: TimeInterval = 2 * 24 * 60 * 60

    /// Where releases are read: main on GitHub, the files `npm run engine:release` writes.
    static var baseURL: URL {
        #if DEBUG
        // DEBUG builds only (compiled out of Release): a local server for the end-to-end check.
        if let local = UserDefaults.standard.string(forKey: "EngineUpdateBaseURL"), let url = URL(string: local) { return url }
        #endif
        return URL(string: "https://raw.githubusercontent.com/DrBradStanfield/roadmap/main/ios/engine-release/")!
    }

    /// The pinned keys as CryptoKit keys.
    static var trustedKeys: [String: Curve25519.Signing.PublicKey] {
        var keys = publicKeys.compactMapValues { text in
            Data(base64Encoded: text).flatMap { try? Curve25519.Signing.PublicKey(rawRepresentation: $0) }
        }
        #if DEBUG
        // DEBUG builds only: a throwaway key for the end-to-end check against a local server.
        if let text = UserDefaults.standard.string(forKey: "EngineUpdateTestKey"), let raw = Data(base64Encoded: text),
           let key = try? Curve25519.Signing.PublicKey(rawRepresentation: raw) { keys["debug"] = key }
        #endif
        return keys
    }

    static var appId: String { Bundle.main.bundleIdentifier ?? "" }
    static var appBuild: Int { Int(Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "") ?? 0 }
}

/// The engine shipped inside the app: its source and what its sidecar says
/// (health-engine.json, written by build-engine.mjs).
struct BundledEngine {
    struct Facts: Decodable, Equatable {
        let bridge: String
        let schemaVersion: Int
        let version: Int
    }

    let source: String
    let url: URL
    let facts: Facts

    init(bundle: Bundle = .main) throws {
        guard let url = bundle.url(forResource: "health-engine", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8),
              let factsURL = bundle.url(forResource: "health-engine", withExtension: "json"),
              let facts = try? JSONDecoder().decode(Facts.self, from: Data(contentsOf: factsURL))
        else { throw HealthEngine.EngineError.missingBundle }
        self.source = source
        self.url = url
        self.facts = facts
    }
}
