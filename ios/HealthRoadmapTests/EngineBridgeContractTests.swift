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

    /// Both-way additions that keep the bridge id (D14), never hashed.
    private struct Additions: Decodable {
        let doors: [String: Door]
        /// Whole doors left out of the hash (2026-11-05): reached only through `optionalCall`.
        let optionalDoors: [String: OptionalDoor]
        struct Door: Decodable { let optionalArgs: [String]? }
        struct OptionalDoor: Decodable { let args: [String] }
    }

    private func contractBytes() throws -> Data {
        try Data(contentsOf: ios.appending(path: "engine/bridge-contract.json"))
    }

    private func additions() throws -> Additions {
        try JSONDecoder().decode(Additions.self, from: Data(contentsOf: ios.appending(path: "engine/bridge-optional.json")))
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
        let extra = try additions()
        let engine = try HealthEngine()
        for (name, door) in contract.doors {
            let arity = door.args.count + (extra.doors[name]?.optionalArgs?.count ?? 0)
            XCTAssertEqual(try engine.blocking { try $0.evaluate("HealthEngine.\(name).length").toInt32() }, Int32(arity), name)
        }
        XCTAssertTrue(Set(extra.doors.keys).isSubset(of: contract.doors.keys))
    }

    /// An optional door keeps the bridge id: an old app never calls it, and a new app reaches it
    /// only through `optionalCall`, which reads a missing door as the feature unavailable. A new
    /// app normally runs an engine at least as new as its bundled one (anti-rollback), but safety
    /// rests on the nil, not on that. So: never in the contract or the self-test's list, in the
    /// bundled engine with its arity, and called from the app only through `optionalCall`.
    func testAnOptionalDoorIsOutsideTheContractAndCalledOnlyThroughTheGuard() throws {
        let contract = try JSONDecoder().decode(Contract.self, from: contractBytes())
        let optional = try additions().optionalDoors
        XCTAssertFalse(optional.isEmpty)
        let engine = try HealthEngine()
        let app = ios.appending(path: "HealthRoadmap")
        let sources = try XCTUnwrap(FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil)).compactMap { $0 as? URL }
            .filter { $0.pathExtension == "swift" }.map { try String(contentsOf: $0, encoding: .utf8) }
        for (name, door) in optional {
            XCTAssertNil(contract.doors[name], name)
            XCTAssertFalse(EngineRelease.doors.contains(name), name)
            XCTAssertEqual(try engine.blocking { try $0.evaluate("HealthEngine.\(name).length").toInt32() }, Int32(door.args.count), name)
            let calls = sources.flatMap { $0.components(separatedBy: "\n") }.filter { $0.contains("\"\(name)\"") }
            XCTAssertFalse(calls.isEmpty, name)
            for line in calls { XCTAssertTrue(line.contains("optionalCall(\"\(name)\""), "\(name) called outside optionalCall: \(line)") }
        }
    }

    /// US-73 AC8: the search answers through the guard; a door the engine lacks is nil, not a crash.
    func testTheGuardReadsAMissingDoorAsUnavailable() throws {
        let engine = try HealthEngine()
        XCTAssertNil(try engine.blocking { try $0.optionalCall("noSuchOptionalDoor", []) })
        let matches = try XCTUnwrap(engine.blocking { try $0.labSearch("ferr") })
        XCTAssertEqual(matches.first, LabSearchMatch(name: "Ferritin", key: "ferritin", kind: "catalogue", units: matches.first?.units ?? []))
        XCTAssertEqual(matches.first?.units.first, "µg/L")
        XCTAssertTrue(matches.first?.units.contains("ng/ml") ?? false)
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
