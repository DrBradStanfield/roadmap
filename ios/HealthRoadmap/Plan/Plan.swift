import Foundation

/// The part of the engine's plan the app reads. The engine owns the full shape
/// (`Plan` in packages/health-core/src/plan.ts); fields not listed here are ignored.
struct Plan: Decodable {
    struct Results: Decodable {
        let suggestions: [Suggestion]
    }

    /// The plan's calendar day, YYYY-MM-DD, in the phone's time zone.
    let today: String
    let results: Results
}

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
}

/// One section of the plan screen, as health-core's `planSections` lays it out
/// (packages/health-core/src/plan-sections.ts); the web's results panel uses the same.
struct PlanSection: Decodable, Identifiable {
    let key: String
    let title: String
    let cards: [PlanCard]

    var id: String { key }
}

/// One card: a single suggestion, or two or more of one category grouped together.
struct PlanCard: Decodable, Identifiable {
    let category: String
    /// The card's badge: the highest priority among its suggestions.
    let priority: String
    let suggestions: [Suggestion]

    var id: String { suggestions.map(\.id).joined(separator: "+") }
}
