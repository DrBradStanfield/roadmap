import SwiftUI

/// One blood pressure: systolic and diastolic side by side, one day. The engine
/// saves both halves or neither (`bloodPressure` in ios/engine/blood-pressure.ts).
/// A day that already holds one asks first; replacing it corrects the half that
/// changed, the old row kept as entered in error. A replace names the rows the
/// user saw, so one another device moved meanwhile is refused (Codex R1). The web twin is the BP cell of
/// StartingInfoVitals.tsx, which commits the pair together.
struct BloodPressureSheet: View {
    let store: RecordStore
    /// Correcting a day's reading: the day is fixed and Save replaces it.
    var correcting: MetricHistory.Row?
    /// The screen the sheet was opened on (the tap).
    let seen: RecordStore.Screen
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    private enum Field { case systolic, diastolic }

    @Environment(\.dismiss) private var dismiss
    @State private var systolic = ""
    @State private var diastolic = ""
    @State private var day = Date.now
    @State private var message: String?
    @State private var asking = false
    /// The day's active rows when the "replace it?" prompt was shown.
    @State private var held: [String] = []
    /// A save is under way: the sheet stays open and its buttons wait.
    @State private var saving = false
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
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(replace: correcting != nil, seen: correcting?.pairIds ?? []) }.disabled(pair == nil || saving)
                }
            }
            .confirmationDialog("This day already has a blood pressure", isPresented: $asking, titleVisibility: .visible) {
                Button("Replace it") { save(replace: true, seen: held) }
            } message: {
                Text("The old value stays in your record, marked as entered in error.")
            }
            .onAppear { focus = .systolic }
        }
        .interactiveDismissDisabled(saving)
        .pinsRecord()
    }

    private func half(_ label: String, text: Binding<String>, hint: String?, field: Field) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            TextField(hint ?? "0", text: text)
                .analyticsMasked()
                .keyboardType(.numberPad)
                .typedNumber(text, .pressure, editing: focus == field)
                .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                .monospacedDigit()
                .focused($focus, equals: field)
                .onChange(of: text.wrappedValue) { message = nil }
                .accessibilityLabel(label)
        }
    }

    /// Both typed numbers, read by the web's rule, or nil until both are.
    private var pair: (systolic: Double, diastolic: Double)? {
        guard let s = TypedNumber.read(systolic), let d = TypedNumber.read(diastolic) else { return nil }
        return (s, d)
    }

    private func save(replace: Bool, seen: [String]) {
        guard let pair else { return }
        let when = correcting?.day ?? DayText.iso(day)
        let edit = RecordEdit.bloodPressure(systolic: pair.systolic, diastolic: pair.diastolic, day: when, replace: replace, seenIds: seen)
        SheetSave.run($saving, { saved(await store.apply(edit, as: self.seen)) }) { result in
            if case .refused(_, .some) = result, !replace {
                // The rows the prompt is about, read from the record as it is now (off the main
                // thread); a replace naming rows that moved since is refused (Codex R1).
                Task {
                    held = await store.chart(for: MyData.bloodPressure)?.history.rows.first { $0.isActive && $0.day == when }?.pairIds ?? []
                    asking = true
                }
            } else {
                SheetSave.close(result, dismiss, $message)
            }
        }
    }
}
