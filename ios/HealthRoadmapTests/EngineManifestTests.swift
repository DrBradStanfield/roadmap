import CryptoKit
import XCTest
@testable import HealthRoadmap

/// US-25 AC18: a manifest is trusted only when a pinned key signed its exact bytes
/// and every field fits this app (ManifestCheck).
final class EngineManifestTests: XCTestCase {
    private var fixture: EngineReleaseFixture!
    private var version = 0
    private var issued = Date()
    private var bundle = Data()

    override func setUpWithError() throws {
        fixture = try EngineReleaseFixture()
        (version, issued) = fixture.version(daysAfterBundled: 3)
        bundle = fixture.bundle(version: version)
    }

    private func expect(above: Int? = nil, floor: Int = 0, appBuild: Int = 5, now: Date? = nil) -> ManifestCheck.Expect {
        ManifestCheck.Expect(appBuild: appBuild, schemaVersion: fixture.bundled.facts.schemaVersion,
                             above: above ?? fixture.bundled.facts.version, floor: floor, now: now ?? issued.addingTimeInterval(3600))
    }

    private func check(_ manifest: Data, signature: Data? = nil, keys: [String: Curve25519.Signing.PublicKey]? = nil,
                       expect: ManifestCheck.Expect? = nil) throws -> EngineManifest {
        try ManifestCheck.verify(manifest, signature: ManifestCheck.signature(signature ?? fixture.signatureFile(manifest)),
                                 keys: keys ?? fixture.keys, expect: expect ?? self.expect())
    }

    private func assertRefused(_ refusal: ManifestCheck.Refusal, _ run: () throws -> EngineManifest, line: UInt = #line) {
        XCTAssertThrowsError(try run(), line: line) { XCTAssertEqual($0 as? ManifestCheck.Refusal, refusal, line: line) }
    }

    private func manifest(_ edit: (inout [String: Any]) -> Void = { _ in }) -> Data {
        fixture.manifest(version: version, issued: issued, bundle: bundle, edit: edit)
    }

    func testAGoodSignatureAndFieldsPass() throws {
        let checked = try check(manifest())
        XCTAssertEqual(checked.version, version)
        XCTAssertEqual(checked.sha256, ManifestCheck.sha256(bundle))
    }

    func testAnyChangedByteBreaksTheSignature() {
        let good = manifest()
        var bad = good
        bad[bad.count - 2] ^= 1 // inside the version number
        assertRefused(.badSignature) { try check(bad, signature: fixture.signatureFile(good)) }
    }

    func testAnUnpinnedKeyIsRefused() {
        let m = manifest()
        assertRefused(.badSignature) { try check(m, signature: fixture.signatureFile(m, with: Curve25519.Signing.PrivateKey())) }
    }

    func testASignatureWithoutTheDomainIsRefused() {
        let m = manifest()
        let bare = Data((try! fixture.key.signature(for: m).base64EncodedString()).utf8)
        assertRefused(.badSignature) { try check(m, signature: bare) }
    }

    func testTheKeyIdMustNameTheKeyThatSigned() {
        let m = manifest { $0["keyId"] = "cold" }
        assertRefused(.badSignature) { try check(m) }
    }

    func testAnyOfThePinnedKeysVerifies() throws {
        var cold: EngineReleaseFixture = fixture
        cold.keyId = "cold"
        let other = try EngineReleaseFixture()
        let m = cold.manifest(version: version, issued: issued, bundle: bundle)
        let keys = ["daily": other.key.publicKey, "cold": cold.key.publicKey]
        XCTAssertEqual(try check(m, signature: cold.signatureFile(m), keys: keys).keyId, "cold")
    }

    func testOnlyTheCanonicalSpellingIsAccepted() {
        let good = String(decoding: manifest(), as: UTF8.self)
        let duplicate = Data(good.replacingOccurrences(of: "{\"appId\"", with: "{\"version\":1,\"appId\"").utf8)
        let padded = Data(good.replacingOccurrences(of: ",", with: ", ").utf8)
        let extra = manifest { $0["extra"] = 1 }
        for bytes in [duplicate, padded, extra] {
            assertRefused(.notCanonical) { try check(bytes) }
        }
    }

    func testRollbackIsRefused() {
        assertRefused(.notNewer) { try check(manifest(), expect: expect(above: version)) }
        assertRefused(.notNewer) { try check(manifest(), expect: expect(above: version + 1)) }
    }

    func testTheFloorIsRefusedBelow() {
        assertRefused(.belowFloor) { try check(manifest(), expect: expect(floor: version + 1)) }
    }

    func testABridgeMismatchIsRefused() {
        assertRefused(.wrongBridge) { try check(manifest { $0["bridge"] = "0000000000000000" }) }
    }

    func testAnAppTooOldIsRefused() {
        assertRefused(.appTooOld) { try check(manifest { $0["minAppBuild"] = 6 }) }
    }

    func testASchemaChangeIsRefused() {
        assertRefused(.wrongSchema) { try check(manifest { $0["schemaVersion"] = 99 }) }
    }

    func testOtherAppsChannelsAndFormatsAreRefused() {
        assertRefused(.wrongApp) { try check(manifest { $0["appId"] = "com.example.other" }) }
        assertRefused(.wrongChannel) { try check(manifest { $0["channel"] = "beta" }) }
        assertRefused(.wrongFormat) { try check(manifest { $0["format"] = 2 }) }
    }

    func testAnOversizeBundleIsRefused() {
        assertRefused(.badFields) { try check(manifest { $0["size"] = EngineRelease.maxBundleBytes + 1 }) }
    }

    func testAnExpiredManifestIsRefusedForInstallButNotForAnInstalledBundle() throws {
        let late = issued.addingTimeInterval(31 * 86_400)
        assertRefused(.expired) { try check(manifest(), expect: expect(now: late)) }
        var installed = expect()
        installed.now = nil
        XCTAssertEqual(try check(manifest(), expect: installed).version, version)
    }

    func testAReleaseFromTheFutureIsRefused() {
        let early = issued.addingTimeInterval(-3 * 86_400)
        assertRefused(.fromTheFuture) { try check(manifest(), expect: expect(now: early)) }
    }
}
