import SwiftUI

/// One blood pressure: systolic and diastolic side by side, one day. The engine
/// saves both halves or neither (`bloodPressure` in ios/engine/blood-pressure.ts).
/// A day that already holds one asks first; replacing it corrects the half that
/// changed, the old row kept as entered in error. A replace names the rows the
/// user saw, so one another device moved meanwhile is refused (Codex R1). The web twin is the BP cell of
/// StartingInfoVitals.tsx, which commits the pair together. A typed systolic moves the focus to
/// the diastolic by health-core's rule, as the web's boxes do (`SystolicAdvance`, US-02 AC12).
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
    /// The save (US-25 AC21e): held while it lands and while the day's rows are read; asking
    /// holds the day's active rows the "replace it?" prompt is about.
    @State private var state: SheetSave.State<[String]> = .editing(message: nil)
    /// The systolic's move to the diastolic (US-02 AC6, AC12).
    @State private var advance: SystolicAdvance = .idle
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
                    if let message = state.message {
                        Text(message).foregroundStyle(.red)
                    } else if let correcting {
                        Text("Now \(correcting.value) mmHg")
                    }
                }
                if correcting == nil {
                    DatePicker("Day", selection: $day, in: ...Date.now, displayedComponents: .date)
                        .onChange(of: day) { SheetSave.send(&state, .wordsStale) }
                }
            }
            .navigationTitle(correcting.map { "Correct \(DayText.short($0.day))" } ?? "Blood pressure")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(state.busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save(.tapped, replace: correcting != nil, seen: correcting?.pairIds ?? []) }.disabled(pair == nil || state.busy)
                }
            }
            .confirmationDialog("This day already has a blood pressure", isPresented: Binding(get: { state.held != nil }, set: { if !$0 { SheetSave.send(&state, .declined) } }), titleVisibility: .visible, presenting: state.held) { held in
                Button("Replace it") { save(.confirmed(held), replace: true, seen: held) }
            } message: { _ in
                Text("The old value stays in your record, kept as a mistake.")
            }
            .onAppear { focus = .systolic }
            .onChange(of: systolic) { step(.typed(systolic: systolic, diastolic: diastolic)) }
            .task(id: advance) { await run(advance) }
        }
        .interactiveDismissDisabled(state.busy)
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
                .onChange(of: text.wrappedValue) { SheetSave.send(&state, .wordsStale) }
                .accessibilityLabel(label)
        }
    }

    /// Both typed numbers, read by the web's rule, or nil until both are.
    private var pair: (systolic: Double, diastolic: Double)? {
        guard let s = TypedNumber.read(systolic), let d = TypedNumber.read(diastolic) else { return nil }
        return (s, d)
    }

    private func step(_ event: SystolicAdvance.Event) {
        let next = SystolicAdvance.transition(advance, event)
        advance = next.state
        if next.moves { focus = .diastolic }
    }

    /// What the advance state asks for: the engine's word, or the pause. A newer state cancels it;
    /// a cancelled sleep returns at once, so the check keeps a retyped "65" from ending its new pause early.
    private func run(_ state: SystolicAdvance) async {
        switch state {
        case .idle: return
        case .asking(let s, let d):
            let word = try? await store.engine.bpSysAdvance(systolic: s, diastolic: d)
            if !Task.isCancelled { step(.judged(systolic: s, diastolic: d, word: word)) }
        case .pausing(let s):
            try? await Task.sleep(for: SystolicAdvance.pause)
            if !Task.isCancelled { step(.pauseEnded(systolic: s, focused: focus == .systolic)) }
        }
    }

    /// A save closes the sheet.
    static let closes = true
    /// A refused first save asks after reading the day's rows; a refused replace shows its words.
    static func asks(replace: Bool) -> SheetSave.Asks<[String]> { replace ? .never : .findRows }

    /// `claim` (a tap on Save, or "Replace it") moves the state to saving, or the tap does nothing.
    private func save(_ claim: SheetSave.Event<[String]>, replace: Bool, seen: [String]) {
        guard let pair, SheetSave.send(&state, claim) else { return }
        let when = correcting?.day ?? DayText.iso(day)
        let edit = RecordEdit.bloodPressure(systolic: pair.systolic, diastolic: pair.diastolic, day: when, replace: replace, seenIds: seen)
        Task {
            let result = saved(await store.apply(edit, as: self.seen))
            SheetSave.send(&state, .landed(result, closes: Self.closes, asks: Self.asks(replace: replace)))
            switch state {
            case .findingRows:
                // The rows the prompt is about, read from the record as it is now (off the main
                // thread); a replace naming rows that moved since is refused (Codex R1).
                let rows = await store.chart(for: MyData.bloodPressure)?.history.rows.first { $0.isActive && $0.day == when }?.pairIds
                SheetSave.send(&state, .rowsFound(rows))
            case .done: dismiss()
            default: break
            }
        }
    }
}
