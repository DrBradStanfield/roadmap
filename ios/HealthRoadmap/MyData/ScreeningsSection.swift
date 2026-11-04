import SwiftUI

/// Cancer screening and bone density (US-25 AC8): the questions the web asks
/// for the plan's age and sex, each answer saved through health-core's
/// `setScreening` with the web's clearing rules. PSA, under prostate, is a
/// dated value: it opens its page or entry like any blood test (`open`). The web
/// twin is InputPanel.tsx renderScreening and renderBoneDensity.
/// PROTOTYPE (My health, round 6): under the tab's own heading, so no title of its own; each
/// group in one row, with its plan suggestions (`suggestions`) in it.
struct ScreeningsSection: View {
    let store: RecordStore
    let data: MyData
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult
    /// Opens a dated value's page, or its entry when it has none (MyDataView).
    let open: (MyData.Row) -> Void
    var suggestions: [Suggestion] = []

    var body: some View {
        if let note = data.screeningNote {
            Section {
                Label(note, systemImage: "stethoscope")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } else {
            FormSectionsList(
                sections: data.screenings, months: data.months, title: SectionTitle.screening,
                answer: { key, value in saved(await store.apply(.form(.screening(key: key, value: value)))) },
                measurement: { $0 == data.psa.metric ? data.psa : nil },
                openMeasurement: { _ in open(data.psa) },
                suggestions: suggestions, compact: true
            )
        }
    }

    /// The groups that ask a question: a screening suggestion about one shows in it, not as a card.
    static func groups(_ data: MyData) -> Set<String> {
        Set(data.screenings.flatMap(\.groups).filter { !$0.fields.isEmpty }.map(\.id))
    }
}
