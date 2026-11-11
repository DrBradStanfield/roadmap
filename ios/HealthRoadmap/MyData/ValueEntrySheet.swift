import SwiftUI

/// Enter one number, in the user's units, for a day. The engine decides whether
/// it is saved; a refusal shows in its own words. When the day already has a
/// value, the sheet asks before replacing it, and replacing is a correction:
/// the old value stays in the record, marked entered-in-error (US-25 AC5).
struct ValueEntrySheet: View {
    let title: String
    let unit: String
    /// The current value, shown as a hint.
    let current: String?
    /// Vitals and blood tests belong to a day; height does not.
    let asksForDay: Bool
    /// Saves a value for a day (YYYY-MM-DD).
    let save: (Double, String) async -> RecordStore.ApplyResult
    /// Replaces the value in a row with a correction.
    var replace: ((String, Double) async -> RecordStore.ApplyResult)?
    /// Lp(a)'s three units (US-05 AC2, US-25 AC20), chosen here so a first value is typed in
    /// the lab's unit; `unit` is the record's choice as it is now. Choosing writes the
    /// record's unit and answers a refusal's words, nil when it was taken.
    var units: [String] = []
    var chooseUnit: ((String) async -> String?)?
    /// A new test's unit, typed (US-73 AC8): Save waits for one.
    var typedUnit: Binding<String>?
    /// The value's input range in `unit` (`RecordStore.inputRange`): a typed "1,234" is the
    /// one reading inside it; nil (a form's question) asks which was meant (US-02 AC7).
    var range: ClosedRange<Double>?

    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var day = Date.now
    /// The save (US-25 AC21e): held while it or a unit choice lands; asking holds the day's row.
    @State private var state: SheetSave.State<Held> = .editing(message: nil)
    @FocusState private var focused: Bool

    var body: some View {
        sheet.pinsRecord()
    }

    private var sheet: some View {
        NavigationStack {
            Form {
                Section {
                    BigNumberField(placeholder: current ?? "0", text: $text, unit: unit, focus: $focused, field: true, label: title)
                        .onChange(of: text) { SheetSave.send(&state, .wordsStale) }
                    if let chooseUnit, !units.isEmpty {
                        // Held, with Save, while the choice lands: a value is never read mid-switch.
                        Picker("Unit", selection: Binding(get: { unit }, set: { choice in
                            guard SheetSave.send(&state, .unitChosen) else { return }
                            Task {
                                let words = await chooseUnit(choice)
                                SheetSave.send(&state, .unitLanded(words))
                            }
                        })) {
                            ForEach(units, id: \.self) { Text($0).tag($0) }
                        }
                        .pickerStyle(.segmented)
                        .disabled(state.busy)
                    }
                    if let typedUnit {
                        TextField("Unit, as the lab printed it", text: typedUnit)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .analyticsMasked()
                            .onChange(of: typedUnit.wrappedValue) { SheetSave.send(&state, .wordsStale) }
                    }
                } footer: {
                    if let message = state.message ?? TypedNumber.question(text, range: range) {
                        Text(message).foregroundStyle(.red)
                    } else if let current {
                        Text("Now \(current) \(unit)")
                    }
                }
                if asksForDay {
                    DatePicker("Day", selection: $day, in: ...Date.now, displayedComponents: .date)
                }
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(state.busy) }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: submit).disabled(number == nil || state.busy || typedUnit?.wrappedValue.trimmingCharacters(in: .whitespaces).isEmpty == true)
                }
            }
            .confirmationDialog("This day already has a value", isPresented: Binding(get: { state.held != nil }, set: { if !$0 { declineLater() } }), titleVisibility: .visible) {
                Button("Replace it") {
                    guard let held = state.held, let replace else { return }
                    write(.confirmed) { await replace(held.id, held.value) }
                }
            } message: {
                Text("The old value stays in your record, marked as entered in error.")
            }
            .onAppear { focused = true }
        }
        .interactiveDismissDisabled(state.busy)
    }

    /// The typed number: either decimal mark, and nothing that is not read in full,
    /// so "3.4" on a German phone is 3.4, never 3.
    private var number: Double? { TypedNumber.read(text, range: range) }

    private func submit() {
        guard let number else { return }
        let when = DayText.iso(day)
        write(.tapped, asks: replace == nil ? .never : .holding { Held(id: $0, value: number) }) { await save(number, when) }
    }

    /// The dialog's dismissal sends `declined` one main-actor turn later, so "Replace it"'s
    /// `confirmed` always lands first whichever order SwiftUI runs the button and the
    /// isPresented set in; a late `declined` meets saving and is ignored. A tap outside
    /// still reaches editing one turn later.
    private func declineLater() {
        Task { @MainActor in SheetSave.send(&state, .declined) }
    }

    /// `claim` moves the state to saving, or the tap does nothing; a refusal naming the day's
    /// row asks only when `asks` says so.
    private func write(_ claim: SheetSave.Event<Held>, asks: SheetSave.Asks<Held> = .never, _ edit: @escaping () async -> RecordStore.ApplyResult) {
        guard SheetSave.send(&state, claim) else { return }
        Task {
            let result = await edit()
            SheetSave.send(&state, .landed(result, closes: true, asks: asks))
            if state == .done { dismiss() }
        }
    }

    /// The day's row a replace corrects, with the number typed.
    struct Held: SheetHeld {
        let id: String
        let value: Double
        var isEmpty: Bool { id.isEmpty }
    }
}

extension ValueEntrySheet {
    /// Reads a typed "1,234" against `range`, the value's input range in the sheet's unit (US-02 AC7).
    func reads(in range: ClosedRange<Double>?) -> ValueEntrySheet {
        var sheet = self
        sheet.range = range
        return sheet
    }

    /// Lp(a)'s unit picker in its sheets (US-25 AC20); any other row's sheet is as it was.
    /// `shows`: a unit chosen here is the sheet's from then on, so its screen carries it and
    /// a value typed there is read in the unit shown at Save.
    func lpaUnits(_ store: RecordStore, _ row: MyData.Row, shows: @escaping (String) -> Void) -> ValueEntrySheet {
        guard store.lpaUnit(for: row) != nil else { return self }
        var sheet = self
        sheet.units = RecordStore.lpaUnits
        sheet.chooseUnit = { unit in
            let refusal = await store.chooseLpaUnit(unit).value
            if refusal == nil { shows(unit) }
            return refusal
        }
        return sheet
    }
}
