import SwiftUI

/// The My data tab (US-25 AC5, AC17): vitals, blood tests and about you, each
/// row with its current value. Every change goes through `RecordStore.apply`,
/// so the engine's rules decide what is saved. The web twins are
/// StartingInfoVitals.tsx and BloodTestTimeline.tsx.
///
/// No title bar (Brad 2026-10-22): lab upload and Sync sit on the Vitals line;
/// the unit switch is a row in About you, near the end, since it is set once
/// (Brad 2026-10-23). A value with history opens its
/// page in the tab's navigation stack (MetricDetailView).
struct MyDataView: View {
    /// Which value the entry sheet is for, with the screen it was read on: the sheet's save is checked
    /// against that, whatever lands before it appears (Codex R2).
    private enum Entry: Identifiable {
        case height(RecordStore.Screen)
        case metric(MyData.Row, RecordStore.Screen)

        var id: String {
            switch self {
            case .height: "height"
            case .metric(let row, _): row.metric
            }
        }
    }

    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync
    @State private var entry: Entry?
    /// The metric whose page is pushed.
    @State private var detail: MyData.Row?
    @State private var showSync = false
    @State private var addingLabs = false
    @State private var refusal: String?
    @State private var saves = 0
    /// A picker's edit is landing: the pickers wait, so a quick change back is never lost.
    @State private var picking = false

    var body: some View {
        // The tab's NavigationStack is RootView's; this screen hides its bar.
        content
            .toolbar(.hidden, for: .navigationBar)
            // With no bar, iOS 26's edge effect leaves rows legible under the clock.
            // A zero-height inset whose background reaches into the status bar hides them.
            .safeAreaInset(edge: .top, spacing: 0) {
                Color.clear.frame(height: 0).background(Color(uiColor: .systemGroupedBackground), ignoresSafeAreaEdges: .top)
            }
            .navigationDestination(item: $detail) { row in
                MetricDetailView(store: store, row: row, saved: saved)
            }
            .sheet(isPresented: $showSync) { SyncView(sync: sync) }
            // Here, not on the header's "+": a sheet declared in a section header took
            // its grey text, large font and icon-only labels (seen 2026-10-22).
            .sheet(isPresented: $addingLabs) { LabUploadSheet(engine: engine, store: store, sync: sync) }
    }

    private var content: some View {
        Group {
            if let data = store.myData {
                List {
                    vitals(data)
                    metrics(data.bloodTests) { SectionTitle.bloodTests() }
                    MedicationsSection(store: store, data: data, saved: saved)
                    ScreeningsSection(store: store, data: data, saved: saved, open: open)
                    SupplementsSection(store: store, supplements: data.supplements, saved: saved)
                    RemindersSection()
                    aboutYou(data)
                    AppleHealthSection()
                    RecordSection(store: store, sync: sync)
                    Section {
                    } footer: {
                        Label(SyncStatusText.myDataFooter(provider: sync.provider, earlier: sync.syncedBefore), systemImage: "lock.shield")
                            .frame(maxWidth: .infinity)
                    }
                }
                .listStyle(.insetGrouped)
                // A downloaded engine on trial has drawn the user's own record (US-25 AC18).
                .task { await store.confirmEngineTrial() }
            } else {
                ContentUnavailableView("Your record could not be opened", systemImage: "exclamationmark.triangle", description: Text(store.problem ?? ""))
            }
        }
        .sheet(item: $entry) { entry in
            sheet(for: entry)
                .presentationDetents([.medium, .large])
        }
        .refusalAlert($refusal)
        .sensoryFeedback(.success, trigger: saves)
    }

    // MARK: Sections

    private func aboutYou(_ data: MyData) -> some View {
        Section {
            Picker("Sex", selection: binding(data.profile.sex ?? "") { .profile(sex: $0) }) {
                Text("Female").tag("female")
                Text("Male").tag("male")
            }
            .pickerStyle(.segmented)
            .disabled(picking)

            Picker("Birth year", selection: binding(data.profile.birthYear ?? 0) { .profile(birthYear: $0) }) {
                if data.profile.birthYear == nil { Text("Not set").tag(0) }
                ForEach(DayText.birthYears(now: .now), id: \.self) { Text(String($0)).tag($0) }
            }
            .disabled(picking)

            Picker("Birth month", selection: binding(data.profile.birthMonth ?? 0) { .profile(birthMonth: $0) }) {
                if data.profile.birthMonth == nil { Text("Not set").tag(0) }
                ForEach(1...12, id: \.self) { Text(DayText.monthName($0)).tag($0) }
            }
            .disabled(picking)

            Button { entry = .height(store.screen) } label: {
                ValueRow(label: "Height", value: data.profile.height, unit: data.profile.heightUnit, day: nil, feetInches: data.profile.feetInches)
            }
            .tint(.primary)
            .disabled(store.unitSwitches > 0)

            LabeledContent("Units") { units(data) }
        } header: {
            SectionTitle.aboutYou()
        }
    }

    /// A section title with controls at its trailing end, large enough to hit easily.
    private func header(_ title: SectionTitle, @ViewBuilder trailing: () -> some View) -> some View {
        HStack(spacing: 14) {
            title
            Spacer()
            trailing()
                .labelStyle(.iconOnly)
                .font(.title3)
                .textCase(nil)
        }
    }

    /// Metric or US, compact, a row in About you (AC17).
    private func units(_ data: MyData) -> some View {
        Picker("Units", selection: binding(data.unitSystem) { .units($0) }) {
            Text("Metric").tag("si")
            Text("US").tag("conventional")
        }
        .pickerStyle(.segmented)
        .disabled(picking)
        .fixedSize()
    }

    private func metrics(_ rows: [MyData.Row], @ViewBuilder header: () -> some View) -> some View {
        Section {
            let column = ValueRow.Column(rows.map { ($0.latest?.value, $0.unit, nil) })
            ForEach(rows) { metric($0, column: column) }
        } header: {
            header()
        }
    }

    /// Vitals as Apple Health's cards (Brad 2026-10-23): each its own tile, a gap between;
    /// a value with a reading shows large with its trend, one with none says Add.
    @ViewBuilder
    private func vitals(_ data: MyData) -> some View {
        ForEach(Array(data.vitals.enumerated()), id: \.element.id) { index, row in
            Section {
                metric(row, card: row.latest != nil)
            } header: {
                if index == 0 {
                    header(.vitals()) {
                        Button { addingLabs = true } label: {
                            Label("Add medical records", systemImage: "plus")
                        }
                        Button { showSync = true } label: {
                            Label("Sync", systemImage: SyncStatusText.symbol(sync.status, provider: sync.provider))
                        }
                    }
                }
            }
            .listSectionSpacing(.compact)
        }
    }

    /// `column`: the section's widest reading, which sets every row's value column.
    private func metric(_ row: MyData.Row, card: Bool = false, column: ValueRow.Column? = nil) -> some View {
        // A unit switch still landing would open a sheet on the old choices (AC17e).
        Button { open(row) } label: {
            ValueRow(label: row.label, value: row.latest?.value, unit: row.unit, day: row.latest?.day,
                     trend: row.trend ?? [], tint: MetricChart.colors(for: row.metric)[0], card: card,
                     column: column)
        }
        .tint(.primary)
        .disabled(store.unitSwitches > 0)
    }

    /// A value with any history opens its page; one with none opens entry (AC9). The
    /// engine reads the history off the main thread; the screen is the tap's. Only the
    /// latest tap, with no erase since, opens anything (re-check N4).
    private func open(_ row: MyData.Row) {
        let (seen, tap) = (store.screen, store.tap())
        Task {
            let history = await store.history(for: row.metric)
            guard store.isLatest(tap) else { return }
            if MetricDetailView.opensHistory(history) {
                detail = row
            } else {
                entry = .metric(row, seen)
            }
        }
    }

    // MARK: Entry

    @ViewBuilder
    private func sheet(for entry: Entry) -> some View {
        switch entry {
        case .height(let seen) where seen.units == "conventional":
            FeetInchesSheet(current: store.myData?.profile.feetInches) { height in
                saved(await store.apply(.feetInches(feet: height.feet, inches: height.inches), as: seen))
            }
        case .height(let seen):
            let profile = store.myData?.profile
            ValueEntrySheet(title: "Height", unit: profile?.heightUnit ?? "", current: profile?.height, asksForDay: false) { value, _ in
                saved(await store.apply(.profile(height: value), as: seen))
            }
        case .metric(let row, let seen):
            MetricEntrySheet(store: store, row: row, seen: seen, saved: saved)
        }
    }

    /// A picker's binding: it shows the record's value and saves a change through the engine.
    private func binding<Value: Equatable>(_ shown: Value, _ edit: @escaping (Value) -> RecordEdit) -> Binding<Value> {
        Binding(get: { shown }, set: { picked in
            guard picked != shown else { return }
            picking = true
            Task {
                if case .refused(let message, _) = saved(await store.apply(edit(picked))) { refusal = message }
                picking = false
            }
        })
    }

    @discardableResult
    private func saved(_ result: RecordStore.ApplyResult) -> RecordStore.ApplyResult {
        if result == .saved { saves += 1 }
        return result
    }
}
