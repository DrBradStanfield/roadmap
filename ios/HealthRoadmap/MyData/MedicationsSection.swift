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
    /// PROTOTYPE (My health tab): only the section with this id ("weight-medications",
    /// "lipid-medications"), and nothing when the engine has none; nil: all, as My data showed them.
    var only: String? = nil
    /// PROTOTYPE (My health, round 4): the plan's medicine suggestions, each behind its question's
    /// info button; the ones for another section's questions are left out there.
    var suggestions: [Suggestion] = []

    var body: some View {
        if let only {
            FormSectionsList(sections: data.medications.filter { $0.id == only }, months: data.months, title: SectionTitle.medications, answer: { field, value in
                saved(await store.apply(.form(.medicationField(field: field, value: value))))
            }, guides: data.guides, suggestions: suggestions)
        } else if data.medications.isEmpty {
            Section {
                Label("Medication questions appear once you add a cholesterol, HbA1c or triglyceride value, or your weight and height.", systemImage: "pills")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            } header: {
                SectionTitle.medications()
            }
        } else {
            // Each drug question's info button opens its guide (US-58 AC5).
            FormSectionsList(sections: data.medications, months: data.months, title: SectionTitle.medications, answer: { field, value in
                saved(await store.apply(.form(.medicationField(field: field, value: value))))
            }, guides: data.guides)
        }
    }
}
