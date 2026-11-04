import SwiftUI

/// Engine form sections as grouped-list sections (US-25 AC8): a card's title
/// and lead paragraph, then each titled group (Colorectal, Lung…) as its own
/// section with its notes and questions. Untitled groups (one per drug) stay
/// in the card's section. `compact` draws screenings tighter (round 6).
/// The web twin is InputPanel.tsx's section cards.
struct FormSectionsList: View {
    let sections: [FormSection]
    let months: ScreeningMonths
    /// A card's title, drawn with its section's symbol.
    let title: (String) -> SectionTitle
    /// Saves one answer to the question with this key.
    let answer: (_ key: String, _ value: String) async -> RecordStore.ApplyResult
    /// For a dated value (PSA): its row, and how to open it.
    var measurement: (String) -> MyData.Row? = { _ in nil }
    var openMeasurement: (String) -> Void = { _ in }
    /// Guides by question key (US-58 AC5): a question with one gets an info button that opens it.
    var guides: MetricGuides?
    /// PROTOTYPE (My health, round 4): medicine suggestions, each shown in its question's info
    /// sheet (TopicPlan.questionKeys); one with no question here is left out.
    var suggestions: [Suggestion] = []
    /// PROTOTYPE (My health, round 6; screenings): a card whose groups are all titled has no
    /// header (the topic's heading names it); each group's name sits on its first question's row,
    /// with its plan suggestions under it; the lead paragraph is the last group's caption.
    var compact = false

    var body: some View {
        ForEach(sections) { section in
            if compact && section.groups.allSatisfy({ !$0.title.isEmpty }) {
                ForEach(section.groups) { group in
                    Section {
                        named(group)
                    } footer: {
                        if group.id == section.groups.last?.id { Text(section.intro) }
                    }
                    .listSectionSpacing(.compact)
                }
            } else {
                full(section)
            }
        }
    }

    @ViewBuilder
    private func full(_ section: FormSection) -> some View {
        Section {
            Text(section.intro).font(.subheadline).foregroundStyle(.secondary)
            ForEach(section.groups.filter(\.title.isEmpty)) { group in
                rows(group)
            }
        } header: {
            title(section.title)
        }
        ForEach(section.groups.filter { !$0.title.isEmpty }) { group in
            Section(group.title) { rows(group) }
        }
    }

    @ViewBuilder
    private func rows(_ group: FormGroup) -> some View {
        notes(group)
        ForEach(group.fields) { row($0) }
    }

    /// A group in one row: its name on its first question's row (the banner's scroll target), its notes, then the rest.
    @ViewBuilder
    private func named(_ group: FormGroup) -> some View {
        if let first = group.fields.first {
            row(first, heading: group.title).id(TopicPlan.groupAnchor(group.id))
        } else {
            Text(group.title)
        }
        notes(group)
        ForEach(group.fields.dropFirst()) { row($0) }
    }

    /// The group's notes, less one a suggestion shown in the group already says (Brad, round 6: prostate's PSA line).
    private func notes(_ group: FormGroup) -> some View {
        let said = group.fields.flatMap { placed[key($0)] ?? [] }.map(\.description)
        return ForEach(group.notes.filter { note in !(compact && said.contains { $0.contains(note) }) }, id: \.self) { note in
            Label(note, systemImage: "info.circle")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func row(_ field: FormField, heading: String? = nil) -> some View {
        FormFieldRow(field: field, months: months, answer: { value in await answer(key(field), value) },
                     measurement: metric(field).flatMap(measurement), openMeasurement: { metric(field).map(openMeasurement) },
                     guide: guides?[key(field)], suggestions: placed[key(field)] ?? [], heading: heading, describes: compact)
    }

    /// Each suggestion beside the first of its questions that this list asks; a screening one
    /// beside its group's first question.
    private var placed: [String: [Suggestion]] {
        let groups = sections.flatMap(\.groups)
        let asked = Set(groups.flatMap(\.fields).map(key))
        let firsts = Dictionary(groups.compactMap { group in group.fields.first.map { (group.id, key($0)) } }, uniquingKeysWith: { first, _ in first })
        var placed: [String: [Suggestion]] = [:]
        for suggestion in suggestions {
            let group = TopicPlan.screeningGroup(suggestion).flatMap { firsts[$0] }
            if let key = TopicPlan.questionKeys(for: suggestion).first(where: asked.contains) ?? group { placed[key, default: []].append(suggestion) }
        }
        return placed
    }

    private func key(_ field: FormField) -> String {
        switch field {
        case .choice(let key, _, _, _, _), .month(let key, _, _, _), .number(let key, _, _, _): key
        case .measurement(let metric, _, _): metric
        }
    }

    private func metric(_ field: FormField) -> String? {
        if case .measurement(let metric, _, _) = field { metric } else { nil }
    }
}
