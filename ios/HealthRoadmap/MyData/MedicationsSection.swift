import SwiftUI

/// The cholesterol or weight & diabetes medication questions (US-25 AC8, US-06):
/// health-core's cascades, so each step opens as the plan suggests it, with the
/// plan's words. An answer is saved at once through the web's own write
/// (medicationWrites, then upsertMedication). Each drug question's info button opens
/// its guide (US-58 AC5), after the plan's suggestions on it (US-73 AC6). The web twin
/// is InputPanel.tsx renderMedications.
struct MedicationsSection: View {
    let store: RecordStore
    let data: MyData
    /// Called after a save, for the success haptic.
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult
    /// The engine's section id, "weight-medications" or "lipid-medications"; nothing when it has none.
    let section: String
    /// The plan's medicine suggestions by question key (`TopicPlan.medicines`).
    var placed: [String: [Suggestion]] = [:]

    var body: some View {
        FormSectionsList(sections: data.medications.filter { $0.id == section }, months: data.months, title: SectionTitle.medications, answer: { field, value in
            saved(await store.apply(.form(.medicationField(field: field, value: value))))
        }, guides: data.guides, placed: placed)
    }
}
