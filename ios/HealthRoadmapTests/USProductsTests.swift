import Observation
import XCTest
@testable import HealthRoadmap

/// US-61: Dr Brad's products on the plan's supplement cards, for a known adult on a US App
/// Store storefront only. The engine's us-products.ts decides every block and word
/// (ios/engine/us-products.test.ts holds the Node side); Swift places what it returns.
@MainActor
final class USProductsTests: XCTestCase {
    private let now = try! Date("2026-10-21T08:00:00.000Z", strategy: Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    private var folder: URL!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "US Products \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    /// A record with sex and height, and the birth year given (nil: an unknown age).
    private func record(_ engine: HealthEngine, birthYear: Int?) throws -> String {
        let empty = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!) }
        let outcome = try engine.blocking { [now] in try $0.apply(.profile(sex: "female", birthYear: birthYear, birthMonth: birthYear == nil ? nil : 1, height: 165), to: empty, now: now, deviceId: "test") }
        return try XCTUnwrap(outcome.record, outcome.message ?? "")
    }

    private func sections(_ engine: HealthEngine, _ record: String, isUS: Bool) throws -> [PlanSection] {
        engine.blocking { $0.useStorefront(isUS: isUS) }
        return try engine.blocking { [now] in try $0.planView(record: record, units: "{}", now: now, deviceId: "test") }.sections
    }

    private func suggestions(_ sections: [PlanSection]) -> [Suggestion] { sections.flatMap(\.cards).flatMap(\.suggestions) }

    func testAUSAdultSeesABlockOnEachMappedSupplementCardAndOneOwnershipLine_US61() throws {
        let engine = try HealthEngine()
        let adult = try record(engine, birthYear: 1970)
        let shown = try sections(engine, adult, isUS: true)
        let supplements = try XCTUnwrap(shown.first { $0.key == "supplements" })
        let products = supplements.cards.flatMap(\.suggestions).map { ($0.id, $0.usProduct?.name) }
        XCTAssertEqual(products.first { $0.0 == "supplement-micronutrient-base" }?.1, "MicroVitamin+")
        XCTAssertEqual(products.first { $0.0 == "supplement-sleep" }?.1, "Sleep")
        XCTAssertEqual(products.first { $0.0 == "supplement-omega3" }.map { $0.1 }, .some(nil), "omega-3 gets no product (AC6)")
        // AC8: the product page with the fixed iPhone UTM tag, nothing from the record.
        for product in suggestions(shown).compactMap(\.usProduct) {
            XCTAssertEqual(URLComponents(url: product.url, resolvingAgainstBaseURL: false)?.query, "utm_source=health-tool&utm_medium=ios")
            XCTAssertEqual(product.url.host(), "microvitamin.com")
        }
        // AC7: once, on the Supplements section only; no block anywhere else.
        XCTAssertEqual(shown.compactMap(\.ownershipLine), ["Brad Stanfield founded and owns the company that sells MicroVitamin+ and Sleep."])
        XCTAssertNotNil(supplements.ownershipLine)
        XCTAssertTrue(shown.filter { $0.key != "supplements" }.flatMap(\.cards).flatMap(\.suggestions).allSatisfy { $0.usProduct == nil })
    }

    func testTheUSCardTextAndReferencesReplaceTheCardsOwn_US61() throws {
        let engine = try HealthEngine()
        let adult = try record(engine, birthYear: 1970)
        let base = try XCTUnwrap(suggestions(try sections(engine, adult, isUS: false)).first { $0.id == "supplement-micronutrient-base" })
        let us = try XCTUnwrap(suggestions(try sections(engine, adult, isUS: true)).first { $0.id == "supplement-micronutrient-base" })
        let block = try XCTUnwrap(us.usProduct)
        XCTAssertEqual(us.description, block.description)
        XCTAssertNotEqual(us.description, base.description, "the base card has its US text")
        XCTAssertFalse(us.description.contains("WHO"), "no dementia sentences beside a product (AC2)")
        XCTAssertEqual(us.references?.map(\.url), block.references?.map(\.url))
        XCTAssertLessThan(us.references?.count ?? 0, base.references?.count ?? 0, "the WHO reference goes with its sentence")
        // A card with no US variant keeps its own text and references.
        let collagen = try XCTUnwrap(suggestions(try sections(engine, adult, isUS: true)).first { $0.id == "supplement-collagen" })
        let ownCollagen = try XCTUnwrap(suggestions(try sections(engine, adult, isUS: false)).first { $0.id == "supplement-collagen" })
        XCTAssertNotNil(collagen.usProduct)
        XCTAssertEqual(collagen.description, ownCollagen.description)
        XCTAssertEqual(collagen.references?.map(\.url), ownCollagen.references?.map(\.url))
    }

    func testOutsideTheUSOrForAMinorOrAnUnknownAgeNothingShows_US61() throws {
        let engine = try HealthEngine()
        for (label, year, isUS) in [("non-US adult", 1970, false), ("US minor", 2012, true), ("US unknown age", nil, true)] as [(String, Int?, Bool)] {
            let shown = try sections(engine, try record(engine, birthYear: year), isUS: isUS)
            XCTAssertTrue(suggestions(shown).allSatisfy { $0.usProduct == nil }, label)
            XCTAssertTrue(shown.allSatisfy { $0.ownershipLine == nil }, label)
        }
    }

    /// The store draws the record again when the storefront changes, and not otherwise.
    func testAStorefrontChangeRedrawsThePlan_US61() async throws {
        let store = try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "test")
        await XCTAssertSaved(await store.apply(.profile(sex: "male", birthYear: 1970, birthMonth: 6, height: 178)))
        func shownProducts() -> Int {
            guard case .planned(_, let sections, _) = store.plan else { return -1 }
            return suggestions(sections).compactMap(\.usProduct).count
        }
        /// Whether `body` drew the record again (RecordStore.follow's guard skips a repeat).
        func redraws(_ body: () async -> Void) async -> Bool {
            let redrew = Flag()
            withObservationTracking { _ = store.drawn } onChange: { redrew.set() }
            await body()
            return redrew.value
        }
        XCTAssertEqual(shownProducts(), 0, "not the US until StoreKit says so")
        let toUS = await redraws { await store.follow(storefrontIsUS: true) }
        XCTAssertTrue(toUS)
        XCTAssertGreaterThan(shownProducts(), 0)
        let repeatUS = await redraws { await store.follow(storefrontIsUS: true) }
        XCTAssertFalse(repeatUS, "the same answer again draws nothing")
        await store.follow(storefrontIsUS: false)
        XCTAssertEqual(shownProducts(), 0)
        let repeatNotUS = await redraws { await store.follow(storefrontIsUS: false) }
        XCTAssertFalse(repeatNotUS, "the same answer again draws nothing")
    }

    /// No storefront now (StoreKit cannot say) keeps the saved answer and writes nothing;
    /// with nothing saved, it is not the US.
    func testANilStorefrontKeepsTheSavedAnswer_US61() throws {
        let suite = "USProductsTests-\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        XCTAssertFalse(AppStoreCountry.remember(nil, in: defaults), "nothing saved: not the US")
        XCTAssertNil(defaults.object(forKey: AppStoreCountry.key), "a nil storefront writes nothing")
        XCTAssertTrue(AppStoreCountry.remember("USA", in: defaults))
        XCTAssertTrue(AppStoreCountry.remember(nil, in: defaults), "a nil storefront keeps the saved US")
        XCTAssertEqual(defaults.object(forKey: AppStoreCountry.key) as? Bool, true)
        XCTAssertFalse(AppStoreCountry.remember("NZL", in: defaults))
        XCTAssertEqual(defaults.object(forKey: AppStoreCountry.key) as? Bool, false)
    }

    /// D14, a new app with an old engine (builds 3 and 4 carry bridge 2d467ff50c66c42d, and
    /// their engines reach this app too): an engine built before US-61 ignores the fifth
    /// argument and sends no usProducts, and the app then draws the plan with no block.
    func testAnEngineBeforeUS61DrawsThePlanWithNoBlock_US61() throws {
        let url = try XCTUnwrap(Bundle.main.url(forResource: "health-engine", withExtension: "js"))
        let older = """
            HealthEngine = (function (e) {
              var o = Object.assign({}, e);
              o.screenJson = function (a, b, c, d) {
                var v = JSON.parse(e.screenJson(a, b, c, d));
                if (v.plan) delete v.plan.usProducts;
                return JSON.stringify(v);
              };
              return o;
            })(HealthEngine);
            """
        let engine = try HealthEngine(source: try String(contentsOf: url, encoding: .utf8) + "\n" + older, sourceURL: nil, session: StubHTTP.session())
        XCTAssertEqual(try engine.blocking { try $0.evaluate("HealthEngine.screenJson.length").toInt32() }, 4, "the stand-in takes the old four arguments")
        let shown = try sections(engine, try record(engine, birthYear: 1970), isUS: true)
        XCTAssertNotNil(shown.first { $0.key == "supplements" })
        XCTAssertTrue(suggestions(shown).allSatisfy { $0.usProduct == nil })
        XCTAssertTrue(shown.allSatisfy { $0.ownershipLine == nil })
    }

    /// A signed engine cannot point a block anywhere but https on microvitamin.com.
    func testABlockLinkingAnywhereButMicrovitaminIsDropped_US61() throws {
        func kept(_ url: String) throws -> Int {
            let block = ["suggestionId": "supplement-sleep", "product": "sleep", "name": "Sleep", "line": "A line.", "url": url]
            let json = try JSONSerialization.data(withJSONObject: ["blocks": [block], "ownershipLine": "Owner line."])
            return try JSONDecoder().decode(USProducts.self, from: json).blocks.count
        }
        XCTAssertEqual(try kept("https://microvitamin.com/products/sleep?utm_source=health-tool&utm_medium=ios"), 1)
        for url in ["http://microvitamin.com/products/sleep", "https://example.com/products/sleep", "https://microvitamin.com.example.com/x",
                    "https://www.microvitamin.com/products/sleep", "https://microvitamin.com@example.com/x", "mailto:a@microvitamin.com"] {
            XCTAssertEqual(try kept(url), 0, url)
        }
    }

    /// Swift places only what the engine gives: no block, no line; a line with no card
    /// holding a block is not shown.
    func testTheOverlayPlacesOnlyWhatTheEngineGave_US61() throws {
        let json = #"[{"key":"supplements","title":"Supplements","cards":[{"category":"supplements","priority":"info","suggestions":[{"id":"supplement-omega3","category":"supplements","priority":"info","title":"Omega-3","description":"Own text."}]}]}]"#
        let sections = try JSONDecoder().decode([PlanSection].self, from: Data(json.utf8))
        let none = USProducts(blocks: [], ownershipLine: nil).applied(to: sections)
        XCTAssertNil(none[0].ownershipLine)
        let elsewhere = USProducts(blocks: [.init(suggestionId: "supplement-sleep", name: "Sleep", line: "A line.", url: URL(string: "https://microvitamin.com/products/sleep")!, description: nil, references: nil)],
                                   ownershipLine: "Owner line.").applied(to: sections)
        XCTAssertNil(elsewhere[0].cards[0].suggestions[0].usProduct)
        XCTAssertNil(elsewhere[0].ownershipLine, "no card here shows a block, so no ownership line")
        XCTAssertEqual(elsewhere[0].cards[0].suggestions[0].description, "Own text.")
        let here = USProducts(blocks: [.init(suggestionId: "supplement-omega3", name: "Sleep", line: "A line.", url: URL(string: "https://microvitamin.com/products/sleep")!, description: nil, references: nil)],
                              ownershipLine: "Owner line.").applied(to: sections)
        XCTAssertEqual(here[0].cards[0].suggestions[0].usProduct?.name, "Sleep", "a block the engine gave for this card shows on it")
        XCTAssertEqual(here[0].ownershipLine, "Owner line.")
        XCTAssertEqual(here[0].cards[0].suggestions[0].description, "Own text.", "a block with no US text keeps the card's own")
    }

    /// A block shows on its single Supplements card, with its text and the line, and nowhere
    /// else: not on a grouped card, not in another section (the web's renderCards rule).
    func testABlockShowsOnlyOnItsSingleSupplementsCard_US61() throws {
        func card(_ ids: [String]) -> [String: Any] {
            ["category": "supplements", "priority": "info",
             "suggestions": ids.map { ["id": $0, "category": "supplements", "priority": "info", "title": "T", "description": "Own text."] }]
        }
        let json = try JSONSerialization.data(withJSONObject: [
            ["key": "supplements", "title": "Supplements", "cards": [card(["supplement-sleep"]), card(["supplement-collagen", "supplement-creatine"])]],
            ["key": "info", "title": "Foundation", "cards": [card(["supplement-micronutrient-base"])]],
        ])
        let sections = try JSONDecoder().decode([PlanSection].self, from: json)
        let blocks = ["supplement-sleep", "supplement-collagen", "supplement-micronutrient-base"].map {
            USProducts.Block(suggestionId: $0, name: "Sleep", line: "A line.", url: URL(string: "https://microvitamin.com/products/sleep")!, description: "US text.", references: [])
        }
        let shown = USProducts(blocks: blocks, ownershipLine: "Owner line.").applied(to: sections)
        let single = shown[0].cards[0].suggestions[0]
        XCTAssertEqual(single.usProduct?.name, "Sleep", "the positive case: a block on its card shows")
        XCTAssertEqual(single.description, "US text.")
        XCTAssertEqual(shown[0].ownershipLine, "Owner line.")
        XCTAssertTrue(shown[0].cards[1].suggestions.allSatisfy { $0.usProduct == nil && $0.description == "Own text." }, "a grouped card takes no block")
        XCTAssertNil(shown[1].cards[0].suggestions[0].usProduct, "only the Supplements section")
        XCTAssertEqual(shown[1].cards[0].suggestions[0].description, "Own text.")
        XCTAssertNil(shown[1].ownershipLine)
    }
}

/// Set once from an observation's onChange, read after on the main actor.
private final class Flag: @unchecked Sendable {
    private(set) var value = false
    func set() { value = true }
}
