import SwiftUI

/// Cancer screening and bone density (US-25 AC8): the questions the web asks
/// for the plan's age and sex, each answer saved through health-core's
/// `setScreening` with the web's clearing rules. PSA, under prostate, is a
/// dated value: it opens its page or entry like any blood test (`open`). The web
/// twin is InputPanel.tsx renderScreening and renderBoneDensity.
struct ScreeningsSection: View {
    let store: RecordStore
    let data: MyData
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult
    /// Opens a dated value's page, or its entry when it has none (MyDataView).
    let open: (MyData.Row) -> Void

    var body: some View {
        if let note = data.screeningNote {
            Section {
                Label(note, systemImage: "stethoscope")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } header: {
                SectionTitle.screening()
            }
        } else {
            FormSectionsList(
                sections: data.screenings, months: data.months, read: store.number, title: SectionTitle.screening,
                answer: { key, value in saved(store.apply(.form(.screening(key: key, value: value)))) },
                measurement: { $0 == data.psa.metric ? data.psa : nil },
                openMeasurement: { _ in open(data.psa) }
            )
        }
    }
}
