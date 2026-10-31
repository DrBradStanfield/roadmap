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
        XCTAssertEqual(shownProducts(), 0, "not the US until StoreKit says so")
        await store.follow(storefrontIsUS: true)
        XCTAssertGreaterThan(shownProducts(), 0)
        await store.follow(storefrontIsUS: false)
        XCTAssertEqual(shownProducts(), 0)
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
    }
}
