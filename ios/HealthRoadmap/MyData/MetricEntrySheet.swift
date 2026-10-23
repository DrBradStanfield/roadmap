import SwiftUI

/// Adds a value to one metric (US-25 AC5, AC17): systolic and diastolic side by
/// side for blood pressure, one number otherwise. Opened from My data and the
/// metric page's "+".
struct MetricEntrySheet: View {
    let store: RecordStore
    /// The row as it was tapped, and the screen it was read on: the label's unit and
    /// the units a value is read in come from the same moment (Codex R2).
    let row: MyData.Row
    /// An Lp(a) unit chosen in the sheet moves it (US-25 AC20).
    @State private var seen: RecordStore.Screen
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    init(store: RecordStore, row: MyData.Row, seen: RecordStore.Screen, saved: @escaping (RecordStore.ApplyResult) -> RecordStore.ApplyResult) {
        self.store = store
        self.row = row
        _seen = State(initialValue: seen)
        self.saved = saved
    }

    var body: some View {
        if row.metric == MyData.bloodPressure {
            BloodPressureSheet(store: store, seen: seen, saved: saved)
        } else {
            ValueEntrySheet(title: row.label, unit: store.lpaUnit(for: row) ?? row.unit, current: nil, asksForDay: true) { value, day in
                saved(await store.apply(.add(metric: row.metric, value: value, day: day), as: seen))
            } replace: { existingId, value in
                saved(await store.apply(.correct(id: existingId, value: value), as: seen))
            }
            .lpaUnits(store, row) { seen = seen.showing(lpaUnit: $0) }
        }
    }
}
