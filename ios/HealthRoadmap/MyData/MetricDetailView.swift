import SwiftUI

/// One metric's page, pushed from My data (US-25 AC9, AC17), laid out as Apple
/// Health's (Brad 2026-10-23: "just copy what Apple Health have done"): "+" at
/// the top, the range picker, the latest value large with its day, a chart that
/// opens on the newest value and scrolls back, then Show All Data and Unit, then
/// "About" the metric and its sources (US-58). A metric with no readings says "No data yet",
/// offers "Add your first value", then shows its guide (AC4b).
/// Tapping an active value in Show All Data corrects it: a new row, the old one
/// kept and struck through as entered in error. There is no delete: the record
/// is append-only (Brad 2026-09-24). The web twin is
/// widget-src/src/components/HistoryPanel.tsx, with the correction the web's
/// matrices offer on a saved cell.
struct MetricDetailView: View {
    let store: RecordStore
    let row: MyData.Row
    /// Counts a save, for the success haptic.
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    /// The range picked; nil opens on the narrowest holding every value (`ChartRange.opening`).
    @State private var range: ChartRange?
    @State private var scrubbed: Date?
    /// The first day a scrolling range shows; set to end on the newest value as a range opens.
    @State private var scrolledTo = Date.distantPast
    @State private var editing: Editing?
    /// The page's own read for this revision has come back (empty or failed included).
    @State private var readRevision: Int?
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

    /// What Add Data and the "+" open: the entry sheet for the metric as My data shows it now.
    static func adding(_ row: MyData.Row, in store: RecordStore) -> Editing {
        .add(live(row, in: store) ?? row, store.screen)
    }

    var body: some View {
        List {
            if let chart = store.shownChart(for: row.metric), !chart.history.rows.isEmpty {
                chartSection(chart)
                Section {
                    NavigationLink("Show All Data") {
                        AllDataView(store: store, row: row, saved: saved)
                    }
                    unitRow(chart.history)
                }
            } else if Self.saysEmpty(hasReadings: (Self.live(row, in: store) ?? row).latest != nil, read: readRevision == store.revision) {
                // No readings, or a read that came back empty or failed (adversary R2; US-58 AC4b):
                // adding one comes first, then the guide, so the page is never blank.
                Section {
                    Text("No data yet").foregroundStyle(.secondary)
                    Button { editing = Self.adding(row, in: store) } label: {
                        Label("Add your first value", systemImage: "plus.circle.fill")
                    }
                    .disabled(store.unitSwitches > 0)
                }
            }
            // Apple Health's About section, then its sources (US-58 AC4).
            if let guide = store.myData?.guides?[row.metric] {
                GuideSections(guide: guide)
            }
        }
        // A chart kept for this revision draws at once; the engine reads the rest off the
        // main thread, again whenever the record or its units move.
        .task(id: store.revision) {
            let revision = store.revision
            _ = await store.chart(for: row.metric)
            if !Task.isCancelled { readRevision = revision }
        }
        .metricPageList(title: row.label)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { editing = Self.adding(row, in: store) } label: {
                    Label("Add Data", systemImage: "plus")
                }
                .tint(.accentColor) // the brand on the page's one control (Brad 2026-10-30)
                .disabled(store.unitSwitches > 0)
            }
        }
        .editingSheet($editing, store: store, saved: saved)
        .refusalAlert($lpaRefusal)
    }

    /// "No data yet" shows when My data has no reading for the metric, or once the page's read
    /// came back with none; a metric with readings shows only its guide while the read runs,
    /// so "No data yet" never flashes before its chart.
    nonisolated static func saysEmpty(hasReadings: Bool, read: Bool) -> Bool {
        !hasReadings || read
    }

    /// This metric's row in My data now, so a units switch shows at once.
    static func live(_ row: MyData.Row, in store: RecordStore) -> MyData.Row? {
        guard let data = store.myData else { return nil }
        return data.vitals.first { $0.metric == row.metric } ?? data.bloodTests.first { $0.metric == row.metric }
            ?? (data.psa.metric == row.metric ? data.psa : nil)
    }

    // MARK: Chart

    private func chartSection(_ chart: ChartData) -> some View {
        let latest = chart.history.rows.first(where: \.isActive)
        return Section {
            VStack(alignment: .leading, spacing: 12) {
                if let newest = chart.last {
                    rangedChart(chart, newest: newest, latest: latest)
                } else {
                    headline(latest, unit: chart.history.unit)
                    Text("No values to draw yet.").font(.subheadline).foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 6)
        }
    }

    /// The range picker, the headline and the chart, for a history with values.
    @ViewBuilder
    private func rangedChart(_ chart: ChartData, newest: Date, latest: MetricHistory.Row?) -> some View {
        let shown = range ?? chart.opening
        // The window ends on the newest value, not today: a weight from months ago fills the chart.
        let windowStart = shown.start(ending: newest)
        let window = newest.timeIntervalSince(windowStart)
        Picker("Range", selection: Binding { shown } set: { range = $0 }) {
            ForEach(ChartRange.allCases) { Text($0.rawValue).tag($0).accessibilityLabel($0.spoken) }
        }
        .pickerStyle(.segmented)
        headline(latest, unit: chart.history.unit)
            .opacity(scrubbed == nil ? 1 : 0)
        MetricChart(chart: chart, window: window, scrolledTo: $scrolledTo, selected: $scrubbed)
            // Opens on the newest value; coming back from Show All Data keeps where it was scrolled.
            .onAppear { if scrolledTo == .distantPast { scrolledTo = windowStart } }
            .onChange(of: shown) {
                scrubbed = nil
                scrolledTo = windowStart
            }
            // A newer value just added: show it.
            .onChange(of: newest) { scrolledTo = windowStart }
        MedicationMarkerList(markers: chart.markers)
    }

    /// The newest value, large, with its day: Apple Health's headline.
    private func headline(_ latest: MetricHistory.Row?, unit: String) -> some View {
        PageHeadline(headline: Headline(title: "Latest", parts: latest.map { [.init(number: $0.value, unit: unit)] } ?? [],
                                        span: latest.map { DayText.short($0.day) } ?? ""))
            .animation(.snappy, value: latest?.value)
    }

    // MARK: Unit

    /// Apple Health's Unit row. A test with its own units (AC17e) switches between Metric and
    /// US, as the web's unit chip; Lp(a) picks one of its three (US-05 AC2), kept in the record
    /// so it syncs. Any other metric shows its unit.
    @ViewBuilder
    private func unitRow(_ history: MetricHistory) -> some View {
        if let live = Self.live(row, in: store), live.switchable == true {
            Menu {
                Picker("Units for \(row.label)", selection: Binding(get: { store.units(for: row.metric) }, set: { store.switchUnits(for: live, to: $0) })) {
                    Text("Metric").tag("si")
                    Text("US").tag("conventional")
                }
            } label: {
                // The choice in the accent, as every picker's (Brad 2026-10-30); the name plain.
                HStack {
                    Text("Unit").foregroundStyle(Color.primary)
                    Spacer()
                    Label(history.unit, systemImage: "chevron.up.chevron.down").labelStyle(TrailingIcon())
                }
            }
            .disabled(store.unitSwitches > 0)
        } else if row.metric == "lpa", let unit = store.myData?.lpaUnit {
            Picker("Unit", selection: Binding(get: { unit }, set: { unit in
                let choosing = store.chooseLpaUnit(unit) // holds entry now, in the tap
                Task { lpaRefusal = await choosing.value }
            })) {
                ForEach(RecordStore.lpaUnits, id: \.self) { Text($0).tag($0) }
            }
            .disabled(store.unitSwitches > 0)
        } else {
            LabeledContent("Unit", value: history.unit)
        }
    }
}

/// The unit, then its menu's chevrons, in the menu's accent (Brad 2026-10-30).
private struct TrailingIcon: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 4) {
            configuration.title
            configuration.icon.font(.caption.weight(.semibold))
        }
    }
}

/// Apple Health's Show All Data: every value, newest first. Tapping an active one opens its correction.
private struct AllDataView: View {
    let store: RecordStore
    let row: MyData.Row
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult
    @State private var editing: MetricDetailView.Editing?

    var body: some View {
        // The rows last read; a tap waits until they are read for the record as it is now
        // (adversary R2), so a correction never opens on an older unit's value.
        let current = store.shownHistory(for: row.metric) != nil
        List {
            if let history = store.shownChart(for: row.metric)?.history {
                Section {
                    ForEach(history.rows) { value in
                        if value.isActive {
                            Button { editing = .correct(value, MetricDetailView.live(row, in: store) ?? row, store.screen) } label: {
                                HistoryRow(row: value, unit: history.unit, excluded: history.excluded)
                            }
                            .tint(.primary)
                            .disabled(store.unitSwitches > 0 || !current)
                            .accessibilityHint("Opens a correction")
                        } else {
                            HistoryRow(row: value, unit: history.unit, excluded: history.excluded)
                        }
                    }
                } footer: {
                    Text("Tap a value to correct it. The old value stays in your record, struck through and marked as entered in error.")
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("All Recorded Data")
        .navigationBarTitleDisplayMode(.inline)
        // Joins the page beneath's read of the same revision: one engine call.
        .task(id: store.revision) { _ = await store.chart(for: row.metric) }
        .editingSheet($editing, store: store, saved: saved)
    }
}

private extension View {
    /// Presents a new value's or a correction's sheet; a correction reopens on its new screen
    /// when Lp(a)'s unit changes in it.
    func editingSheet(_ editing: Binding<MetricDetailView.Editing?>, store: RecordStore,
                      saved: @escaping (RecordStore.ApplyResult) -> RecordStore.ApplyResult) -> some View {
        sheet(item: editing) { item in
            EditingSheet(store: store, editing: item, saved: saved) { editing.wrappedValue = $0 }
        }
    }
}

/// The sheet a tap opened: a new value, or a correction of one.
private struct EditingSheet: View {
    let store: RecordStore
    let editing: MetricDetailView.Editing
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult
    /// Reopens the correction on a new screen when Lp(a)'s unit changes in it.
    let reopen: (MetricDetailView.Editing) -> Void

    var body: some View {
        content.presentationDetents([.medium, .large])
    }

    // The row as it was tapped: its unit is the one a typed value is read in (AC17e).
    @ViewBuilder
    private var content: some View {
        switch editing {
        case .add(let shown, let seen):
            MetricEntrySheet(store: store, row: shown, seen: seen, saved: saved)
        case .correct(let value, let shown, let seen) where shown.metric == MyData.bloodPressure:
            BloodPressureSheet(store: store, correcting: value, seen: seen, saved: saved)
        case .correct(let value, let shown, let seen):
            // The value and unit as the sheet's screen shows them: Lp(a)'s unit can change in
            // the sheet, and the hint waits for a history read in it (the page beneath reads
            // the history again when it does; adversary R2).
            let unit = store.lpaUnit(for: shown) == nil ? shown.unit : seen.lpaUnit
            let now = store.correctionHint(for: value.id, metric: shown.metric, unit: unit, on: seen)
            ValueEntrySheet(title: "Correct \(DayText.short(value.day))", unit: unit, current: now, asksForDay: false) { number, _ in
                saved(await store.apply(.correct(id: value.id, value: number), as: seen))
            }
            .lpaUnits(store, shown) { reopen(.correct(value, shown, seen.showing(lpaUnit: $0))) }
            .reads(in: store.inputRange(for: shown.metric, in: store.lpaUnit(for: shown) == nil ? nil : unit))
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
