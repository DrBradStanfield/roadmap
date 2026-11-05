import SwiftUI

/// My health's sections (US-73 AC2), in Brad's order: weight first, since "so much flows
/// through" it; the full blood-test list near the end; then Other, for a topic the app does
/// not know. The engine's topic ids are these raw values.
enum HealthTopic: String, CaseIterable, Identifiable {
    case weight, sleep, fitness, bloodPressure, cholesterol, screening, skin, bloodTests, supplements, other

    var id: String { rawValue }

    /// The scroll id of the topic's heading, for the jump pills.
    var anchor: String { "topic.\(rawValue)" }

    /// The jump pills (Brad, round 6): only these three.
    static let pills: [HealthTopic] = [.bloodTests, .cholesterol, .supplements]

    @MainActor var title: SectionTitle {
        switch self {
        case .weight: SectionTitle(title: "Weight & diabetes", symbol: "scalemass.fill", tint: .purple)
        case .sleep: SectionTitle(title: "Sleep", symbol: "bed.double.fill", tint: .cyan)
        case .fitness: .fitness()
        case .bloodPressure: SectionTitle(title: "Blood pressure", symbol: "heart.fill", tint: .red)
        // The plan's bloodwork icon (CategoryIcon), in the lipid cards' red.
        case .cholesterol: SectionTitle(title: "Cholesterol", symbol: "drop.fill", tint: .red)
        case .screening: .screening("Cancer screening")
        case .skin: SectionTitle(title: "Skin", symbol: "sun.max.fill", tint: .orange)
        case .bloodTests: .bloodTests()
        case .supplements: .supplements()
        case .other: SectionTitle(title: "Other", symbol: "ellipsis.circle.fill", tint: .gray)
        }
    }
}

/// The engine's topic layout (`TopicLayout`) as My health reads it: cards by topic, and the
/// suggestions that sit on a medicine question or a screening group. Swift places nothing:
/// a topic it does not know goes under Other, and with no layout every card goes there, so
/// no suggestion is ever left out (US-73 AC3).
struct TopicPlan {
    private(set) var cards: [HealthTopic: [PlanCard]] = [:]
    /// Who owns the products (US-61 AC7), under the supplement cards.
    private(set) var ownershipLine: String?
    /// Medicine suggestions by the question key they sit on.
    private(set) var medicines: [String: [Suggestion]] = [:]
    /// Screening suggestions by the group id they sit in.
    private(set) var screenings: [String: [Suggestion]] = [:]

    init(_ layout: TopicLayout?, plan: PlanState?) {
        guard case .planned(_, let sections, _) = plan else { return }
        guard let layout else {
            cards[.other] = sections.flatMap(\.cards)
            ownershipLine = sections.compactMap(\.ownershipLine).first
            return
        }
        for section in layout.sections {
            cards[HealthTopic(rawValue: section.topic) ?? .other, default: []] += section.cards
            if let line = section.ownershipLine { ownershipLine = line }
        }
        for placed in layout.medicines { if let key = placed.key { medicines[key, default: []] += placed.suggestions } }
        for placed in layout.screenings { if let group = placed.group { screenings[group, default: []] += placed.suggestions } }
    }

    subscript(topic: HealthTopic) -> [PlanCard] { cards[topic] ?? [] }

    /// The first urgent card in topic order: the banner's title and scroll target. An urgent
    /// suggestion is always a card, whatever row it also sits on.
    var urgent: (title: String, anchor: String)? {
        for topic in HealthTopic.allCases {
            if let card = self[topic].first(where: { $0.priority == "urgent" }),
               let first = card.suggestions.first(where: { $0.priority == "urgent" }) ?? card.suggestions.first {
                return (first.title, card.anchor)
            }
        }
        return nil
    }
}

extension PlanCard {
    /// The card's scroll id on My health, and its List identity: a `.id` on a ForEach row is not
    /// what List scrolls by, so the banner's scroll found nothing (seen 2026-11-05).
    var anchor: String { "card.\(id)" }

    /// The reduce-alcohol card's question (US-60) goes only to the card holding it; the rest get nil.
    func asking(_ question: AlcoholQuestion?) -> AlcoholQuestion? {
        suggestions.contains { $0.id == Suggestion.reduceAlcohol } ? question : nil
    }
}

/// The plan's summary tiles by key (whtr, bmi, ibw, protein, egfr…), for the rows and
/// metric pages that now carry them.
struct PlanTiles {
    private var byKey: [String: StatTile] = [:]

    init(_ state: PlanState?) {
        guard case .planned(let tiles, _, _) = state else { return }
        byKey = Dictionary(tiles.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
    }

    subscript(key: String) -> StatTile? { byKey[key] }

    /// A tile's status tone as a row's grade: amber for attention, red for urgent.
    static func grade(_ tile: StatTile?) -> MyData.Grade? {
        switch tile?.status?.tone {
        case "urgent": .bad
        case "attention": .warn
        default: nil
        }
    }

    /// Each tile's explainer on its row's page (US-73 AC9): by the page's row id. Protein
    /// follows weight, as its target does; non-HDL is total cholesterol less HDL.
    static let pages: [String: [String]] = [
        "weight": ["bmi", "ibw", "protein"], "waist": ["whtr"], "hba1c": ["hba1c"],
        "creatinine": ["egfr"], "lab:egfr": ["egfr"], "apob": ["apoB"], "ldl": ["ldl"],
        "total_cholesterol": ["nonHdl"], "lpa": ["lpa"],
    ]
}

/// A worked-out series' row (the engine's `historyJson` series `whtr` and `egfr`, US-73 AC7):
/// the newest day's value, the day before's in brackets, and the recent values for the trend.
struct DerivedRow {
    let history: MetricHistory

    init?(_ history: MetricHistory?) {
        guard let history, !history.rows.isEmpty else { return nil }
        self.history = history
    }

    var latest: MetricHistory.Row { history.rows[0] }
    var previous: String? { history.rows.dropFirst().first?.value }
    /// The newest seven values, oldest first.
    var trend: [Double] { history.rows.prefix(7).compactMap(\.number).reversed() }

    /// "Lab result" or "Calculated", for eGFR (US-07 AC7, AC8).
    var source: String? {
        switch latest.source {
        case "lab": "Lab result"
        case "calculated": "Calculated"
        default: nil
        }
    }
}
