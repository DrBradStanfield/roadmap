import SwiftUI

/// One supplement taken now: its dose and unit, or stop taking it (US-25 AC8).
/// Stopping keeps the supplement in the record as stopped; nothing is removed.
/// The web twin is a supplement row in InputPanel.tsx renderSupplements.
struct SupplementSheet: View {
    let row: SupplementsView.Row
    /// The units health-core offers; the row's own unit stays pickable even if not listed.
    let units: [String]
    let save: (FormEdit) async -> RecordStore.ApplyResult

    @Environment(\.dismiss) private var dismiss
    @State private var dose = ""
    @FocusState private var editingDose: Bool
    @State private var unit = ""
    @State private var message: String?
    @State private var confirmingStop = false
    /// A save is under way: the sheet stays open and its buttons wait.
    @State private var saving = false

    var body: some View {
        sheet.pinsRecord()
    }

    private var sheet: some View {
        NavigationStack {
            Form {
                Section {
                    HStack {
                        TextField("Dose", text: $dose)
                            .analyticsMasked()
                            .keyboardType(.decimalPad)
                            .focused($editingDose)
                            .typedNumber($dose, .dose, editing: editingDose)
                            .font(.title2.weight(.semibold))
                            .monospacedDigit()
                        Picker("Unit", selection: $unit) {
                            Text("Unit").tag("")
                            ForEach(unitChoices, id: \.self) { Text($0).tag($0) }
                        }
                        .labelsHidden()
                    }
                } footer: {
                    if let message { Text(message).foregroundStyle(.red) } else { Text("Since \(DayText.short(row.startedDay))") }
                }
                Section {
                    Button("Stop taking \(row.name)") { confirmingStop = true }.disabled(saving)
                } footer: {
                    Text("It stays in your record as stopped, and you can take it again.")
                }
            }
            .navigationTitle(row.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) { Button("Save", action: saveDose).disabled(!doseReadable || saving) }
            }
            .confirmationDialog("Stop taking \(row.name)?", isPresented: $confirmingStop, titleVisibility: .visible) {
                Button("Stop taking") {
                    submit(.supplement(key: row.key, name: row.name, dose: row.dose, unit: row.unit, stopped: true))
                }
            }
            .onAppear {
                dose = row.dose.map(Self.doseText) ?? ""
                unit = row.unit ?? ""
            }
        }
        .interactiveDismissDisabled(saving)
    }

    /// The listed units, plus the row's own if the list lacks it (a featured default such as "serving").
    private var unitChoices: [String] {
        guard let own = row.unit, !own.isEmpty, !units.contains(own) else { return units }
        return [own] + units
    }

    /// An empty dose is "no dose"; anything else must read as a number.
    private var doseReadable: Bool { dose.trimmingCharacters(in: .whitespaces).isEmpty || TypedNumber.read(dose) != nil }

    private func saveDose() {
        let value = dose.trimmingCharacters(in: .whitespaces).isEmpty ? nil : TypedNumber.read(dose)
        submit(.supplement(key: row.key, name: row.name, dose: value, unit: unit.isEmpty ? nil : unit, stopped: false))
    }

    private func submit(_ edit: FormEdit) {
        SheetSave.run($saving, { await save(edit) }) { SheetSave.close($0, dismiss, $message) }
    }

    /// "5" for a whole dose, "2.5" otherwise. `Int(_:)` traps past its range, and the
    /// schema puts no upper bound on a dose, so only a modest whole number goes through it.
    static func doseText(_ dose: Double) -> String {
        dose.rounded() == dose && abs(dose) < 1e15 ? String(Int(dose)) : String(dose)
    }
}

/// Add a supplement: search health-core's list, or add the typed name as your own.
struct AddSupplementSheet: View {
    let choices: [SupplementsView.Choice]
    let save: (FormEdit) async -> RecordStore.ApplyResult

    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var message: String?
    /// A save is under way: the sheet stays open and its buttons wait.
    @State private var saving = false

    var body: some View {
        sheet.pinsRecord()
    }

    private var sheet: some View {
        NavigationStack {
            List {
                if let message {
                    Text(message).foregroundStyle(.red)
                }
                if canAddTyped {
                    Button { submit(.customSupplement(name: typed)) } label: {
                        Label("Add \u{201C}\(typed)\u{201D}", systemImage: "plus.circle.fill")
                    }
                    .disabled(saving)
                }
                ForEach(matches) { choice in
                    Button {
                        submit(.supplement(key: choice.key, name: choice.name, dose: choice.dose, unit: choice.unit, stopped: false))
                    } label: {
                        HStack {
                            Text(choice.name)
                            if choice.featured {
                                Spacer()
                                Image(systemName: "star.fill").foregroundStyle(.yellow).accessibilityLabel("Featured")
                            }
                        }
                    }
                    .tint(.primary)
                    .disabled(saving)
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search or type a name")
            .navigationTitle("Add a supplement")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) } }
        }
        .interactiveDismissDisabled(saving)
    }

    private var typed: String { String(search.trimmingCharacters(in: .whitespaces).prefix(100)) }

    private var matches: [SupplementsView.Choice] {
        typed.isEmpty ? choices : choices.filter { $0.name.localizedCaseInsensitiveContains(typed) }
    }

    /// A typed name with no exact match on the list can always be added (the web's rule).
    private var canAddTyped: Bool {
        !typed.isEmpty && !choices.contains { $0.name.caseInsensitiveCompare(typed) == .orderedSame }
    }

    private func submit(_ edit: FormEdit) {
        SheetSave.run($saving, { await save(edit) }) { SheetSave.close($0, dismiss, $message) }
    }
}
