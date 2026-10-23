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
    /// Reads the typed text as a number by the web's rule (`RecordStore.number`).
    let read: (String) -> Double?
    /// Saves a value for a day (YYYY-MM-DD).
    let save: (Double, String) -> RecordStore.ApplyResult
    /// Replaces the value in a row with a correction.
    var replace: ((String, Double) -> RecordStore.ApplyResult)?
    /// Lp(a)'s three units (US-05 AC2, US-25 AC20), chosen here so a first value is typed in
    /// the lab's unit; `unit` is the record's choice as it is now. Choosing writes the
    /// record's unit and answers a refusal's words, nil when it was taken.
    var units: [String] = []
    var chooseUnit: ((String) -> String?)?

    @Environment(\.dismiss) private var dismiss
    @State private var text = ""
    @State private var day = Date.now
    @State private var message: String?
    @State private var held: (id: String, value: Double)?
    @FocusState private var focused: Bool

    var body: some View {
        sheet.pinsRecord()
    }

    private var sheet: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(alignment: .firstTextBaseline) {
                        TextField(current ?? "0", text: $text)
                            .analyticsMasked()
                            .keyboardType(.decimalPad)
                            .typedNumber($text, .value, editing: focused)
                            .font(.system(size: 44, weight: .semibold, design: .rounded))
                            .monospacedDigit()
                            .focused($focused)
                            .onChange(of: text) { message = nil }
                        Text(unit).font(.title3).foregroundStyle(.secondary)
                    }
                    if let chooseUnit, !units.isEmpty {
                        Picker("Unit", selection: Binding(get: { unit }, set: { message = chooseUnit($0) })) {
                            ForEach(units, id: \.self) { Text($0).tag($0) }
                        }
                        .pickerStyle(.segmented)
                    }
                } footer: {
                    if let message {
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
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save", action: submit).disabled(number == nil)
                }
            }
            .confirmationDialog("This day already has a value", isPresented: Binding(get: { held != nil }, set: { if !$0 { held = nil } }), titleVisibility: .visible) {
                Button("Replace it") {
                    if let held, let replace { finish(replace(held.id, held.value)) }
                }
            } message: {
                Text("The old value stays in your record, marked as entered in error.")
            }
            .onAppear { focused = true }
        }
    }

    /// The typed number: either decimal mark, and nothing that is not read in full,
    /// so "3.4" on a German phone is 3.4, never 3.
    private var number: Double? { read(text) }

    private func submit() {
        guard let number else { return }
        let result = save(number, DayText.iso(day))
        if case .refused(_, let existingId?) = result, replace != nil {
            held = (existingId, number)
        } else {
            finish(result)
        }
    }

    private func finish(_ result: RecordStore.ApplyResult) {
        switch result {
        case .saved: dismiss()
        case .refused(let why, _): message = why
        }
    }
}

extension ValueEntrySheet {
    /// Lp(a)'s unit picker in its sheets (US-25 AC20); any other row's sheet is as it was.
    func lpaUnits(_ store: RecordStore, _ row: MyData.Row) -> ValueEntrySheet {
        guard store.lpaUnit(for: row) != nil else { return self }
        var sheet = self
        sheet.units = RecordStore.lpaUnits
        sheet.chooseUnit = { store.chooseLpaUnit($0) }
        return sheet
    }
}
