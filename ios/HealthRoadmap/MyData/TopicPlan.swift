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

    /// The Apple Health cards in this topic (US-56 AC6): sleep under Sleep; VO2 max, resting
    /// heart rate and steps under Fitness (no heart rate card, Brad round 4).
    var liveMetrics: [LiveMetric] {
        switch self {
        case .sleep: [.sleep]
        case .fitness: [.vo2Max, .restingHeartRate, .steps]
        default: []
        }
    }

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

/// My health as drawn (US-73), built once per record change from the engine's screen and its
/// worked-out series: each topic's cards, the suggestions on rows, the banner, the tour's
/// anchor and every row with its value column. MyDataView only maps it to views, so what this
/// holds is what the tab draws. Swift places nothing: a topic the app does not know goes under
/// Other, and with no layout every card goes there, so no suggestion is left out (US-73 AC3).
struct HealthPage {
    /// A topic's cards: the urgent ones over its rows (Brad 2026-11-05), the rest after them.
    struct Topic {
        var urgent: [PlanCard] = []
        var cards: [PlanCard] = []
        var isEmpty: Bool { urgent.isEmpty && cards.isEmpty }
    }

    /// The eGFR row (US-73 AC7): the plan's current eGFR, a lab limit included; the series gives
    /// only the previous value and the trend.
    struct Egfr {
        let label: String
        let value: String
        let unit: String
        let day: String
        /// The tile's status, then "Lab result" or "Calculated".
        let target: String
        let previous: String?
        let grade: MyData.Grade?
        let trend: [Double]
        /// The page its tap opens: the lab eGFR's, or creatinine's.
        let page: MyData.Row
    }

    /// One reading that sets a section's value column.
    typealias Reading = (value: String?, previous: String?, unit: String, feetInches: MyData.FeetInches?)

    private(set) var topics: [HealthTopic: Topic] = [:]
    /// Who owns the products (US-61 AC7), under the supplement cards.
    private(set) var ownershipLine: String?
    /// Medicine suggestions by the question key they sit on, for the questions drawn.
    private(set) var medicines: [String: [Suggestion]] = [:]
    /// Screening suggestions by the group id they sit in, for the groups drawn.
    private(set) var screenings: [String: [Suggestion]] = [:]
    /// The first urgent card in topic order: the banner's title and scroll target.
    private(set) var urgent: (title: String, anchor: String)?
    let tiles: PlanTiles

    // Weight & diabetes: waist-to-height (or waist), weight with its BMI, HbA1c.
    private(set) var whtr: DerivedRow?
    private(set) var waist: MyData.Row?
    private(set) var weight: MyData.Row?
    private(set) var hba1c: MyData.Row?
    /// Weight's target: its BMI tile, else its own.
    private(set) var weightTarget: String?
    private(set) var weightColumn = ValueRow.Column([])
    // Blood pressure: today's card, creatinine, eGFR.
    private(set) var pressure: MyData.Row?
    private(set) var creatinine: MyData.Row?
    private(set) var egfr: Egfr?
    private(set) var pressureColumn = ValueRow.Column([])
    // Cholesterol.
    private(set) var lipids: [MyData.Row] = []
    /// Non-HDL when the plan works it out, after HDL; it opens total cholesterol's page, which explains it.
    private(set) var nonHdl: (tile: StatTile, total: MyData.Row)?
    private(set) var lipidColumn = ValueRow.Column([])
    // Blood tests.
    private(set) var bloodTests: [MyData.Row] = []
    /// The lab tests, less the lab eGFR when the eGFR row stands for it.
    private(set) var labs: [MyData.Row] = []
    private(set) var bloodColumn = ValueRow.Column([])
    /// The two medicine sections, as the engine gives them.
    private(set) var weightMedications: [FormSection] = []
    private(set) var lipidMedications: [FormSection] = []
    /// Cancer screening shows: a note, a question or a card.
    private(set) var showsScreening = false

    subscript(topic: HealthTopic) -> Topic { topics[topic] ?? Topic() }

    /// Tour tip 2's card (US-57 AC6): the first in Weight & diabetes.
    var firstWeightCard: String? { (self[.weight].urgent + self[.weight].cards).first?.anchor }

    /// The worked-out series the page reads (`RecordStore.chart`).
    static let series = ["whtr", "egfr"]

    @MainActor init(_ store: RecordStore) {
        self.init(data: store.myData, plan: store.plan, layout: store.topics,
                  whtr: store.shownChart(for: "whtr", series: "whtr")?.history, egfr: store.shownChart(for: "egfr", series: "egfr")?.history)
    }

    init(data: MyData?, plan: PlanState?, layout: TopicLayout?, whtr whtrHistory: MetricHistory?, egfr egfrHistory: MetricHistory?) {
        tiles = PlanTiles(plan)
        if case .planned(_, let sections, _) = plan {
            var cards: [HealthTopic: [PlanCard]] = [:]
            if let layout {
                for section in layout.sections {
                    cards[HealthTopic(rawValue: section.topic) ?? .other, default: []] += section.cards
                    if let line = section.ownershipLine { ownershipLine = line }
                }
            } else {
                cards[.other] = sections.flatMap(\.cards)
                ownershipLine = sections.compactMap(\.ownershipLine).first
            }
            for (topic, all) in cards {
                topics[topic] = Topic(urgent: all.filter { $0.priority == "urgent" }, cards: all.filter { $0.priority != "urgent" })
            }
            for topic in HealthTopic.allCases {
                if let card = self[topic].urgent.first, let first = card.suggestions.first(where: { $0.priority == "urgent" }) ?? card.suggestions.first {
                    urgent = (first.title, card.anchor)
                    break
                }
            }
            if let data, let layout {
                // Only where a row draws them: a question the two medicine sections ask, a screening group with a question.
                let asked = Set(data.medications.filter { ["weight-medications", "lipid-medications"].contains($0.id) }.flatMap(\.groups).flatMap(\.fields).map(\.key))
                let groups = data.screeningNote == nil ? Set(data.screenings.flatMap(\.groups).filter { !$0.fields.isEmpty }.map(\.id)) : []
                for placed in layout.medicines { if let key = placed.key, asked.contains(key) { medicines[key, default: []] += placed.suggestions } }
                for placed in layout.screenings { if let group = placed.group, groups.contains(group) { screenings[group, default: []] += placed.suggestions } }
            }
        }
        guard let data else { return }
        let reading = { (row: MyData.Row) -> Reading in (row.latest?.value, row.previous, row.unit, nil) }

        whtr = DerivedRow(whtrHistory)
        waist = data.vitals.first { $0.metric == "waist" }
        weight = data.vitals.first { $0.metric == "weight" }
        hba1c = data.bloodTests.first { $0.metric == "hba1c" }
        weightTarget = tiles["bmi"].map { "\($0.label) \($0.value)" } ?? weight?.target
        // The first row's reading: the ratio, or with none (no waist yet, or no height) the waist itself.
        let first: [Reading] = whtr.map { [($0.latest.value, $0.previous, "", nil)] } ?? waist.map { [reading($0)] } ?? []
        weightColumn = ValueRow.Column(first + [weight, hba1c].compactMap { $0 }.map(reading))

        pressure = data.vitals.first { $0.metric == MyData.bloodPressure }
        creatinine = data.bloodTests.first { $0.metric == "creatinine" }
        if let creatinine { egfr = Self.egfr(egfrHistory, tile: tiles["egfr"], creatinine: creatinine, labs: data.labTests ?? []) }
        let egfrReading: [Reading] = egfr.map { [($0.value, $0.previous, $0.unit, nil)] } ?? []
        pressureColumn = ValueRow.Column((creatinine.map { [reading($0)] } ?? []) + egfrReading)

        lipids = ["apob", "ldl", "total_cholesterol", "hdl", "triglycerides", "lpa"].compactMap { metric in data.bloodTests.first { $0.metric == metric } }
        if let tile = tiles["nonHdl"], let total = lipids.first(where: { $0.metric == "total_cholesterol" }), lipids.contains(where: { $0.metric == "hdl" }) {
            nonHdl = (tile, total)
        }
        lipidColumn = ValueRow.Column(lipids.map(reading) + (nonHdl.map { [($0.tile.value, nil, $0.tile.unit, nil)] } ?? []))

        bloodTests = data.bloodTests
        labs = (data.labTests ?? []).filter { !(egfr != nil && Self.isLabEgfr($0)) }
        bloodColumn = ValueRow.Column((bloodTests + labs).map(reading) + egfrReading)

        weightMedications = data.medications.filter { $0.id == "weight-medications" }
        lipidMedications = data.medications.filter { $0.id == "lipid-medications" }
        showsScreening = data.screeningNote != nil || !data.screenings.isEmpty || !self[.screening].isEmpty
    }

    /// The lab's own eGFR row, which the eGFR row stands for (one eGFR row, US-73 AC7).
    static func isLabEgfr(_ row: MyData.Row) -> Bool { row.series == "lab" && row.metric == "egfr" }

    /// The eGFR row: the plan's eGFR (its tile's value and status) on the day and from the
    /// source the engine names (`plan` on the series; from an engine before it, the series'
    /// newest point). None without a tile: the plan has no eGFR, so the lab's own row shows in
    /// Blood tests.
    static func egfr(_ history: MetricHistory?, tile: StatTile?, creatinine: MyData.Row, labs: [MyData.Row]) -> Egfr? {
        guard let tile, let history else { return nil }
        let rows = history.rows
        guard let current = history.plan ?? rows.first.flatMap({ row in row.source.map { MetricHistory.PlanEgfr(day: row.day, source: $0) } }) else { return nil }
        // The plan's point in the series; a lab limit has none. Older means before the plan's day:
        // a point on that day the plan did not use is never its previous value (review round 2).
        let at = rows.firstIndex { $0.day == current.day && $0.source == current.source }
        let older = rows.filter { $0.day < current.day }
        let lab = current.source == "lab"
        return Egfr(label: history.label, value: tile.value, unit: history.unit, day: current.day,
                    target: [tile.status?.label, lab ? "Lab result" : "Calculated"].compactMap { $0 }.joined(separator: " · "),
                    previous: older.first?.value, grade: PlanTiles.grade(tile),
                    trend: ((at.map { [rows[$0]] } ?? []) + older).prefix(7).compactMap(\.number).reversed(),
                    page: lab ? labs.first(where: isLabEgfr) ?? creatinine : creatinine)
    }

    /// Every suggestion as the page holds it: in a card, and on a row.
    var drawn: (cards: [Suggestion], rows: [Suggestion]) {
        (HealthTopic.allCases.flatMap { self[$0].urgent + self[$0].cards }.flatMap(\.suggestions),
         medicines.values.flatMap { $0 } + screenings.values.flatMap { $0 })
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

/// A worked-out series' row (the engine's `historyJson` series `whtr`, US-73 AC7): the newest
/// day's value, the day before's in brackets, and the recent values for the trend.
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
}
