import SwiftUI

/// What tapping a dated value opens (US-25 AC5, AC9): its history when it has
/// values, so a wrong one can be corrected; straight to entry when it has none.
/// Shared by Vitals, Blood tests and PSA under prostate screening.
struct MetricSheet: View {
    let store: RecordStore
    let row: MyData.Row
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    var body: some View {
        if row.latest == nil {
            ValueEntrySheet(title: row.label, unit: row.unit, current: nil, asksForDay: true, read: store.number) { value, day in
                saved(store.apply(.add(metric: row.metric, value: value, day: day)))
            } replace: { existingId, value in
                saved(store.apply(.correct(id: existingId, value: value)))
            }
            .presentationDetents([.medium, .large])
        } else {
            HistoryView(store: store, row: row, saved: saved)
                .presentationDetents([.large])
        }
    }
}
