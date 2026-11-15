import os
import UIKit
import XCTest
@testable import HealthRoadmap

/// Design PR 14 (US-52 AC7e, AC7f, AC8c): the runner carries out the engine's effects, steps one
/// event at a time, and decides nothing. The real bundled engine steps; the network is StubHTTP.
/// Synthetic files only.
@MainActor
final class UploadRunnerTests: XCTestCase {
    /// App Attest that always signs with its one key.
    struct Attest: AttestService {
        var isSupported: Bool { true }
        func generateKey() async throws -> String { "key" }
        func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data { Data("attestation".utf8) }
        func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data { Data("assertion".utf8) }
    }

    /// Counts what the stand-in server saw.
    final class Server: Sendable {
        let reads = OSAllocatedUnfairLock(initialState: 0)
        var count: Int { reads.withLock { $0 } }
    }

    nonisolated static let extraction = #"{"classification":"lab_report","reportDate":"2026-10-01","values":[],"additionalValues":[],"document":null}"#
    nonisolated static let finalLine = #"{"status":200,"body":{"success":true,"data":\#(extraction)}}"#
    nonisolated static let json = ["Content-Type": "application/json"]

    private var server = Server()

    override func setUp() {
        server = Server()
        StubHTTP.stopped = 0
        UploadRunner.stepWatch = nil
    }

    override func tearDown() {
        UploadRunner.stepWatch = nil
    }

    /// Answers every lab read with `answer`, counting them.
    private func serve(_ answer: @escaping @Sendable (Int) -> StubHTTP.Answer) {
        let server = server
        StubHTTP.handler = { request in
            guard request.url.path == LabReadSender.path else { return .init(status: 404) }
            let n = server.reads.withLock { $0 += 1; return $0 }
            return answer(n)
        }
    }

    nonisolated private static func read(_ body: String = "{\"accepted\":true}\n\n\n\(finalLine)\n", gate: StubHTTP.Gate? = nil) -> StubHTTP.Answer {
        .init(status: 200, headers: ["Content-Type": "application/x-ndjson"], body: Data(body.utf8), bodyGate: gate)
    }

    private func runner(record: String = "", deadline: Duration = .seconds(20)) throws -> UploadRunner {
        let attest = AppAttestClient(session: StubHTTP.session(), service: Attest(), keys: KeyStore(read: { "key" }, save: { _ in }, delete: {}))
        let setup = UploadRunner.Setup(deviceId: "test", record: { record }, sender: LabReadSender(attest: attest, deadline: deadline), frame: .milliseconds(1))
        return UploadRunner(engine: try HealthEngine(), model: UploadModel(), setup: setup)
    }

    /// `count` distinct pictures, ids f0, f1, ...
    private static func pictures(_ count: Int) -> [UploadRunner.Picked] {
        (0..<count).map { n in
            let png = UIGraphicsImageRenderer(size: CGSize(width: 10 + n, height: 10)).pngData { _ in }
            return .init(id: "f\(n)", name: "report\(n).png", data: png)
        }
    }

    /// Each file's stage, by id, from the engine's state ("failed:network" for a failure).
    private func stages(_ runner: UploadRunner) async -> [String: String] {
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

    private func until(_ what: String, timeout: TimeInterval = 30, _ check: () async -> Bool) async throws {
        let end = Date().addingTimeInterval(timeout)
        while !(await check()) {
            guard Date() < end else { return XCTFail("timed out: \(what)") }
            try await Task.sleep(for: .milliseconds(20))
        }
    }

    private func allRead(_ runner: UploadRunner, _ count: Int) async -> Bool {
        let stages = await stages(runner)
        return stages.count == count && stages.values.allSatisfy { $0 == "read" }
    }

    // MARK: Sends

    /// 18 files: never more than 5 reads in flight, every one answered; the view keeps picked order.
    func testEighteenFilesNeverMoreThanFiveInFlight() async throws {
        let gate = StubHTTP.Gate()
        serve { _ in Self.read(gate: gate) }
        let runner = try runner()
        let files = Self.pictures(18)
        let picked = await runner.pick(files, needsConsent: false)
        XCTAssertTrue(picked)
        try await until("five in flight") { server.count == 5 }
        try await Task.sleep(for: .seconds(1))
        XCTAssertEqual(server.count, 5, "the engine holds the sixth until one ends")
        gate.open()
        try await until("all read") { await allRead(runner, 18) }
        XCTAssertEqual(server.count, 18)
        try await until("the view drawn") {
            guard case .drawn(let text) = runner.model.state,
                  let view = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let rows = (view["files"] as? [String: Any])?["rows"] as? [[String: Any]] else { return false }
            return rows.compactMap { $0["fileId"] as? String } == files.map(\.id)
        }
    }

    /// A file whose bytes the record already holds is never converted or sent.
    func testAKnownFileIsNeverSent() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Known-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "test")
        let letter = ##"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Letter","documentDate":null,"contentMarkdown":"# Letter","metadata":{}}}"##
        let bytes = Data("%PDF synthetic".utf8)
        let original = LabFileReader.Original(bytes, mimeType: "application/pdf")
        let choice = DocumentChoice(kind: .document, sourceFileName: "Letter.pdf", title: "Letter", documentDate: nil, mimeType: "application/pdf", contentHash: original.contentHash)
        _ = await store.saveDocument(extractionJSON: letter, choice: choice, original: original)
        serve { _ in Self.read() }
        let runner = try runner(record: store.recordJSON)
        let picked = await runner.pick([.init(id: "letter", name: "Letter.pdf", data: bytes)] + Self.pictures(1), needsConsent: false)
        XCTAssertTrue(picked)
        try await until("settled") { await stages(runner) == ["letter": "known", "f0": "read"] }
        XCTAssertEqual(server.count, 1, "only the new file was sent")
    }

    /// Keep-alive lines and the accepted line are skipped; the final line is the read.
    func testAStreamWithKeepAlivesThenItsFinalLine() async throws {
        serve { _ in Self.read("{\"accepted\":true}\n\n\n\n\n\(Self.finalLine)\n") }
        let runner = try runner()
        _ = await runner.pick(Self.pictures(1), needsConsent: false)
        try await until("read") { await allRead(runner, 1) }
    }

    /// A stream cut with no final line is the network failure, which Try again mends.
    func testAStreamCutWithNoFinalLineIsRetryable() async throws {
        serve { n in n == 1 ? Self.read("{\"accepted\":true}\n\n") : Self.read() }
        let runner = try runner()
        _ = await runner.pick(Self.pictures(1), needsConsent: false)
        try await until("failed") { await stages(runner) == ["f0": "failed:network"] }
        await runner.retry("f0")
        try await until("read on retry") { await allRead(runner, 1) }
        XCTAssertEqual(server.count, 2)
    }

    /// A 503 before any stream fails the file, and Try again mends it.
    func testA503FailsTheFileRetryably() async throws {
        serve { n in n == 1 ? .init(status: 503, headers: Self.json, body: Data(#"{"error":"Busy","reason":"unavailable"}"#.utf8)) : Self.read() }
        let runner = try runner()
        _ = await runner.pick(Self.pictures(1), needsConsent: false)
        try await until("failed") { await stages(runner) == ["f0": "failed:server"] }
        await runner.retry("f0")
        try await until("read on retry") { await allRead(runner, 1) }
    }

    /// The daily limit (429) stops the run: nothing more is sent, every file fails on it.
    func testTheDailyLimitStopsTheRun() async throws {
        serve { _ in .init(status: 429, headers: Self.json, body: Data(#"{"error":"Limit","code":"daily_limit"}"#.utf8)) }
        let runner = try runner()
        _ = await runner.pick(Self.pictures(8), needsConsent: false)
        try await until("all failed") {
            let stages = await stages(runner)
            return stages.count == 8 && stages.values.allSatisfy { $0 == "failed:dailyLimit" }
        }
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertLessThanOrEqual(server.count, 5, "no send started after the limit")
    }

    /// Stop cancels every read in flight: each request is cancelled for real.
    func testStopCancelsTheReadsInFlight() async throws {
        let gate = StubHTTP.Gate()
        serve { _ in Self.read(gate: gate) }
        let runner = try runner()
        _ = await runner.pick(Self.pictures(3), needsConsent: false)
        try await until("three in flight") { server.count == 3 }
        await runner.stop()
        try await until("cancelled") { StubHTTP.stopped >= 3 }
        try await until("stopped") { await stages(runner).values.allSatisfy { $0 == "stopped" } }
        gate.open()
    }

    /// A whole-request deadline ends a read that never finishes: the network failure.
    func testTheDeadlineEndsAReadThatNeverFinishes() async throws {
        serve { _ in Self.read(gate: StubHTTP.Gate()) }
        let runner = try runner(deadline: .milliseconds(500))
        _ = await runner.pick(Self.pictures(1), needsConsent: false)
        try await until("failed") { await stages(runner) == ["f0": "failed:network"] }
    }

    // MARK: Steps

    /// An answer for an earlier run is dropped by the engine: the state does not move.
    func testAStaleAnswerFromAnEarlierRunIsDropped() async throws {
        serve { _ in Self.read() }
        let runner = try runner()
        _ = await runner.pick(Self.pictures(1), needsConsent: false)
        try await until("read") { await allRead(runner, 1) }
        await runner.discard()
        _ = await runner.pick(Self.pictures(2), needsConsent: false)
        try await until("second run read") { await allRead(runner, 2) }
        let before = await runner.stateText
        await runner.submit(EngineNatives.json(["type": "hashed", "run": 1, "id": "f0", "hash": "sha256-00"]))
        let after = await runner.stateText
        XCTAssertEqual(after, before)
    }

    /// 100 events at once: every one is stepped, never two at a time.
    func testStepsAreSerialUnderOneHundredConcurrentEvents() async throws {
        let runner = try runner()
        _ = await runner.pick([], needsConsent: false)
        let watch = OSAllocatedUnfairLock(initialState: (active: 0, most: 0, steps: 0))
        UploadRunner.stepWatch = { starting in
            watch.withLock {
                if starting { $0.active += 1; $0.steps += 1; $0.most = max($0.most, $0.active) } else { $0.active -= 1 }
            }
        }
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<100 { group.addTask { await runner.close() } }
        }
        try await until("every step ended") { watch.withLock { $0.steps == 100 && $0.active == 0 } }
        XCTAssertEqual(watch.withLock { $0.most }, 1)
    }

    /// A ZIP's members are listed, hashed, converted and sent as the engine says, and every byte
    /// held goes once the upload is left.
    func testAZipsMembersRunAndAreForgotten() async throws {
        serve { _ in Self.read() }
        let runner = try runner()
        let zip = ZipLazyReadTests.zip(Self.pictures(3).map { .init($0.name, $0.data, deflate: true) })
        _ = await runner.pick([.init(id: "z", name: "labs.zip", data: zip)], needsConsent: false)
        try await until("members read") { await allRead(runner, 3) }
        let ids = Set(await stages(runner).keys)
        XCTAssertEqual(ids, ["z#0", "z#1", "z#2"])
        XCTAssertEqual(server.count, 3)
        let held = await runner.heldBytes
        XCTAssertGreaterThan(held, 0)
        await runner.discard()
        let left = await runner.heldBytes
        XCTAssertEqual(left, 0)
    }

    /// An engine without the shared upload's doors (an older over-the-air engine): the runner says
    /// so, sends nothing, and the app keeps today's flow.
    func testAnEngineWithoutTheDoorsLeavesTodaysFlow() async throws {
        serve { _ in Self.read() }
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let without = "HealthEngine = (function (e) { var o = Object.assign({}, e); delete o.uploadStartJson; delete o.uploadStepJson; return o; })(HealthEngine);"
        let engine = try HealthEngine(source: try String(contentsOf: url, encoding: .utf8) + "\n" + without, sourceURL: nil, session: StubHTTP.session())
        let setup = UploadRunner.Setup(deviceId: "test", record: { "" })
        let runner = UploadRunner(engine: engine, model: UploadModel(), setup: setup)
        let picked = await runner.pick(Self.pictures(1), needsConsent: false)
        XCTAssertFalse(picked)
        XCTAssertEqual(runner.model.state, .unavailable)
        XCTAssertEqual(server.count, 0)
    }

    /// The view's drawing, every state by every event: a state asked for while one is drawn is
    /// drawn next; nothing is drawn twice for one ask.
    func testTheViewLoopTable() {
        let table: [(ViewLoop, ViewLoop.Event, ViewLoop)] = [
            (.idle, .asked, .drawing), (.drawing, .asked, .drawingAgain), (.drawingAgain, .asked, .drawingAgain),
            (.idle, .drawn, .idle), (.drawing, .drawn, .idle), (.drawingAgain, .drawn, .drawing),
        ]
        for (from, event, to) in table { XCTAssertEqual(ViewLoop.transition(from, event), to, "\(from) \(event)") }
    }

    /// The request carries the pages, the unit system and only the flags that are true.
    func testTheBodyCarriesOnlyTrueFlags() throws {
        let page = LabFileReader.Page(type: "text", content: "x", mimeType: nil)
        let flags = try JSONDecoder().decode(LabReadSender.Flags.self, from: Data(#"{"ownDates":true,"undatedPrev":false,"refusedRows":true}"#.utf8))
        let body = try JSONSerialization.jsonObject(with: LabReadSender.body(pages: [page], unitSystem: "si", flags: flags)) as? [String: Any]
        XCTAssertEqual(Set(body?.keys.map { $0 } ?? []), ["pages", "unitSystem", "ownDates", "refusedRows"])
    }
}
