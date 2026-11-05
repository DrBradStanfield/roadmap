import SwiftUI

/// "Add blood test" at the end of My health's Blood tests (US-73 AC8). As people type, the
/// engine's name search (`HealthEngine.labSearch`) finds core and catalogue tests by name and
/// alias, and the record's own tests show too. A test the record holds opens its usual entry;
/// a catalogue test it does not hold, or a name nothing knows ("Add '…' as a new test"),
/// opens `NamedTestEntry`. An engine without the search lists only the record's tests.
struct AddBloodTestSheet: View {
    /// What a pick opens, once this sheet has gone.
    enum Pick {
        /// A test the record lists: its own entry sheet.
        case row(MyData.Row)
        /// A test by name, in one of `units` (a catalogue test's, its stored unit first), or in
        /// a typed unit when `units` is empty (a new test).
        case named(String, units: [String])
    }

    let engine: HealthEngine
    let data: MyData
    let pick: (Pick) -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    /// The engine's matches for the text typed.
    @State private var found: [LabSearchMatch] = []
    /// False once the engine says it has no search (an engine before it).
    @State private var searches = true

    var body: some View {
        NavigationStack {
            List {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    Button {
                        pick(item.pick)
                        dismiss()
                    } label: {
                        HStack {
                            Text(item.name)
                            Spacer()
                            Text(item.unit).foregroundStyle(.secondary)
                        }
                    }
                    .tint(.primary)
                }
                if items.isEmpty, !typed.isEmpty {
                    if searches {
                        Button {
                            pick(.named(typed, units: []))
                            dismiss()
                        } label: {
                            Label("Add \u{201C}\(typed)\u{201D} as a new test", systemImage: "plus.circle.fill")
                        }
                    } else {
                        Text("\u{201C}\(typed)\u{201D} is not on the list. A test the app does not know cannot be added on iPhone yet.")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .searchable(text: $search, placement: .navigationBarDrawer(displayMode: .always), prompt: "Type a blood test name")
            .task(id: typed) { await find() }
            .navigationTitle("Add blood test")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private var typed: String { search.trimmingCharacters(in: .whitespaces) }

    private func find() async {
        let text = typed
        guard searches, !text.isEmpty else { return found = [] }
        // nil: the engine has no search; a failed search finds nothing.
        let matches: [LabSearchMatch]?
        do { matches = try await engine.labSearch(text) } catch { matches = [] }
        // A search for earlier text that lands late never replaces the newer one's ("tes" over "test").
        guard !Task.isCancelled, text == typed else { return }
        if let matches { found = matches } else { searches = false }
    }

    private struct Item {
        let name: String
        let unit: String
        let pick: Pick
    }

    /// The record's tests: the core ones, PSA, then its lab tests.
    private var held: [MyData.Row] { data.bloodTests + [data.psa] + (data.labTests ?? []) }

    private var items: [Item] {
        let row = { (row: MyData.Row) in Item(name: row.label, unit: row.unit, pick: .row(row)) }
        guard !typed.isEmpty else { return held.map(row) }
        let named = held.filter { $0.label.localizedCaseInsensitiveContains(typed) }
        guard searches else { return named.map(row) }
        // A match the record holds opens its row: a core test's by its key, a catalogue test's by its series key.
        let matched = found.map { match in
            held.first { $0.metric == match.key && ($0.series == nil) == (match.kind == "core") }.map(row)
                ?? Item(name: match.name, unit: match.units.first ?? "", pick: .named(match.name, units: match.units))
        }
        let shown = Set(matched.map(\.name))
        return matched + named.filter { !shown.contains($0.label) }.map(row)
    }
}

/// A value for a test by name (US-73 AC8): a catalogue test in one of its units, or a new test
/// in the unit typed, on a day. The engine refuses a unit the catalogue does not take or a
/// value out of range in its own words; a day that holds a value offers its correction.
struct NamedTestEntry: View {
    let store: RecordStore
    let name: String
    let units: [String]
    let seen: RecordStore.Screen
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult
    @State private var unit: String

    init(store: RecordStore, name: String, units: [String], seen: RecordStore.Screen, saved: @escaping (RecordStore.ApplyResult) -> RecordStore.ApplyResult) {
        (self.store, self.name, self.units, self.seen, self.saved) = (store, name, units, seen, saved)
        _unit = State(initialValue: units.first ?? "")
    }

    var body: some View { sheet }

    private var sheet: ValueEntrySheet {
        var sheet = ValueEntrySheet(title: name, unit: unit, current: nil, asksForDay: true) { value, day in
            saved(await store.apply(.labAddName(name: name, value: value, day: day, unit: unit.trimmingCharacters(in: .whitespaces)), as: seen))
        } replace: { existingId, value in
            saved(await store.apply(.labCorrect(id: existingId, value: value), as: seen))
        }
        if units.isEmpty {
            sheet.typedUnit = $unit
        } else if units.count > 1 {
            sheet.units = units
            sheet.chooseUnit = { chosen in
                unit = chosen
                return nil
            }
        }
        return sheet
    }
}
