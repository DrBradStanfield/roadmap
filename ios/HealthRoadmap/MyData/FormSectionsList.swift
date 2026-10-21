import SwiftUI

/// Engine form sections as grouped-list sections (US-25 AC8): a card's title
/// and lead paragraph, then each titled group (Colorectal, Lung…) as its own
/// section with its notes and questions. Untitled groups (one per drug) stay
/// in the card's section. The web twin is InputPanel.tsx's section cards.
struct FormSectionsList: View {
    let sections: [FormSection]
    let months: ScreeningMonths
    let read: (String) -> Double?
    /// Saves one answer to the question with this key.
    let answer: (_ key: String, _ value: String) -> RecordStore.ApplyResult
    /// For a dated value (PSA): its row, and how to open it.
    var measurement: (String) -> MyData.Row? = { _ in nil }
    var openMeasurement: (String) -> Void = { _ in }

    var body: some View {
        ForEach(sections) { section in
            Section {
                Text(section.intro).font(.subheadline).foregroundStyle(.secondary)
                ForEach(section.groups.filter(\.title.isEmpty)) { group in
                    rows(group)
                }
            } header: {
                Text(section.title)
            }
            ForEach(section.groups.filter { !$0.title.isEmpty }) { group in
                Section(group.title) { rows(group) }
            }
        }
    }

    @ViewBuilder
    private func rows(_ group: FormGroup) -> some View {
        ForEach(group.notes, id: \.self) { note in
            Label(note, systemImage: "info.circle")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        ForEach(group.fields) { field in
            FormFieldRow(field: field, months: months, answer: { value in answer(key(field), value) }, read: read,
                         measurement: metric(field).flatMap(measurement), openMeasurement: { metric(field).map(openMeasurement) })
        }
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
