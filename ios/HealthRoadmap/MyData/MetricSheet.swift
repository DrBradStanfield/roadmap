import SwiftUI

/// What tapping a dated value opens (US-25 AC5, AC9): its history when the
/// record holds any row for it, entered-in-error ones included, so a wrong one
/// can be corrected and a struck one is still seen; straight to entry when it
/// holds none. Shared by Vitals, Blood tests and PSA under prostate screening.
struct MetricSheet: View {
    let store: RecordStore
    let row: MyData.Row
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    var body: some View {
        if Self.opensHistory(store.history(for: row.metric)) {
            HistoryView(store: store, row: row, saved: saved)
                .presentationDetents([.large])
        } else {
            ValueEntrySheet(title: row.label, unit: row.unit, current: nil, asksForDay: true, read: store.number) { value, day in
                saved(store.apply(.add(metric: row.metric, value: value, day: day)))
            } replace: { existingId, value in
                saved(store.apply(.correct(id: existingId, value: value)))
            }
            .presentationDetents([.medium, .large])
        }
    }

    /// History once the record holds any row for the metric, active or not (Codex R3).
    static func opensHistory(_ history: MetricHistory?) -> Bool {
        !(history?.rows.isEmpty ?? true)
    }
}
