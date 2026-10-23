import XCTest
@testable import HealthRoadmap

/// Engine work runs on the engine's own queue, never the main thread (Brad 2026-10-22,
/// ios/architecture.md D2 stage 2). The plan, an edit and My data wait on nothing from
/// the main thread, and the engine's queue never waits on the main thread.
@MainActor
final class EngineThreadTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Engine Thread \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        UnitChoices().save()
    }

    func testThePlanAnEditAndMyDataNeverBlockTheMainThread() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let weight = try XCTUnwrap(store.myData?.vitals.first { $0.metric == "weight" })
        let other = store.myData?.unitSystem == "si" ? "conventional" : "si"

        await XCTAssertSaved(await store.apply(.profile(sex: "male", birthYear: 1970, birthMonth: 6, height: 178)))
        await XCTAssertSaved(await store.applyNow(.add(metric: "weight", value: 80, day: "2026-10-20")))
        await store.switchUnits(for: weight, to: other).value // My data, drawn again
        await store.showPhone().value // the phone's file, read and drawn
        let plan = try await engine.planSections(record: store.recordJSON, units: store.unitChoices.json, now: .now, deviceId: "test")
        XCTAssertFalse(plan.sections.isEmpty)

    }

    /// Stage 3 (US-25 AC21): a value's history page, a typed number, onboarding's unit
    /// conversion, a trial's confirm and the chat history all await the engine; none waits.
    func testHistoryNumbersConversionsTheTrialAndChatNeverBlockTheMainThread() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let chat = ChatHistoryStore(engine: engine, folder: folder, deviceId: "test")

        await XCTAssertSaved(await store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")))
        let history = await store.history(for: "weight")
        XCTAssertEqual(history?.rows.map(\.value), ["80.0"])
        XCTAssertEqual(TypedNumber.read("3,4"), 3.4)
        let pounds = await store.convert(70, metric: "weight", from: "si", to: "conventional")
        XCTAssertEqual(pounds?.text, "154")
        await store.confirmEngineTrial() // no trial: a no-op, never a wait
        await chat.record(ChatExchange(conversationId: "c1", isNew: true, userText: "What is ApoB?", assistantText: "A count.", isFallback: false), askedAt: ChatHistoryStore.erasures)
        XCTAssertEqual(chat.conversations.map(\.id), ["c1"])
        let messages = await chat.open("c1").value
        XCTAssertEqual(messages?.count, 2)
        await chat.delete("c1").value
        XCTAssertEqual(chat.conversations, [])

    }

    /// Launch (US-25 AC21): the engine's load, the first read of the record and the sync's
    /// attach run off the main thread, and the attach still lands before any later engine call.
    func testLaunchNeverBlocksTheMainThreadAndTheAttachLandsFirst() async throws {
        let engine = try await EngineBoot(folder: nil, bundled: BundledEngine(), foreground: true).start().engine
        let store = try await RecordStore.open(folder: folder, engine: engine, deviceId: "test")
        XCTAssertNotNil(store.myData, "the record was read and drawn before the store was handed out")
        let tokens = TokenStore(service: "test.\(UUID().uuidString)")
        let sync = CloudSync(engine: engine, store: store, oauth: OAuthClient(tokens: tokens, session: StubHTTP.session()))
        let attached = await engine.perform { $0.natives.cloud === sync }
        XCTAssertTrue(attached, "the attach was queued ahead of this call")
    }

    func testAPlanNoLongerWantedIsNotStarted() async throws {
        let engine = try HealthEngine()
        let record = try engine.blocking { try $0.newRecord(now: .now, deviceId: "test") }
        let task = Task { try await engine.planSections(record: record, units: "{}", now: .now, deviceId: "test") }
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("a cancelled plan ran")
        } catch is CancellationError {}
    }

    func testTheEngineRunsOnItsOwnQueue() async throws {
        let engine = try HealthEngine()
        let onMain = await engine.onMainThread()
        XCTAssertFalse(onMain, "an awaited engine call runs off the main thread")
        // The tests' `blocking` runs on the engine's queue too, off the waiting main thread,
        // so JavaScript runs there without tripping the engine's precondition (US-25 AC21b).
        let off = engine.blocking { engine in
            dispatchPrecondition(condition: .onQueue(engine.queue))
            return !Thread.isMainThread
        }
        XCTAssertTrue(off)
        XCTAssertNoThrow(try engine.blocking { try $0.newRecord(now: .now, deviceId: "test") })
    }

    /// The engine's queue never waits on the main thread: nothing in the natives waits for
    /// it (`main.sync`) or assumes it is already there (`assumeIsolated`), either of which
    /// would deadlock while a test waits from main in `blocking`.
    func testTheNativesNeverWaitOnTheMainThread() throws {
        let source = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent()
            .appending(path: "HealthRoadmap/Engine/EngineNatives.swift")
        guard FileManager.default.fileExists(atPath: source.path(percentEncoded: false)) else {
            throw XCTSkip("The app's sources are not on this device (a real iPhone); the simulator run checks them.")
        }
        let text = try String(contentsOf: source, encoding: .utf8)
        XCTAssertFalse(text.contains("main.sync"))
        XCTAssertFalse(text.contains("assumeIsolated"))
        XCTAssertTrue(text.contains("DispatchQueue.main.async"), "news goes to the main thread without waiting")
    }
}
