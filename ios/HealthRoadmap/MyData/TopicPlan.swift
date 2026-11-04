import SwiftUI

/// PROTOTYPE (My health tab, docs/drafts/my-health-tab.md): the My health tab's topics, in
/// Brad's order (round 4): weight first, since "so much flows through" it; the full blood-test
/// list near the end.
enum HealthTopic: String, CaseIterable, Identifiable {
    case weight, sleep, fitness, bloodPressure, cholesterol, screening, skin, bloodTests, supplements

    var id: String { rawValue }

    var title: SectionTitle {
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
        }
    }
}

/// PROTOTYPE: the plan's cards split by topic. Swift only: health-core's cards, words and
/// priorities are unchanged. A card whose suggestions fall in two topics becomes one card in
/// each, badged with its own suggestions' highest priority. Within a topic the cards go by
/// priority (urgent, attention, info), results before lifestyle advice within each (Brad, rounds 4-5).
/// Medicine suggestions are no cards: they sit behind their question's info button.
struct TopicPlan {
    private(set) var cards: [HealthTopic: [PlanCard]] = [:]
    /// Who owns the products (US-61 AC7), under the supplement cards.
    private(set) var ownershipLine: String?
    /// Every medicine suggestion (`weight-glp1`, `weight-med-*`, `med-*`), shown inside its
    /// medicine question instead of as a card (Brad, round 4).
    private(set) var medicines: [Suggestion] = []

    init(_ state: PlanState?) {
        guard case .planned(_, let sections, _) = state else { return }
        for card in sections.flatMap(\.cards) {
            medicines += card.suggestions.filter(Self.isMedicine)
            let byTopic = Dictionary(grouping: card.suggestions.filter { !Self.isMedicine($0) }, by: Self.topic)
            for topic in HealthTopic.allCases {
                guard let suggestions = byTopic[topic] else { continue }
                cards[topic, default: []].append(PlanCard(category: card.category, priority: Self.highest(suggestions), suggestions: suggestions))
            }
        }
        for topic in cards.keys { cards[topic] = Self.byPriority(cards[topic] ?? []) }
        cards[.weight] = Self.fibreUnderProtein(cards[.weight] ?? [])
        ownershipLine = sections.compactMap(\.ownershipLine).first
    }

    subscript(topic: HealthTopic) -> [PlanCard] { cards[topic] ?? [] }

    /// The first urgent card, in topic order, with its topic: the banner's.
    var urgent: PlanCard? {
        HealthTopic.allCases.lazy.compactMap { self[$0].first { $0.priority == "urgent" } }.first
    }

    static func isMedicine(_ suggestion: Suggestion) -> Bool { suggestion.category == "medication" }

    /// The scroll id of a card on the tab.
    static func anchor(_ card: PlanCard) -> String { card.anchor }

    /// By category first; nutrition and bloodwork by suggestion (orchestrator, rounds 1 to 4).
    static func topic(_ suggestion: Suggestion) -> HealthTopic {
        switch suggestion.category {
        case "nutrition":
            switch suggestion.id {
            case "low-salt", "high-potassium": .bloodPressure
            case "lipid-diet", "trig-nutrition": .cholesterol
            default: .weight
            }
        case "exercise": .fitness
        case "sleep": .sleep
        case "blood_pressure": .bloodPressure
        case "bloodwork":
            if suggestion.id.hasPrefix("hba1c-") { .weight }
            else if lipidPrefixes.contains(where: suggestion.id.hasPrefix) { .cholesterol }
            else { .bloodTests }
        case "screening": .screening
        case "skin": .skin
        case "supplements": .supplements
        default: .weight // general, and any category a newer engine adds
        }
    }

    /// The lipid cards' ids (suggestions.ts): ApoB, LDL, non-HDL, Lp(a), total cholesterol, HDL, triglycerides.
    private static let lipidPrefixes = ["apob-", "ldl-", "non-hdl-", "lpa-", "total-chol-", "hdl-", "trig-"]

    /// The medicine question a suggestion belongs beside, best first: its step's own question
    /// (`med-statin-dose` to `statin_dose`), its escalation question, then the drug's own.
    static func questionKeys(for suggestion: Suggestion) -> [String] {
        var step = suggestion.id
        for prefix in ["weight-med-", "weight-", "med-"] where step.hasPrefix(prefix) {
            step = String(step.dropFirst(prefix.count))
            break
        }
        let key = step.replacingOccurrences(of: "-", with: "_")
        let drug = String(key.split(separator: "_").first ?? "")
        return [key, "\(drug)_escalation", drug]
    }

    private static let priorities = ["urgent", "attention", "info"]

    private static func rank(_ priority: String) -> Int { priorities.firstIndex(of: priority) ?? priorities.count }

    private static func highest(_ suggestions: [Suggestion]) -> String {
        suggestions.map(\.priority).min { rank($0) < rank($1) } ?? "info"
    }

    /// Urgent, then attention, then info. Within a level, a card about a result (a blood test or
    /// blood pressure) comes before lifestyle advice, so "HbA1c indicates prediabetes" leads
    /// "Reduce alcohol" (Brad, round 5). A stable sort, so the engine's order holds otherwise.
    private static func byPriority(_ cards: [PlanCard]) -> [PlanCard] {
        func key(_ card: PlanCard, _ offset: Int) -> (Int, Int, Int) { (rank(card.priority), isResult(card) ? 0 : 1, offset) }
        return cards.enumerated().sorted { key($0.element, $0.offset) < key($1.element, $1.offset) }.map(\.element)
    }

    private static func isResult(_ card: PlanCard) -> Bool {
        card.suggestions.contains { ["bloodwork", "blood_pressure"].contains($0.category) }
    }

    /// The fibre card directly under the daily protein target (Brad, round 4).
    private static func fibreUnderProtein(_ cards: [PlanCard]) -> [PlanCard] {
        let isFibre = { (card: PlanCard) in card.suggestions.map(\.id) == ["fiber"] }
        guard let fibre = cards.first(where: isFibre) else { return cards }
        var rest = cards.filter { !isFibre($0) }
        guard let protein = rest.firstIndex(where: { $0.suggestions.contains { $0.id == "protein-target" } }) else { return cards }
        rest.insert(fibre, at: protein + 1)
        return rest
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
