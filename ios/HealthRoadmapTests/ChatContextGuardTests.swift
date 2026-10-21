import XCTest
@testable import HealthRoadmap

/// Review R7 (US-25 AC18, US-52 AC5): the engine can be updated over the air, so the
/// chat context it hands Swift for our server is checked: a JSON object with a unit
/// system, under a size cap.
final class ChatContextGuardTests: XCTestCase {
    private func body(_ context: String) throws -> Data {
        try ChatClient.body(message: "Hi", conversationId: "c1", history: [], contextJSON: context)
    }

    func testTheEnginesContextIsSent() throws {
        let engine = try HealthEngine()
        let record = try engine.newRecord(now: .now, deviceId: "test")
        let context = try engine.chatContext(recordJSON: record, now: .now, deviceId: "test")
        let sent = try JSONSerialization.jsonObject(with: body(context)) as? [String: Any]
        XCTAssertNotNil(sent?["guestInputs"] as? [String: Any])
    }

    func testAContextOfAnotherShapeIsRefused() {
        for context in ["[1,2]", "\"text\"", "{}", #"{"unitSystem":5}"#, "not json"] {
            XCTAssertThrowsError(try body(context), context)
        }
    }

    func testAnOversizedContextIsRefused() {
        let padding = String(repeating: "x", count: ChatClient.maxContextBytes)
        XCTAssertThrowsError(try body(#"{"unitSystem":"si","pad":"\#(padding)"}"#))
    }
}
