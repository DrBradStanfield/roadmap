import XCTest
@testable import HealthRoadmap

/// US-52 AC17 (root fix R29, lead C24): a saved conversation's read is one state, and a
/// read that fails is a failed state, never an empty conversation a question could go to.
final class ChatThreadReadTests: XCTestCase {
    typealias S = ChatThreadRead

    /// Every state by every event: open, the current read loaded or unreadable, an older
    /// read's answer, leave.
    func testTheTransitionTable_US52_AC17() {
        let ready = S.ready(attempt: 2), loading = S.loading(id: "c1", attempt: 2), failed = S.failed(id: "c1", attempt: 2)
        let rows: [(S, S.Event, S)] = [
            (ready, .open(id: "c2"), .loading(id: "c2", attempt: 3)),
            (ready, .loaded(attempt: 2), ready),
            (ready, .unreadable(attempt: 2), ready),
            (ready, .unreadable(attempt: 1), ready),
            (ready, .loaded(attempt: 1), ready),
            (ready, .leave, .ready(attempt: 3)),

            (loading, .open(id: "c2"), .loading(id: "c2", attempt: 3)),
            (loading, .loaded(attempt: 2), .ready(attempt: 2)),
            (loading, .unreadable(attempt: 2), .failed(id: "c1", attempt: 2)),
            (loading, .unreadable(attempt: 1), loading),
            (loading, .loaded(attempt: 1), loading),
            (loading, .leave, .ready(attempt: 3)),

            (failed, .open(id: "c1"), .loading(id: "c1", attempt: 3)),
            (failed, .loaded(attempt: 2), failed),
            (failed, .loaded(attempt: 1), failed),
            (failed, .unreadable(attempt: 2), failed),
            (failed, .leave, .ready(attempt: 3)),
        ]
        for (state, event, next) in rows {
            XCTAssertEqual(S.transition(state, event), next, "\(state) + \(event)")
        }
        XCTAssertEqual([ready, loading, failed].map(\.canAsk), [true, false, false], "a question waits while a read is under way or failed")
    }

    private func folder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Chat Thread \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return folder
    }

    /// A history file the engine cannot read answers a failed state, not an empty conversation;
    /// Try again once it reads opens the conversation, and New chat lets the failure go.
    @MainActor
    func testAnUnreadableConversationIsAFailedStateNeverAnEmptyOne_US52_AC17() async throws {
        let folder = try folder()
        let file = folder.appending(path: "chat-history.json")
        let chat = ChatHistoryStore(engine: try HealthEngine(), folder: folder, deviceId: "test")
        await chat.record(ChatExchange(conversationId: "c1", isNew: true, userText: "Q", assistantText: "A.", isFallback: false), askedAt: ChatHistoryStore.erasures)
        let saved = try Data(contentsOf: file)

        try Data("not json".utf8).write(to: file)
        let opened = await chat.open("c1").value
        XCTAssertNil(opened, "no conversation is drawn")
        guard case .failed(id: "c1", _) = chat.thread else { return XCTFail("\(chat.thread)") }
        XCTAssertFalse(chat.thread.canAsk, "no question goes without the conversation's turns")

        try saved.write(to: file)
        let again = await chat.open("c1").value // Try again
        XCTAssertEqual(again?.map(\.content), ["Q", "A."])
        XCTAssertTrue(chat.thread.canAsk)

        try Data("not json".utf8).write(to: file)
        _ = await chat.open("c1").value
        chat.leave() // New chat
        XCTAssertTrue(chat.thread.canAsk)
    }

    /// A read the screen left (New chat while it ran) answers nothing and leaves no failure.
    @MainActor
    func testALeftReadThatFailsLeavesNoFailure_US52_AC17() async throws {
        let folder = try folder()
        try Data("not json".utf8).write(to: folder.appending(path: "chat-history.json"))
        let chat = ChatHistoryStore(engine: try HealthEngine(), folder: folder, deviceId: "test")
        let loading = chat.open("c1")
        chat.leave()
        let late = await loading.value
        XCTAssertNil(late)
        XCTAssertTrue(chat.thread.canAsk, "the left read's failure never shows")
    }
}
