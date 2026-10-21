import SwiftUI

/// Adds a value to one metric (US-25 AC5, AC17): systolic and diastolic side by
/// side for blood pressure, one number otherwise.
struct MetricEntrySheet: View {
    let store: RecordStore
    let row: MyData.Row
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    var body: some View {
        if row.metric == MyData.bloodPressure {
            BloodPressureSheet(store: store, saved: saved)
        } else {
            ValueEntrySheet(title: row.label, unit: row.unit, current: nil, asksForDay: true, read: store.number) { value, day in
                saved(store.apply(.add(metric: row.metric, value: value, day: day)))
            } replace: { existingId, value in
                saved(store.apply(.correct(id: existingId, value: value)))
            }
        }
    }
}

/// One blood pressure: systolic and diastolic side by side, one day. The engine
/// saves both halves or neither (`bloodPressure` in ios/engine/blood-pressure.ts).
/// A day that already holds one asks first; replacing it corrects the half that
/// changed, the old row kept as entered in error. The web twin is the BP cell of
/// StartingInfoVitals.tsx, which commits the pair together.
struct BloodPressureSheet: View {
    let store: RecordStore
    /// Correcting a day's reading: the day is fixed and Save replaces it.
    var correcting: MetricHistory.Row?
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    private enum Field { case systolic, diastolic }

    @Environment(\.dismiss) private var dismiss
    @State private var systolic = ""
    @State private var diastolic = ""
    @State private var day = Date.now
    @State private var message: String?
    @State private var asking = false
    @FocusState private var focus: Field?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(alignment: .lastTextBaseline, spacing: 12) {
                        half("Systolic", text: $systolic, hint: correcting?.systolic, field: .systolic)
                        Text("/").font(.system(.largeTitle, design: .rounded)).foregroundStyle(.secondary)
                        half("Diastolic", text: $diastolic, hint: correcting?.diastolic, field: .diastolic)
                        Text("mmHg").font(.title3).foregroundStyle(.secondary)
                    }
                } footer: {
                    if let message {
                        Text(message).foregroundStyle(.red)
                    } else if let correcting {
                        Text("Now \(correcting.value) mmHg")
                    }
                }
                if correcting == nil {
                    DatePicker("Day", selection: $day, in: ...Date.now, displayedComponents: .date)
                }
            }
            .navigationTitle(correcting.map { "Correct \(DayText.short($0.day))" } ?? "Blood pressure")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(replace: correcting != nil) }.disabled(pair == nil)
                }
            }
            .confirmationDialog("This day already has a blood pressure", isPresented: $asking, titleVisibility: .visible) {
                Button("Replace it") { save(replace: true) }
            } message: {
                Text("The old value stays in your record, marked as entered in error.")
            }
            .onAppear { focus = .systolic }
        }
        .pinsRecord()
    }

    private func half(_ label: String, text: Binding<String>, hint: String?, field: Field) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextField(hint ?? "0", text: text)
                .keyboardType(.numberPad)
                .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                .monospacedDigit()
                .focused($focus, equals: field)
                .onChange(of: text.wrappedValue) { message = nil }
                .accessibilityLabel(label)
        }
    }

    /// Both typed numbers, read by the web's rule, or nil until both are.
    private var pair: (systolic: Double, diastolic: Double)? {
        guard let s = store.number(systolic), let d = store.number(diastolic) else { return nil }
        return (s, d)
    }

    private func save(replace: Bool) {
        guard let pair else { return }
        let when = correcting?.day ?? DayText.iso(day)
        let result = saved(store.apply(.bloodPressure(systolic: pair.systolic, diastolic: pair.diastolic, day: when, replace: replace)))
        switch result {
        case .saved: dismiss()
        case .refused(_, .some) where !replace: asking = true
        case .refused(let why, _): message = why
        }
    }
}
