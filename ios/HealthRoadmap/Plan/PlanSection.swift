/// The groups the plan screen shows, in order. They match the web's results panel
/// (`ResultsPanel.tsx`, the `suggestions-group-title` headings) so a user sees the
/// same plan on both: Requires Attention, Next Steps, Foundation, Skin Health,
/// Supplements. Empty groups are left out.
struct PlanSection: Identifiable {
    let title: String
    let suggestions: [Plan.Suggestion]

    var id: String { title }

    static func sections(for suggestions: [Plan.Suggestion]) -> [PlanSection] {
        let isSpecial = { (s: Plan.Suggestion) in s.category == "supplements" || s.category == "skin" }
        return [
            PlanSection(title: "Requires Attention", suggestions: suggestions.filter { $0.priority == "urgent" }),
            PlanSection(title: "Next Steps", suggestions: suggestions.filter { $0.priority == "attention" }),
            PlanSection(title: "Foundation", suggestions: suggestions.filter { $0.priority == "info" && !isSpecial($0) }),
            PlanSection(title: "Skin Health", suggestions: suggestions.filter { $0.category == "skin" }),
            PlanSection(title: "Supplements", suggestions: suggestions.filter { $0.category == "supplements" }),
        ].filter { !$0.suggestions.isEmpty }
    }
}
