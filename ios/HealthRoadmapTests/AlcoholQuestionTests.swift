import XCTest
@testable import HealthRoadmap

/// US-60: "Do you drink alcohol?", asked by the reduce-alcohol card's Dismiss and in
/// About you. The answer goes through the engine's profile write; the engine alone
/// decides which cards the plan holds (ios/engine/my-data.test.ts holds the Node side).
final class AlcoholQuestionTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))

    private func apply(_ engine: HealthEngine, _ edit: RecordEdit, to record: String) throws -> String {
        let outcome = try engine.blocking { [now] in try $0.apply(edit, to: record, now: now, deviceId: "test") }
        XCTAssertTrue(outcome.ok, outcome.message ?? "")
        return try XCTUnwrap(outcome.record)
    }

    /// A man of 56 at 175 cm and 100 kg: BMI 32.7, so the engine suggests reducing alcohol.
    private func heavyRecord(_ engine: HealthEngine) throws -> String {
        var record = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        record = try apply(engine, .profile(sex: "male", birthYear: 1970, height: 175), to: record)
        return try apply(engine, .add(metric: "weight", value: 100, day: "2026-10-20"), to: record)
    }

    private func answer(_ engine: HealthEngine, _ record: String) throws -> MyData.Alcohol? {
        try engine.blocking { [now] in try $0.myData(recordJSON: record, now: now, deviceId: "test") }.profile.alcohol?.value
    }

    private func suggestionIds(_ engine: HealthEngine, _ record: String) throws -> [String] {
        let drawn = try engine.blocking { [now] in try $0.screen(recordJSON: record, now: now, deviceId: "test") }
        guard case .planned(_, let sections, _) = drawn.plan else { XCTFail("no plan"); return [] }
        return sections.flatMap { $0.cards.flatMap { $0.suggestions.map(\.id) } }
    }

    func testTheAnswerSavesAndNotAnsweredClearsIt_US60() throws {
        let engine = try HealthEngine()
        let start = try heavyRecord(engine)
        XCTAssertNil(try answer(engine, start))
        let none = try apply(engine, .alcohol(.noDrinking), to: start)
        XCTAssertEqual(try answer(engine, none), .noDrinking)
        let drinks = try apply(engine, .alcohol(.drinks), to: none)
        XCTAssertEqual(try answer(engine, drinks), .drinks)
        let cleared = try apply(engine, .alcohol(nil), to: drinks)
        XCTAssertNil(try answer(engine, cleared))
        // Cleared is stored as null, as every cleared profile field is, so it merges as a write.
        let profile = try XCTUnwrap((JSONSerialization.jsonObject(with: Data(cleared.utf8)) as? [String: Any])?["profile"] as? [String: Any])
        XCTAssertTrue(profile["alcohol"] is NSNull)
        // Another profile edit keeps the answer.
        let kept = try apply(engine, .profile(birthMonth: 6), to: none)
        XCTAssertEqual(try answer(engine, kept), .noDrinking)
    }

    func testTheEngineAloneRemovesTheCardForIDontDrink_US60() throws {
        let engine = try HealthEngine()
        let start = try heavyRecord(engine)
        XCTAssertTrue(try suggestionIds(engine, start).contains(Suggestion.reduceAlcohol))
        XCTAssertTrue(try suggestionIds(engine, try apply(engine, .alcohol(.drinks), to: start)).contains(Suggestion.reduceAlcohol), "I drink keeps it")
        let none = try apply(engine, .alcohol(.noDrinking), to: start)
        XCTAssertFalse(try suggestionIds(engine, none).contains(Suggestion.reduceAlcohol), "I don't drink removes it")
        XCTAssertTrue(try suggestionIds(engine, try apply(engine, .alcohol(nil), to: none)).contains(Suggestion.reduceAlcohol), "Not answered brings it back")
    }

    @MainActor
    func testOnlyTheReduceAlcoholSuggestionCanBeDismissed_US60() throws {
        func suggestion(_ id: String) throws -> Suggestion {
            try JSONDecoder().decode(Suggestion.self, from: Data(#"{"id":"\#(id)","category":"nutrition","priority":"attention","title":"T","description":"D"}"#.utf8))
        }
        let alcohol = try suggestion("reduce-alcohol")
        let other = try suggestion("trig-nutrition")
        var asked = 0
        let card = PlanCard(category: "nutrition", priority: "attention", suggestions: [other, alcohol])
        let view = PlanCardView(card: card, askAboutAlcohol: { asked += 1; return { _ in } })
        XCTAssertNil(view.dismiss(for: other))
        _ = try XCTUnwrap(view.dismiss(for: alcohol))()
        XCTAssertEqual(asked, 1)
        for id in ["statin-consider", "trig-very-high", "weight-loss", "reduce-alcohol-x"] {
            XCTAssertNil(view.dismiss(for: try suggestion(id)), id)
        }
        XCTAssertNil(PlanCardView(card: card).dismiss(for: alcohol), "no action given, no button")
    }

    /// Only the card holding reduce-alcohol is handed the question; the rest get nil, so
    /// they stay comparable. Once answered (nil), no card is.
    @MainActor
    func testOnlyTheReduceAlcoholCardIsHandedTheQuestion_US60() throws {
        func card(_ ids: String...) throws -> PlanCard {
            let suggestions = try ids.map { try JSONDecoder().decode(Suggestion.self, from: Data(#"{"id":"\#($0)","category":"nutrition","priority":"attention","title":"T","description":"D"}"#.utf8)) }
            return PlanCard(category: "nutrition", priority: "attention", suggestions: suggestions)
        }
        var asked = 0
        let list = PlanList(tiles: [], sections: [], planMs: 0, showMyData: {}, askAboutAlcohol: { asked += 1; return { _ in } })
        _ = try XCTUnwrap(list.asksAboutAlcohol(try card("trig-nutrition", "reduce-alcohol")))()
        XCTAssertEqual(asked, 1)
        XCTAssertNil(list.asksAboutAlcohol(try card("trig-nutrition", "weight-loss")))
        let answered = PlanList(tiles: [], sections: [], planMs: 0, showMyData: {}, askAboutAlcohol: nil)
        XCTAssertNil(answered.asksAboutAlcohol(try card("reduce-alcohol")), "answered: no Dismiss")
    }

    func testTheAlcoholFieldDecodesLeniently_US60() throws {
        func profile(_ alcohol: String?) throws -> MyData.Profile {
            let field = alcohol.map { #","alcohol":\#($0)"# } ?? ""
            return try JSONDecoder().decode(MyData.Profile.self, from: Data(#"{"sex":"male","heightUnit":"cm"\#(field)}"#.utf8))
        }
        XCTAssertNil(try profile(nil).alcohol?.value, "an older engine sends no field")
        XCTAssertNil(try profile("null").alcohol?.value)
        XCTAssertEqual(try profile(#""none""#).alcohol?.value, .noDrinking)
        XCTAssertEqual(try profile(#""drinks""#).alcohol?.value, .drinks)
        for odd in [#""sometimes""#, "3", "{}", "true"] {
            let read = try profile(odd)
            XCTAssertNil(read.alcohol?.value, odd)
            XCTAssertEqual(read.sex, "male", "an odd answer never hides the rest of the profile")
        }
    }

    func testTheAnswerEncodesAsTheEngineReadsIt_US60() throws {
        func object(_ edit: RecordEdit) throws -> [String: Any] {
            try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(edit)) as? [String: Any])
        }
        XCTAssertEqual(try object(.alcohol(.noDrinking))["alcohol"] as? String, "none")
        XCTAssertEqual(try object(.alcohol(.drinks))["alcohol"] as? String, "drinks")
        let cleared = try object(.alcohol(nil))
        XCTAssertEqual(cleared["kind"] as? String, "alcohol")
        XCTAssertTrue(cleared["alcohol"] is NSNull, "Not answered is sent as null, never left out")
    }
}
