import SwiftUI

/// One metric's page, pushed from My data (US-25 AC9, AC17), laid out as Apple
/// Health's: the range picker, the latest value large with its day, the chart,
/// then every value newest first. Tapping an active value corrects it: a new
/// row, the old one kept and struck through as entered in error. There is no
/// delete: the record is append-only (Brad 2026-09-24). The web twin is
/// widget-src/src/components/HistoryPanel.tsx, with the correction the web's
/// matrices offer on a saved cell.
struct MetricDetailView: View {
    let store: RecordStore
    let row: MyData.Row
    /// Counts a save, for the success haptic.
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    @State private var range = ChartRange.all
    @State private var scrubbed: Date?
    /// Which sheet is open: a new value, or a correction of a row.
    @State private var editing: Editing?
    /// Why the Lp(a) unit menu's choice was not saved.
    @State private var lpaRefusal: String?

    /// What a tap opened: the row as this page showed it and the screen it was read
    /// on, so the sheet's unit label and its save agree (Codex R2).
    enum Editing: Identifiable {
        case add(MyData.Row, RecordStore.Screen)
        case correct(MetricHistory.Row, MyData.Row, RecordStore.Screen)
        /// A correction's id is its value's alone, never its screen: choosing Lp(a)'s unit in the
        /// open sheet rewrites the item's screen, and a new id would re-present the sheet and
        /// drop what was typed (merge review R3; `testACorrectionKeepsItsSheetWhenItsScreenMoves`).
        var id: String {
            switch self {
            case .add: "add"
            case .correct(let value, _, _): value.id
            }
        }
    }

    /// The page once the record holds any row for the metric, active or not (Codex R3); else entry opens directly.
    static func opensHistory(_ history: MetricHistory?) -> Bool {
        !(history?.rows.isEmpty ?? true)
    }

    var body: some View {
        let history = store.history(for: row.metric)
        List {
            if let history {
                chartSection(history)
                valuesSection(history)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(row.label)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            // This test's own units (AC17e), as the web's unit chip: My data's row as it is now.
            if let live, live.switchable == true {
                ToolbarItem(placement: .secondaryAction) {
                    Picker("Units for \(row.label)", selection: Binding(
                        get: { store.units(for: row.metric) },
                        set: { store.switchUnits(for: live, to: $0) }
                    )) {
                        Text("Metric").tag("si")
                        Text("US").tag("conventional")
                    }
                    .pickerStyle(.menu)
                    .disabled(store.unitSwitches > 0)
                }
            }
            // Lp(a)'s three units, the web's control (US-05 AC2): kept in the record, so it syncs.
            if row.metric == "lpa", let unit = store.myData?.lpaUnit {
                ToolbarItem(placement: .secondaryAction) {
                    Picker("Units for \(row.label)", selection: Binding(
                        get: { unit },
                        set: { unit in
                            let choosing = store.chooseLpaUnit(unit) // holds entry now, in the tap
                            Task { lpaRefusal = await choosing.value }
                        }
                    )) {
                        ForEach(RecordStore.lpaUnits, id: \.self) { Text($0).tag($0) }
                    }
                    .pickerStyle(.menu)
                    .disabled(store.unitSwitches > 0)
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Button("Add Data") { editing = .add(live ?? row, store.screen) }
                    .disabled(store.unitSwitches > 0)
            }
        }
        .sheet(item: $editing) { editing in
            sheet(for: editing).presentationDetents([.medium, .large])
        }
        .alert("Not saved", isPresented: Binding(get: { lpaRefusal != nil }, set: { if !$0 { lpaRefusal = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(lpaRefusal ?? "")
        }
    }

    /// This metric's row in My data now, so a units switch here shows at once.
    private var live: MyData.Row? {
        guard let data = store.myData else { return nil }
        return (data.vitals + data.bloodTests + [data.psa]).first { $0.metric == row.metric }
    }

    // MARK: Chart

    private func chartSection(_ history: MetricHistory) -> some View {
        let all = ChartPoint.points(history)
        let today = DayText.date(DayText.iso(.now)) ?? .now
        let offered = ChartRange.offered(for: all.map(\.date), today: today)
        let shown = offered.contains(range) ? range : .all
        let start = shown.start(today: today)
        let points = start.map { start in all.filter { $0.date >= start } } ?? all
        let latest = history.rows.first(where: \.isActive)
        return Section {
            VStack(alignment: .leading, spacing: 12) {
                if offered.count > 1 {
                    Picker("Range", selection: $range) {
                        ForEach(offered) { Text($0.rawValue).tag($0).accessibilityLabel($0.spoken) }
                    }
                    .pickerStyle(.segmented)
                }
                headline(latest, unit: history.unit)
                    .opacity(scrubbed == nil ? 1 : 0)
                if points.isEmpty {
                    Text("No values to draw yet.").font(.subheadline).foregroundStyle(.secondary)
                } else {
                    MetricChart(history: history, points: points, domain: start.map { $0...today }, selected: $scrubbed)
                }
            }
            .padding(.vertical, 6)
        }
        .onChange(of: range) { scrubbed = nil }
    }

    /// The newest value, large, with its day: Apple Health's headline.
    private func headline(_ latest: MetricHistory.Row?, unit: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Latest").font(.subheadline.weight(.semibold)).foregroundStyle(.secondary)
            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text(latest?.value ?? "None")
                    .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                if latest != nil { Text(unit).font(.title3).foregroundStyle(.secondary) }
            }
            if let latest {
                Text(DayText.short(latest.day)).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
        .animation(.snappy, value: latest?.value)
    }

    // MARK: Values

    private func valuesSection(_ history: MetricHistory) -> some View {
        Section {
            ForEach(history.rows) { value in
                if value.isActive {
                    Button { editing = .correct(value, live ?? row, store.screen) } label: { HistoryRow(row: value, unit: history.unit, excluded: history.excluded) }
                        .tint(.primary)
                        .disabled(store.unitSwitches > 0)
                        .accessibilityHint("Opens a correction")
                } else {
                    HistoryRow(row: value, unit: history.unit, excluded: history.excluded)
                }
            }
        } header: {
            Text("All values")
        } footer: {
            Text("Tap a value to correct it. The old value stays in your record, struck through and marked as entered in error.")
        }
    }

    @ViewBuilder
    private func sheet(for editing: Editing) -> some View {
        // The row as it was tapped: its unit is the one a typed value is read in (AC17e).
        switch editing {
        case .add(let shown, let seen):
            MetricEntrySheet(store: store, row: shown, seen: seen, saved: saved)
        case .correct(let value, let shown, let seen) where shown.metric == MyData.bloodPressure:
            BloodPressureSheet(store: store, correcting: value, seen: seen, saved: saved)
        case .correct(let value, let shown, let seen):
            // Lp(a)'s value as it is now: its unit can change in the sheet.
            let now = store.lpaUnit(for: shown) == nil ? value.value : store.history(for: shown.metric)?.rows.first { $0.id == value.id }?.value ?? value.value
            ValueEntrySheet(title: "Correct \(DayText.short(value.day))", unit: store.lpaUnit(for: shown) ?? shown.unit, current: now, asksForDay: false, read: store.number) { number, _ in
                saved(await store.apply(.correct(id: value.id, value: number), as: seen))
            }
            .lpaUnits(store, shown) { self.editing = .correct(value, shown, seen.showing(lpaUnit: $0)) }
        }
    }
}

/// A value and its day; an entered-in-error value is struck through and says so.
private struct HistoryRow: View {
    let row: MetricHistory.Row
    let unit: String
    /// The plan set the current value aside.
    let excluded: Bool
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        LabelValue.layout(textSize).callAsFunction {
            VStack(alignment: .leading, spacing: 2) {
                Text(DayText.short(row.day))
                if !row.isActive {
                    Text("Entered in error").font(.caption).foregroundStyle(.secondary)
                } else if row.current && excluded {
                    Text("Not used: outside the range your plan accepts").font(.caption).foregroundStyle(.orange)
                } else if row.current {
                    Text("Used in your plan").font(.caption).foregroundStyle(.tint)
                } else if row.correction {
                    Text("Corrected").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            HStack(alignment: .firstTextBaseline) {
                Text(row.value)
                    .font(.body.weight(row.isActive ? .semibold : .regular))
                    .monospacedDigit()
                    .strikethrough(!row.isActive)
                    .foregroundStyle(row.isActive ? .primary : .secondary)
                Text(unit).font(.subheadline).foregroundStyle(.secondary)
            }
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.isActive ? "\(row.value) \(unit), \(DayText.short(row.day))" : "Entered in error: \(row.value) \(unit), \(DayText.short(row.day))")
    }
}
