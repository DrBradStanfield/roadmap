import SwiftUI

/// PROTOTYPE (My health tab, docs/drafts/my-health-tab.md): the My health tab's topics, in
/// Brad's order (2026-11-03): weight first, since "so much flows through" it.
enum HealthTopic: String, CaseIterable, Identifiable {
    case weight, sleep, fitness, bloodPressure, bloodTests, screening, skin, supplements

    var id: String { rawValue }

    var title: SectionTitle {
        switch self {
        case .weight: SectionTitle(title: "Weight & diabetes", symbol: "scalemass.fill", tint: .purple)
        case .sleep: SectionTitle(title: "Sleep", symbol: "bed.double.fill", tint: .cyan)
        case .fitness: .fitness()
        case .bloodPressure: SectionTitle(title: "Blood pressure", symbol: "heart.fill", tint: .red)
        case .bloodTests: .bloodTests()
        case .screening: .screening("Cancer screening")
        case .skin: SectionTitle(title: "Skin", symbol: "sun.max.fill", tint: .orange)
        case .supplements: .supplements()
        }
    }
}

/// PROTOTYPE: the plan's cards split by topic. Swift only: health-core's cards, words and
/// priorities are unchanged. A card whose suggestions fall in two topics becomes one card in
/// each, badged with its own suggestions' highest priority. Within a topic the cards keep
/// the plan's own order (urgent, attention, info, then skin and supplements).
struct TopicPlan {
    private(set) var cards: [HealthTopic: [PlanCard]] = [:]
    /// Who owns the products (US-61 AC7), under the supplement cards.
    private(set) var ownershipLine: String?
    /// The weight-medicine step suggestions (`weight-med-*`): drawn in the Weight & Diabetes
    /// Medications section in place of its intro, never as cards (Brad, round 3).
    private(set) var weightMedicines: [Suggestion] = []

    init(_ state: PlanState?) {
        guard case .planned(_, let sections, _) = state else { return }
        for card in sections.flatMap(\.cards) {
            weightMedicines += card.suggestions.filter(Self.isWeightMedicine)
            let byTopic = Dictionary(grouping: card.suggestions.filter { !Self.isWeightMedicine($0) }, by: Self.topic)
            for topic in HealthTopic.allCases {
                guard let suggestions = byTopic[topic] else { continue }
                cards[topic, default: []].append(PlanCard(category: card.category, priority: Self.highest(suggestions), suggestions: suggestions))
            }
        }
        ownershipLine = sections.compactMap(\.ownershipLine).first
    }

    subscript(topic: HealthTopic) -> [PlanCard] { cards[topic] ?? [] }

    /// The first urgent card, in topic order, with its topic: the banner's.
    var urgent: PlanCard? {
        HealthTopic.allCases.lazy.compactMap { self[$0].first { $0.priority == "urgent" } }.first
    }

    static func isWeightMedicine(_ suggestion: Suggestion) -> Bool { suggestion.id.hasPrefix("weight-med-") }

    /// The scroll id of a card on the tab.
    static func anchor(_ card: PlanCard) -> String { card.anchor }

    /// By category first; medication and nutrition by suggestion (orchestrator, 2026-11-05).
    static func topic(_ suggestion: Suggestion) -> HealthTopic {
        switch suggestion.category {
        case "medication": suggestion.id.hasPrefix("weight-") ? .weight : .bloodTests
        case "nutrition":
            switch suggestion.id {
            case "low-salt", "high-potassium": .bloodPressure
            case "lipid-diet", "trig-nutrition": .bloodTests
            default: .weight
            }
        case "exercise": .fitness
        case "sleep": .sleep
        case "blood_pressure": .bloodPressure
        case "bloodwork": suggestion.id.hasPrefix("hba1c-") ? .weight : .bloodTests
        case "screening": .screening
        case "skin": .skin
        case "supplements": .supplements
        default: .weight // general, and any category a newer engine adds
        }
    }

    private static func highest(_ suggestions: [Suggestion]) -> String {
        let order = ["urgent", "attention", "info"]
        return suggestions.map(\.priority).min { (order.firstIndex(of: $0) ?? 3) < (order.firstIndex(of: $1) ?? 3) } ?? "info"
    }
}

extension PlanCard {
    /// The card's scroll id on My health, and its List identity: a `.id` on a ForEach row is not
    /// what List scrolls by, so the banner's scroll found nothing (seen 2026-11-05).
    var anchor: String { "card.\(id)" }
}

/// PROTOTYPE: the plan's summary tiles by key (whtr, bmi, ibw, protein, egfr…), for the rows
/// and lines that now carry them.
struct PlanTiles {
    private var byKey: [String: StatTile] = [:]

    init(_ state: PlanState?) {
        guard case .planned(let tiles, _, _) = state else { return }
        byKey = Dictionary(tiles.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
    }

    subscript(key: String) -> StatTile? { byKey[key] }

    /// A tile's status tone as a row's grade: amber for attention, red for urgent.
    static func grade(_ tile: StatTile) -> MyData.Grade? {
        switch tile.status?.tone {
        case "urgent": .bad
        case "attention": .warn
        default: nil
        }
    }
}

/// PROTOTYPE: the waist-to-height row's history, from the waist row and the height, as the
/// tile works it out (health-core `waistToHeightRatio`: waist over height, to 2 places). Both are
/// in the record's units, so the ratio is the same in metric and US. The latest value is the tile's own.
struct WaistToHeight {
    let tile: StatTile
    let previous: String?
    let trend: [Double]

    init(tile: StatTile, waist: MyData.Row, height: String?) {
        self.tile = tile
        let height = height.flatMap { Double($0.replacingOccurrences(of: ",", with: "")) } ?? 0
        func ratio(_ waist: Double) -> Double { (waist / height * 100).rounded() / 100 }
        guard height > 0 else { previous = nil; trend = []; return }
        previous = waist.previous.flatMap { Double($0.replacingOccurrences(of: ",", with: "")) }
            .map { ratio($0).formatted(.number.precision(.fractionLength(2))) }
        trend = (waist.trend ?? []).map(ratio)
    }
}
