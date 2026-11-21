import os
import UIKit
import XCTest
@testable import HealthRoadmap

/// Design PR 14 (US-52 AC7e, AC7f, AC8c): the runner carries out the engine's effects, steps one
/// event at a time, and decides nothing. The real bundled engine steps; the network is StubHTTP.
/// Synthetic files only.
@MainActor
final class UploadRunnerTests: XCTestCase {
    typealias Kit = UploadTestKit
    private var server = Kit.Server()

    override func setUp() {
        server = Kit.Server()
        StubHTTP.stopped = 0
    }

    private func serve(_ answer: @escaping @Sendable (Int) -> StubHTTP.Answer) { Kit.serve(server, answer) }

    private func runner(record: @escaping @Sendable () async -> String = { "" }, readDeadline: Duration = .seconds(20),
                        ask: @escaping LabFileReader.AskRules = LabFileReader.swiftRules, watch: (@Sendable (Bool) -> Void)? = nil) throws -> UploadRunner {
        let setup = UploadRunner.Setup(deviceId: "test", record: record, ask: ask, sender: LabReadSender(attest: Kit.client(), readDeadline: readDeadline),
                                       frame: .milliseconds(1), watch: watch)
        return UploadRunner(engine: try HealthEngine(), model: UploadModel(), setup: setup)
    }

    private func stages(_ runner: UploadRunner) async -> [String: String] { await Kit.stages(runner) }
    private func until(_ what: String, line: UInt = #line, _ check: () async -> Bool) async throws { try await Kit.until(what, line: line, check) }

    // MARK: Sends

    /// 18 files: never more than 5 reads in flight, every one answered; the view keeps picked order.
    func testEighteenFilesNeverMoreThanFiveInFlight() async throws {
        let gate = StubHTTP.Gate()
        serve { _ in Kit.read(gate: gate) }
        let runner = try runner()
        let files = Kit.pictures(18)
        let picked = await runner.pick(files, needsConsent: false)
        XCTAssertTrue(picked)
        try await until("five in flight") { server.count == 5 }
        try await Task.sleep(for: .seconds(1))
        XCTAssertEqual(server.count, 5, "the engine holds the sixth until one ends")
        gate.open()
        try await until("all read") { await Kit.allRead(runner, 18) }
        XCTAssertEqual(server.count, 18)
        try await until("the view drawn") {
            guard case .drawn(let text) = runner.model.state,
                  let view = try? JSONSerialization.jsonObject(with: Data(text.utf8)) as? [String: Any],
                  let rows = (view["files"] as? [String: Any])?["rows"] as? [[String: Any]] else { return false }
            return rows.compactMap { $0["fileId"] as? String } == files.map(\.id)
        }
    }

    /// Five sends reach the server with their App Attest counters in order (the lock spans
    /// signing to headers), and all five stream at once.
    func testFiveSendsReachTheServerWithCountersInOrder() async throws {
        let gate = StubHTTP.Gate()
        serve { _ in Kit.read(gate: gate) }
        let runner = try runner()
        _ = await runner.pick(Kit.pictures(5), needsConsent: false)
        try await until("five in flight") { server.count == 5 }
        XCTAssertEqual(server.counters, [1, 2, 3, 4, 5])
        gate.open()
        try await until("all read") { await Kit.allRead(runner, 5) }
    }

    /// A file whose bytes the record already holds is never converted or sent.
    func testAKnownFileIsNeverSent() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Known-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let store = try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "test")
        let letter = ##"{"classification":"clinic_letter","reportDate":null,"values":[],"additionalValues":[],"document":{"classification":"clinic_letter","title":"Letter","documentDate":null,"contentMarkdown":"# Letter","metadata":{}}}"##
        let bytes = Data("%PDF synthetic".utf8)
        try await store.fileForTest(letter, name: "Letter.pdf", title: "Letter", mimeType: "application/pdf", hash: LabFileReader.contentHash(bytes))
        serve { _ in Kit.read() }
        let record = store.recordJSON
        let runner = try runner(record: { record })
        let picked = await runner.pick([.init(id: "letter", name: "Letter.pdf", data: bytes)] + Kit.pictures(1), needsConsent: false)
        XCTAssertTrue(picked)
        try await until("settled") { await stages(runner) == ["letter": "known", "f0": "read"] }
        XCTAssertEqual(server.count, 1, "only the new file was sent")
    }

    /// A stream cut with no final line is the network failure, which Try again mends.
    func testAStreamCutWithNoFinalLineIsRetryable() async throws {
        serve { n in n == 1 ? Kit.read("{\"accepted\":true}\n\n") : Kit.read() }
        let runner = try runner()
        _ = await runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("failed") { await stages(runner) == ["f0": "failed:network"] }
        await runner.retry("f0")
        try await until("read on retry") { await Kit.allRead(runner, 1) }
        XCTAssertEqual(server.count, 2)
    }

    /// A 503 before any stream fails the file, and Try again mends it.
    func testA503FailsTheFileRetryably() async throws {
        serve { n in n == 1 ? .init(status: 503, headers: Kit.json, body: Data(#"{"error":"Busy","reason":"unavailable"}"#.utf8)) : Kit.read() }
        let runner = try runner()
        _ = await runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("failed") { await stages(runner) == ["f0": "failed:server"] }
        await runner.retry("f0")
        try await until("read on retry") { await Kit.allRead(runner, 1) }
    }

    /// The daily limit (429) stops the run: nothing more is sent, every file fails on it.
    func testTheDailyLimitStopsTheRun() async throws {
        serve { _ in .init(status: 429, headers: Kit.json, body: Data(#"{"error":"Limit","code":"daily_limit"}"#.utf8)) }
        let runner = try runner()
        _ = await runner.pick(Kit.pictures(8), needsConsent: false)
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
        serve { _ in Kit.read(gate: gate) }
        let runner = try runner()
        _ = await runner.pick(Kit.pictures(3), needsConsent: false)
        try await until("three in flight") { server.count == 3 }
        await runner.stop()
        try await until("cancelled") { StubHTTP.stopped >= 3 }
        try await until("stopped") { await stages(runner).values.allSatisfy { $0 == "stopped" } }
        gate.open()
    }

    /// A runner dropped by its owner cancels its reads in flight.
    func testADroppedRunnerCancelsItsReads() async throws {
        let gate = StubHTTP.Gate()
        serve { _ in Kit.read(gate: gate) }
        var runner: UploadRunner? = try runner()
        _ = await runner?.pick(Kit.pictures(2), needsConsent: false)
        try await until("two in flight") { server.count == 2 }
        runner = nil
        try await until("cancelled") { StubHTTP.stopped >= 2 }
        gate.open()
    }

    // MARK: Picks

    /// Close while a pick waits for its rules: nothing is held and nothing is sent.
    func testCloseDuringAPendingPickHoldsAndSendsNothing() async throws {
        serve { _ in Kit.read() }
        let runner = try runner(ask: { _, _ in try? await Task.sleep(for: .milliseconds(500)); return .swift })
        async let picked = runner.pick(Kit.pictures(2), needsConsent: false)
        try await Task.sleep(for: .milliseconds(100))
        await runner.close()
        let ran = await picked
        XCTAssertFalse(ran)
        let held = await runner.heldBytes
        XCTAssertEqual(held, 0)
        try await Task.sleep(for: .milliseconds(300))
        XCTAssertEqual(server.count, 0)
    }

    /// Two picks before the engine has started: one start is shared, never a second state. The
    /// newer pick replaces the older: the older answers false having held and sent nothing, or, if
    /// it got in first, the engine discards its run (`discard`, then the newer `picked`). Either
    /// way only the newer pick's files are in the upload.
    func testTwoQuickFirstPicksTheNewerReplacesTheOlder() async throws {
        serve { _ in Kit.read() }
        let runner = try runner()
        async let first = runner.pick(Kit.pictures(1), needsConsent: false)
        async let second = runner.pick(Kit.pictures(2, from: 5), needsConsent: false)
        let (_, two) = await (first, second)
        XCTAssertTrue(two)
        try await until("the newer pick read") { await stages(runner) == ["f5": "read", "f6": "read"] }
        let run = await runner.stateText.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }?["run"] as? Int
        XCTAssertLessThanOrEqual(run ?? 0, 2, "one engine state: runs counted on, never restarted")
    }

    /// A pick after a run replaces it through the engine's own events: Discard, then the pick.
    func testAPickAfterARunReplacesItThroughTheEngine() async throws {
        serve { _ in Kit.read() }
        let runner = try runner()
        _ = await runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("read") { await Kit.allRead(runner, 1) }
        _ = await runner.pick(Kit.pictures(2, from: 3), needsConsent: false)
        try await until("second run read") { await stages(runner) == ["f3": "read", "f4": "read"] }
    }

    /// Codex re-check A: run 1's send of f0 finishes only after a new pick reuses f0 (same id, same
    /// attempt). Its late end never touches run 2's send: run 2's read is answered, and in a second
    /// pass Stop still cancels it.
    func testALateSendFromAnEarlierRunNeverTouchesTheNewOne() async throws {
        for stopping in [false, true] {
            let calls = OSAllocatedUnfairLock(initialState: 0)
            let oldDone = StubHTTP.Gate(), newDone = StubHTTP.Gate()
            let cancelled = OSAllocatedUnfairLock(initialState: false)
            let send: @Sendable (Data) async throws -> LabReadSender.Outcome = { _ in
                let n = calls.withLock { $0 += 1; return $0 }
                if n == 1 {
                    // Run 1's read: it ends when the test says, deaf to its abort.
                    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in oldDone.hold { done.resume() } }
                } else {
                    let open = OSAllocatedUnfairLock(initialState: false)
                    newDone.hold { open.withLock { $0 = true } }
                    while !open.withLock({ $0 }) {
                        do { try await Task.sleep(for: .milliseconds(10)) } catch { cancelled.withLock { $0 = true }; throw error }
                    }
                }
                return .ended(line: Kit.finalLine)
            }
            let setup = UploadRunner.Setup(deviceId: "test", record: { "" }, ask: LabFileReader.swiftRules, send: send, frame: .milliseconds(1))
            let runner = UploadRunner(engine: try HealthEngine(), model: UploadModel(), setup: setup)
            _ = await runner.pick(Kit.pictures(1), needsConsent: false)
            try await until("run 1 sending") { calls.withLock { $0 } == 1 }
            _ = await runner.pick(Kit.pictures(1), needsConsent: false)
            try await until("run 2 sending") { calls.withLock { $0 } == 2 }
            oldDone.open()
            try await Task.sleep(for: .milliseconds(200))
            if stopping {
                await runner.stop()
                try await until("run 2's send cancelled") { cancelled.withLock { $0 } }
                newDone.open()
            } else {
                newDone.open()
                try await until("run 2's read answered") { await Kit.allRead(runner, 1) }
            }
        }
    }

    // MARK: Steps

    /// An answer for an earlier run is dropped by the engine: the state does not move.
    func testAStaleAnswerFromAnEarlierRunIsDropped() async throws {
        serve { _ in Kit.read() }
        let runner = try runner()
        _ = await runner.pick(Kit.pictures(1), needsConsent: false)
        try await until("read") { await Kit.allRead(runner, 1) }
        _ = await runner.pick(Kit.pictures(2), needsConsent: false)
        try await until("second run read") { await Kit.allRead(runner, 2) }
        let before = await runner.stateText
        await runner.submit(EngineNatives.json(["type": "hashed", "run": 1, "id": "f0", "hash": "sha256-00"]))
        let after = await runner.stateText
        XCTAssertEqual(after, before)
    }

    /// 100 events at once: every one is stepped, never two at a time.
    func testStepsAreSerialUnderOneHundredConcurrentEvents() async throws {
        let watch = OSAllocatedUnfairLock(initialState: (active: 0, most: 0, steps: 0))
        let runner = try runner(watch: { starting in
            watch.withLock {
                if starting { $0.active += 1; $0.steps += 1; $0.most = max($0.most, $0.active) } else { $0.active -= 1 }
            }
        })
        _ = await runner.pick([], needsConsent: false)
        watch.withLock { $0 = (0, 0, 0) }
        await withTaskGroup(of: Void.self) { group in
            for _ in 0..<100 { group.addTask { await runner.stop() } }
        }
        try await until("every step ended") { watch.withLock { $0.steps == 100 && $0.active == 0 } }
        XCTAssertEqual(watch.withLock { $0.most }, 1)
    }

    /// A step the engine refuses (a record a newer app wrote, on a read's end) stops the run: the
    /// refusal stays on the screen, nothing is left in flight, and Discard leaves nothing held.
    func testARefusedStepStopsTheRunAndStays() async throws {
        let gate = StubHTTP.Gate()
        serve { _ in Kit.read(gate: gate) }
        let record = OSAllocatedUnfairLock(initialState: "")
        let runner = try runner(record: { record.withLock { $0 } })
        _ = await runner.pick(Kit.pictures(2), needsConsent: false)
        try await until("two in flight") { server.count == 2 }
        record.withLock { $0 = #"{"schemaVersion": 999, "measurements": []}"# }
        gate.open()
        try await until("refused") { runner.model.state == .refused(UploadDoors.Refusal(reason: "record-too-new", message: "A newer version of Health Roadmap wrote this record. Update the app to open it.")) }
        try await until("nothing in flight") { await stages(runner).values.allSatisfy { ["stopped", "read"].contains($0) } }
        try await Task.sleep(for: .milliseconds(200))
        guard case .refused = runner.model.state else { return XCTFail("a later view drew over the refusal: \(runner.model.state)") }
        await runner.discard()
        let held = await runner.heldBytes
        XCTAssertEqual(held, 0)
    }

    /// A ZIP's members are listed, hashed, converted and sent as the engine says, and every byte
    /// held goes once the upload is left.
    func testAZipsMembersRunAndAreForgotten() async throws {
        serve { _ in Kit.read() }
        let runner = try runner()
        let zip = ZipLazyReadTests.zip(Kit.pictures(3).map { .init($0.name, $0.data, deflate: true) })
        _ = await runner.pick([.init(id: "z", name: "labs.zip", data: zip)], needsConsent: false)
        try await until("members read") { await Kit.allRead(runner, 3) }
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
        serve { _ in Kit.read() }
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let without = "HealthEngine = (function (e) { var o = Object.assign({}, e); delete o.uploadStartJson; delete o.uploadStepJson; return o; })(HealthEngine);"
        let engine = try HealthEngine(source: try String(contentsOf: url, encoding: .utf8) + "\n" + without, sourceURL: nil, session: StubHTTP.session())
        let runner = UploadRunner(engine: engine, model: UploadModel(), setup: .init(deviceId: "test", record: { "" }))
        let picked = await runner.pick(Kit.pictures(1), needsConsent: false)
        XCTAssertFalse(picked)
        XCTAssertEqual(runner.model.state, .unavailable)
        XCTAssertEqual(server.count, 0)
    }

    /// The screen's state: a refusal stays until the next pick; the view loop, every state by every event.
    func testTheModelAndViewLoopTables() {
        let refusal = UploadModel.State.refused(nil)
        let model: [(UploadModel.State, UploadModel.State, UploadModel.State)] = [
            (.starting, .drawn("v"), .drawn("v")), (refusal, .drawn("v"), refusal), (refusal, .starting, .starting),
            (.drawn("v"), refusal, refusal), (refusal, .unavailable, .unavailable),
        ]
        for (from, next, to) in model { XCTAssertEqual(UploadModel.State.transition(from, next), to, "\(from) \(next)") }
        let loop: [(ViewLoop, ViewLoop.Event, ViewLoop)] = [
            (.idle, .asked, .drawing), (.drawing, .asked, .drawingAgain), (.drawingAgain, .asked, .drawingAgain),
            (.idle, .drawn, .idle), (.drawing, .drawn, .idle), (.drawingAgain, .drawn, .drawing),
        ]
        for (from, event, to) in loop { XCTAssertEqual(ViewLoop.transition(from, event), to, "\(from) \(event)") }
    }
}
