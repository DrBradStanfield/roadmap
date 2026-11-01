import Foundation

/// One suggestion, as the engine writes it (`Suggestion` in packages/health-core/src/types.ts).
/// The evidence fields are kept whole: a clinical suggestion is never shown without them.
struct Suggestion: Decodable, Identifiable {
    struct Reference: Decodable {
        let label: String
        let url: URL
    }

    let id: String
    /// nutrition, exercise, bloodwork, blood_pressure, general, sleep, medication, screening, supplements, skin
    let category: String
    /// urgent, attention or info
    let priority: String
    let title: String
    let description: String
    /// A product page the title links to on the web, such as a sunscreen.
    let link: URL?
    /// Why the engine made this suggestion ("Why this suggestion?" on the web).
    let reason: String?
    /// Guideline tags, such as "ESC/EAS 2025".
    let guidelines: [String]?
    let references: [Reference]?
    /// A product's ingredient list, shown as bullets.
    let ingredients: [String]?
    /// Dr Brad's product for this card, for a US adult (US-61): only in the engine's `usProducts`.
    let usProduct: USProduct?

    /// The one suggestion with a Dismiss button, which asks "Do you drink alcohol?" (US-60).
    static let reduceAlcohol = "reduce-alcohol"
}

/// The Plan tab for one record, as the engine's `screenJson` gave it with My data (US-25 AC2).
enum PlanState: Sendable {
    /// The plan, and how long the engine took to plan it (D2's plan budget).
    case planned(tiles: [StatTile], sections: [PlanSection], ms: Double)
    /// health-core's one PlanError: no usable height (plan.ts). No sex is a plan without
    /// the parts that need it (US-07 AC8). The engine worked.
    case needsDetails
    /// The engine threw on this record, in its own words.
    case failed(String)

    /// Whether the engine planned the record: a plan, or health-core's own PlanError.
    /// Any other throw is not: the failure an engine on trial exists to catch (US-25 AC18).
    var planned: Bool {
        if case .failed = self { return false }
        return true
    }
}

/// One section of the plan screen, as health-core's `planSections` lays it out
/// (packages/health-core/src/plan-sections.ts); the web's results panel uses the same.
struct PlanSection: Decodable, Identifiable {
    let key: String
    let title: String
    let cards: [PlanCard]
    /// Who owns the products, under the section's last card when any of its cards shows one (US-61 AC7).
    let ownershipLine: String?

    var id: String { key }
    /// health-core's Foundation section (planSections' `info`), where tour tip 2 anchors.
    var isFoundation: Bool { key == "info" }
}

/// One card: a single suggestion, or two or more of one category grouped together.
struct PlanCard: Decodable, Identifiable {
    let category: String
    /// The card's badge: the highest priority among its suggestions.
    let priority: String
    let suggestions: [Suggestion]

    var id: String { suggestions.map(\.id).joined(separator: "+") }
}

/// Dr Brad's product on one supplement card (US-61). The engine's `screenJson` gives the
/// sections ready to draw in `plan.usProducts` from health-core's us-products.ts: blocks only
/// for a known adult on a US App Store storefront, so every word, link and card choice
/// updates with the engine. The app only draws them.
struct USProduct: Decodable, Sendable {
    let name: String
    let line: String
    /// The product page with the fixed UTM tag; nothing from the record.
    let url: URL

    private enum CodingKeys: CodingKey { case name, line, url }

    /// Refuses a link that is not https on microvitamin.com, so a signed engine cannot point
    /// one anywhere else (US-61): the whole `usProducts` then fails to decode and the plan
    /// shows with no block.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        line = try c.decode(String.self, forKey: .line)
        url = try c.decode(URL.self, forKey: .url)
        guard url.scheme?.lowercased() == "https", url.host()?.lowercased() == "microvitamin.com" else {
            throw DecodingError.dataCorruptedError(forKey: .url, in: c, debugDescription: "a product link must be https on microvitamin.com")
        }
    }
}

/// One summary tile above the plan, as the engine writes it (ios/engine/entry.ts `screenJson`): the web's
/// Quick Stats. Every word and number is the engine's; the app only draws it (US-25 AC22).
struct StatTile: Decodable, Identifiable {
    struct Status: Decodable {
        let label: String
        /// normal, info, attention or urgent: the web's status colour. Absent: no colour.
        let tone: String?
    }

    /// Evidence behind a tap, as on the web.
    struct Evidence: Decodable {
        let reason: String
        let guidelines: [String]
        let references: [Suggestion.Reference]
    }

    /// whtr, bmi, ibw, protein, apoB, nonHdl, ldl, egfr, lpa or hba1c.
    let key: String
    let label: String
    let value: String
    /// Empty for a value with no unit (BMI, waist-to-height).
    let unit: String
    let status: Status?
    let evidence: Evidence?
    /// What the tile is, in plain words (US-57 AC5); a known minor's tile has it too, so
    /// every tile opens.
    let about: String

    var id: String { key }
}
