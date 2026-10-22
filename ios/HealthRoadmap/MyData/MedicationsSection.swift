import SwiftUI

/// The cholesterol and weight & diabetes medication questions (US-25 AC8, US-06):
/// health-core's cascades, so each step opens as the plan suggests it, with the
/// plan's words. An answer is saved at once through the web's own write
/// (medicationWrites, then upsertMedication). The web twin is InputPanel.tsx
/// renderMedications.
struct MedicationsSection: View {
    let store: RecordStore
    let data: MyData
    /// Called after a save, for the success haptic.
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    var body: some View {
        if data.medications.isEmpty {
            Section {
                Label("Medication questions appear once you add a cholesterol, HbA1c or triglyceride value, or your weight and height.", systemImage: "pills")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } header: {
                SectionTitle.medications()
            }
        } else {
            FormSectionsList(sections: data.medications, months: data.months, read: store.number, title: SectionTitle.medications) { field, value in
                saved(store.apply(.form(.medicationField(field: field, value: value))))
            }
        }
    }
}
