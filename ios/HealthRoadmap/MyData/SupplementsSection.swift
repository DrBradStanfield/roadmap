import SwiftUI

/// Supplements (US-25 AC8, US-06): the ones taken now, quick-add for the
/// featured list, any other from the catalogue or typed by name, and the ones
/// stopped. Stopping is a soft stop (status "stopped", a history row), never a
/// removal, and a stopped one can be taken again. The list, its names and its
/// units come from health-core. The web twin is InputPanel.tsx renderSupplements.
struct SupplementsSection: View {
    let store: RecordStore
    let supplements: SupplementsView
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    @State private var editing: SupplementsView.Row?
    @State private var adding = false
    @State private var refusal: String?

    var body: some View {
        Section {
            Text(supplements.intro).font(.subheadline).foregroundStyle(.secondary)
            ForEach(supplements.active) { row in
                Button { editing = row } label: { SupplementRow(row: row) }
                    .tint(.primary)
            }
            quickAdd
            Button { adding = true } label: { Label("Add another supplement", systemImage: "plus.circle.fill") }
        } header: {
            Text("Supplements")
        }
        .sheet(item: $editing) { row in
            SupplementSheet(row: row, units: supplements.units, read: store.number) { edit in
                saved(store.apply(.form(edit)))
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $adding) {
            AddSupplementSheet(choices: supplements.choices) { edit in saved(store.apply(.form(edit))) }
        }
        .alert("Not saved", isPresented: Binding(get: { refusal != nil }, set: { if !$0 { refusal = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(refusal ?? "")
        }

        if !supplements.stopped.isEmpty {
            Section {
                ForEach(supplements.stopped) { row in
                    HStack {
                        SupplementRow(row: row).foregroundStyle(.secondary)
                        Button("Taking again") { take(row) }
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

    /// The featured supplements not yet taken, one tap each, with the web's default dose.
    @ViewBuilder
    private var quickAdd: some View {
        let featured = supplements.choices.filter(\.featured)
        if !featured.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack {
                    ForEach(featured) { choice in
                        Button { add(choice) } label: { Label(choice.name, systemImage: "plus") }
                            .buttonStyle(.bordered)
                            .buttonBorderShape(.capsule)
                    }
                }
            }
            .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
            .accessibilityLabel("Quick add")
        }
    }

    private func add(_ choice: SupplementsView.Choice) {
        let result = saved(store.apply(.form(.supplement(key: choice.key, name: choice.name, dose: choice.dose, unit: choice.unit, stopped: false))))
        if case .refused(let why, _) = result { refusal = why }
    }

    private func take(_ row: SupplementsView.Row) {
        let result = saved(store.apply(.form(.supplement(key: row.key, name: row.name, dose: row.dose, unit: row.unit, stopped: false))))
        if case .refused(let why, _) = result { refusal = why }
    }
}

/// A supplement's name, its dose, and since when.
private struct SupplementRow: View {
    let row: SupplementsView.Row

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(row.name)
                Text("Since \(DayText.short(row.startedDay))").font(.caption).foregroundStyle(.secondary)
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
