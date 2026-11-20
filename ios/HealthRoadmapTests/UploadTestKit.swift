import os
import UIKit
import XCTest
@testable import HealthRoadmap

/// What the upload runner's and the lab-read sender's tests share (design PR 14): a stand-in App
/// Attest, a stand-in server on StubHTTP, synthetic pictures, and the engine state read back.
enum UploadTestKit {
    /// App Attest that signs with its one key, each assertion naming its counter ("a1", "a2", ...).
    final class Attest: AttestService, Sendable {
        let made = OSAllocatedUnfairLock(initialState: 0)
        /// A device without App Attest, or one whose every assertion fails with this error.
        let isSupported: Bool
        let assertFails: (any Error & Sendable)?
        init(supported: Bool = true, assertFails: (any Error & Sendable)? = nil) {
            isSupported = supported
            self.assertFails = assertFails
        }
        func generateKey() async throws -> String { "key" }
        func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data { Data("attestation".utf8) }
        func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data {
            if let assertFails { throw assertFails }
            return Data("a\(made.withLock { $0 += 1; return $0 })".utf8)
        }
    }

    /// What the stand-in server saw: how many lab reads, and their assertions in arrival order.
    final class Server: Sendable {
        let seen = OSAllocatedUnfairLock(initialState: [String]())
        var count: Int { seen.withLock { $0.count } }
        var counters: [Int] { seen.withLock { $0.compactMap { Data(base64Encoded: $0).flatMap { Int(String(decoding: $0.dropFirst(), as: UTF8.self)) } } } }
    }

    static let extraction = #"{"classification":"lab_report","reportDate":"2026-10-01","values":[],"additionalValues":[],"document":null}"#
    static let finalLine = #"{"status":200,"body":{"success":true,"data":\#(extraction)}}"#
    static let json = ["Content-Type": "application/json"]

    /// Answers every lab read with `answer(n)`, n counting from 1; App Attest's challenge and
    /// registration as given (by default, each accepted).
    static func serve(_ server: Server, challenge: StubHTTP.Answer = .init(body: Data(#"{"challenge":"c"}"#.utf8)),
                      register: StubHTTP.Answer = .init(body: Data(#"{"ok":true}"#.utf8)), _ answer: @escaping @Sendable (Int) -> StubHTTP.Answer) {
        StubHTTP.handler = { request in
            switch request.url.path {
            case "/api/app/v1/attest/challenge": return challenge
            case "/api/app/v1/attest/register": return register
            case LabReadSender.path: break
            default: return .init(status: 404)
            }
            let n = server.seen.withLock { $0.append(request.headers["x-app-attest-assertion"] ?? ""); return $0.count }
            return answer(n)
        }
    }

    static func read(_ body: String = "{\"accepted\":true}\n\n\n\(finalLine)\n", gate: StubHTTP.Gate? = nil, chunk: Int? = nil, delay: TimeInterval = 0) -> StubHTTP.Answer {
        .init(status: 200, headers: ["Content-Type": "application/x-ndjson"], body: Data(body.utf8), delay: delay, bodyGate: gate, chunk: chunk)
    }

    /// `stored`: the key id the Keychain holds, nil for a phone that must register one first.
    static func client(_ attest: Attest = Attest(), stored: String? = "key") -> AppAttestClient {
        AppAttestClient(session: StubHTTP.session(), service: attest, keys: KeyStore(read: { stored }, save: { _ in }, delete: {}))
    }

    /// `count` distinct pictures, ids f0, f1, ...
    static func pictures(_ count: Int, from: Int = 0) -> [UploadRunner.Picked] {
        (from..<(from + count)).map { n in
            let png = UIGraphicsImageRenderer(size: CGSize(width: 10 + n, height: 10)).pngData { _ in }
            return .init(id: "f\(n)", name: "report\(n).png", data: png)
        }
    }

    /// Each file's stage, by id, from the engine's state ("failed:network" for a failure).
    static func stages(_ runner: UploadRunner) async -> [String: String] {
        guard let text = await runner.stateText,
              let state = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
              let files = state["files"] as? [[String: Any]] else { return [:] }
        var out: [String: String] = [:]
        for file in files {
            let status = file["status"] as? [String: Any] ?? [:]
            let stage = status["s"] as? String ?? ""
            out[file["id"] as? String ?? ""] = (status["reason"] as? String).map { "\(stage):\($0)" } ?? stage
        }
        return out
    }

    static func allRead(_ runner: UploadRunner, _ count: Int) async -> Bool {
        let stages = await stages(runner)
        return stages.count == count && stages.values.allSatisfy { $0 == "read" }
    }

    /// Waits for `check`, run in the caller's isolation.
    static func until(_ what: String, timeout: TimeInterval = 30, isolation: isolated (any Actor)? = #isolation,
                      file: StaticString = #filePath, line: UInt = #line, _ check: () async -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !(await check()) {
            guard Date() < end else { return XCTFail("timed out: \(what)", file: file, line: line) }
            try await Task.sleep(for: .milliseconds(20))
        }
    }
}
