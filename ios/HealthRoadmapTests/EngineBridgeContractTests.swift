import CryptoKit
import JavaScriptCore
import XCTest
@testable import HealthRoadmap

/// US-25 AC18: the Swift side of the native bridge matches ios/engine/bridge-contract.json,
/// whose hash is the bridge id a downloaded engine must carry. The engine side:
/// ios/engine/bridge.test.ts. The simulator reads the repo's files from the Mac.
final class EngineBridgeContractTests: XCTestCase {
    private let ios = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()

    private struct Contract: Decodable {
        let natives: [String: String]
        let events: [String]
        let doors: [String: Door]
        struct Door: Decodable { let args: [String] }
    }

    private func contractBytes() throws -> Data {
        try Data(contentsOf: ios.appending(path: "engine/bridge-contract.json"))
    }

    func testTheBridgeIdIsTheContractsHash() throws {
        let hash = SHA256.hash(data: try contractBytes()).map { String(format: "%02x", $0) }.joined()
        XCTAssertEqual(EngineRelease.bridge, String(hash.prefix(16)), "bridge-contract.json changed: a new bridge id")
        XCTAssertEqual(try BundledEngine().facts.bridge, EngineRelease.bridge, "the bundled engine was built for another bridge")
    }

    func testTheNativesSwiftInstallsAreTheContracts() throws {
        let contract = try JSONDecoder().decode(Contract.self, from: contractBytes())
        let context = try XCTUnwrap(JSContext())
        EngineNatives(session: StubHTTP.session(), queue: DispatchSerialQueue(label: "test")).install(in: context)
        let installed = context.evaluateScript("Object.keys(__native).sort().join(',')")?.toString()
        XCTAssertEqual(installed, contract.natives.keys.sorted().joined(separator: ","))
    }

    func testTheDoorsTheSelfTestChecksAreTheContracts() throws {
        let contract = try JSONDecoder().decode(Contract.self, from: contractBytes())
        XCTAssertEqual(EngineRelease.doors.sorted(), contract.doors.keys.sorted())
        let engine = try HealthEngine()
        for (name, door) in contract.doors {
            XCTAssertEqual(try engine.blocking { try $0.evaluate("HealthEngine.\(name).length").toInt32() }, Int32(door.args.count), name)
        }
    }

    func testCloudSyncHandlesEveryContractEvent() throws {
        let contract = try JSONDecoder().decode(Contract.self, from: contractBytes())
        // Decoded on the engine's queue (`CloudNews`); CloudSync's switch over it is exhaustive.
        let source = try String(contentsOf: ios.appending(path: "HealthRoadmap/Engine/HealthEngine+Cloud.swift"), encoding: .utf8)
        for event in contract.events { XCTAssertTrue(source.contains("case \"\(event)\""), event) }
    }

    func testThePinnedKeysAreTheReleaseScriptsKeys() throws {
        let file = try JSONDecoder().decode([String: String].self, from: Data(contentsOf: ios.appending(path: "engine/signing-keys.json")))
        XCTAssertEqual(file, EngineRelease.publicKeys)
        XCTAssertEqual(Set(EngineRelease.publicKeys.keys), ["daily", "cold", "ci"])
        for (id, text) in EngineRelease.publicKeys {
            XCTAssertNoThrow(try Curve25519.Signing.PublicKey(rawRepresentation: XCTUnwrap(Data(base64Encoded: text))), id)
        }
    }
}
