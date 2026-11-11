import SwiftUI

/// Supplements (US-25 AC8, US-06): the ones taken now, any other from the
/// catalogue (featured ones starred) or typed by name, and the ones stopped.
/// Stopping is a soft stop (status "stopped", a history row), never a
/// removal, and a stopped one can be taken again. The list, its names and its
/// units come from health-core. The web twin is InputPanel.tsx renderSupplements.
/// On My health, under the Supplements heading and its cards, with no intro or quick-add
/// chips (US-73 AC10); the add sheet lists the same featured ones.
struct SupplementsSection: View {
    let store: RecordStore
    let supplements: SupplementsView
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    @State private var editing: SupplementsView.Row?
    @State private var adding = false
    /// A "Taking again" (US-25 AC21e): one at a time; a refusal's words show in the alert.
    @State private var state: SheetSave.State<SheetSave.NoHeld> = .editing(message: nil)

    var body: some View {
        Section {
            ForEach(supplements.active) { row in
                Button { editing = row } label: { SupplementRow(row: row) }
                    .tint(.primary)
            }
            Button { adding = true } label: { Label("Add another supplement", systemImage: "plus.circle.fill") }
        }
        .sheet(item: $editing) { row in
            SupplementSheet(row: row, units: supplements.units) { edit in
                saved(await store.apply(.form(edit)))
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $adding) {
            AddSupplementSheet(choices: supplements.choices) { edit in saved(await store.apply(.form(edit))) }
        }
        .refusalAlert(Binding(get: { state.message }, set: { if $0 == nil { SheetSave.send(&state, .wordsStale) } }))

        if !supplements.stopped.isEmpty {
            Section {
                ForEach(supplements.stopped) { row in
                    HStack {
                        SupplementRow(row: row, stopped: true).foregroundStyle(.secondary)
                        Button("Taking again") { take(row) }
                            .disabled(state.busy)
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                }
            } header: {
                Text("Stopped")
            } footer: {
                Text("Kept in your record with the day you stopped.")
            }
        }
    }

    /// Not a sheet: the section stays open, so a save goes back to editing.
    static let closes = false

    private func take(_ row: SupplementsView.Row) {
        guard SheetSave.send(&state, .tapped) else { return }
        Task {
            let result = saved(await store.apply(.form(.supplement(key: row.key, name: row.name, dose: row.dose, unit: row.unit, stopped: false))))
            SheetSave.send(&state, .landed(result, closes: Self.closes, asks: .never))
        }
    }
}

/// A supplement's name, its dose, and since when, or for a stopped one the day it stopped.
private struct SupplementRow: View {
    let row: SupplementsView.Row
    var stopped = false

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                Text(row.dayLine(stopped: stopped)).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if let dose = row.dose {
                Text(SupplementSheet.doseText(dose)).font(.body.weight(.semibold)).monospacedDigit()
                Text(row.unit ?? "").font(.subheadline).foregroundStyle(.secondary)
            } else {
                Text("Add dose").foregroundStyle(Color.accentColor)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}
