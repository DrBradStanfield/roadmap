import SwiftUI

/// Cancer screening and bone density (US-25 AC8): the questions the web asks
/// for the plan's age and sex, each answer saved through health-core's
/// `setScreening` with the web's clearing rules. PSA, under prostate, is a
/// dated value: it opens its history and entry like any blood test. The web
/// twin is InputPanel.tsx renderScreening and renderBoneDensity.
struct ScreeningsSection: View {
    let store: RecordStore
    let data: MyData
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    @State private var openPSA = false

    var body: some View {
        if let note = data.screeningNote {
            Section("Screening") {
                Label(note, systemImage: "stethoscope")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        } else {
            FormSectionsList(
                sections: data.screenings, months: data.months, read: store.number,
                answer: { key, value in saved(store.apply(.form(.screening(key: key, value: value)))) },
                measurement: { $0 == data.psa.metric ? data.psa : nil },
                openMeasurement: { _ in openPSA = true }
            )
            .sheet(isPresented: $openPSA) {
                MetricSheet(store: store, row: data.psa, saved: saved)
            }
        }
    }
}
