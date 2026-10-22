import SwiftUI

/// The My data tab (US-25 AC5, AC17): about you, vitals and blood tests, each
/// row with its current value. Every change goes through `RecordStore.apply`,
/// so the engine's rules decide what is saved. The web twins are
/// StartingInfoVitals.tsx and BloodTestTimeline.tsx.
///
/// No title bar (Brad 2026-10-22): lab upload and Sync sit on the About you
/// line, the unit switch on the Vitals line. A value with history opens its
/// page in the tab's navigation stack (MetricDetailView).
struct MyDataView: View {
    /// Which value the entry sheet is for.
    private enum Entry: Identifiable {
        case height
        case metric(MyData.Row)

        var id: String {
            switch self {
            case .height: "height"
            case .metric(let row): row.metric
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
    @State private var refusal: String?
    @State private var saves = 0

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
    }

    private var content: some View {
        Group {
            if let data = store.myData {
                List {
                    aboutYou(data)
                    metrics(data.vitals) { header("Vitals") { units(data) } }
                    metrics(data.bloodTests) { Text("Blood tests") }
                    MedicationsSection(store: store, data: data, saved: saved)
                    ScreeningsSection(store: store, data: data, saved: saved, open: open)
                    SupplementsSection(store: store, supplements: data.supplements, saved: saved)
                    RemindersSection()
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
                .onAppear { store.confirmEngineTrial() }
            } else {
                ContentUnavailableView("Your record could not be opened", systemImage: "exclamationmark.triangle", description: Text(store.problem ?? ""))
            }
        }
        .sheet(item: $entry) { entry in
            sheet(for: entry)
                .presentationDetents([.medium, .large])
        }
        .alert("Not saved", isPresented: Binding(get: { refusal != nil }, set: { if !$0 { refusal = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(refusal ?? "")
        }
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

            Picker("Birth year", selection: binding(data.profile.birthYear ?? 0) { .profile(birthYear: $0) }) {
                if data.profile.birthYear == nil { Text("Not set").tag(0) }
                ForEach(DayText.birthYears(now: .now), id: \.self) { Text(String($0)).tag($0) }
            }

            Picker("Birth month", selection: binding(data.profile.birthMonth ?? 0) { .profile(birthMonth: $0) }) {
                if data.profile.birthMonth == nil { Text("Not set").tag(0) }
                ForEach(1...12, id: \.self) { Text(DayText.monthName($0)).tag($0) }
            }

            Button { entry = .height } label: {
                ValueRow(label: "Height", value: data.profile.height, unit: data.profile.heightUnit, day: nil, feetInches: data.profile.feetInches)
            }
            .tint(.primary)
        } header: {
            header("About you") {
                LabUploadButton(engine: engine, store: store, sync: sync)
                Button { showSync = true } label: {
                    Label("Sync", systemImage: SyncStatusText.symbol(sync.status, provider: sync.provider))
                }
            }
        }
    }

    /// A section title with controls at its trailing end, large enough to hit easily.
    private func header(_ title: String, @ViewBuilder trailing: () -> some View) -> some View {
        HStack(spacing: 14) {
            Text(title)
            Spacer()
            trailing()
                .labelStyle(.iconOnly)
                .font(.title3)
                .textCase(nil)
        }
    }

    /// Metric or US, compact, on the Vitals line (AC17).
    private func units(_ data: MyData) -> some View {
        Picker("Units", selection: binding(data.unitSystem) { .units($0) }) {
            Text("Metric").tag("si")
            Text("US").tag("conventional")
        }
        .pickerStyle(.segmented)
        .fixedSize()
    }

    private func metrics(_ rows: [MyData.Row], @ViewBuilder header: () -> some View) -> some View {
        Section {
            ForEach(rows) { row in
                Button { open(row) } label: {
                    ValueRow(label: row.label, value: row.latest?.value, unit: row.unit, day: row.latest?.day)
                }
                .tint(.primary)
            }
        } header: {
            header()
        }
    }

    /// A value with any history opens its page; one with none opens entry (AC9).
    private func open(_ row: MyData.Row) {
        if MetricDetailView.opensHistory(store.history(for: row.metric)) {
            detail = row
        } else {
            entry = .metric(row)
        }
    }

    // MARK: Entry

    @ViewBuilder
    private func sheet(for entry: Entry) -> some View {
        switch entry {
        case .height where store.myData?.unitSystem == "conventional":
            FeetInchesSheet(current: store.myData?.profile.feetInches) { height in
                saved(store.apply(.feetInches(feet: height.feet, inches: height.inches)))
            }
        case .height:
            let profile = store.myData?.profile
            ValueEntrySheet(title: "Height", unit: profile?.heightUnit ?? "", current: profile?.height, asksForDay: false, read: store.number) { value, _ in
                saved(store.apply(.profile(height: value)))
            }
        case .metric(let row):
            MetricEntrySheet(store: store, row: row, saved: saved)
        }
    }

    /// A picker's binding: it shows the record's value and saves a change through the engine.
    private func binding<Value: Equatable>(_ shown: Value, _ edit: @escaping (Value) -> RecordEdit) -> Binding<Value> {
        Binding(get: { shown }, set: { picked in
            guard picked != shown else { return }
            if case .refused(let message, _) = saved(store.apply(edit(picked))) { refusal = message }
        })
    }

    @discardableResult
    private func saved(_ result: RecordStore.ApplyResult) -> RecordStore.ApplyResult {
        if result == .saved { saves += 1 }
        return result
    }
}

/// One row: the label, then the value and its unit, or "Add" when there is none.
private struct ValueRow: View {
    let label: String
    let value: String?
    let unit: String
    /// YYYY-MM-DD, shown under the label.
    let day: String?
    /// A US height, shown as 5 ft 10 in in place of the value (AC17).
    var feetInches: MyData.FeetInches?
    @Environment(\.dynamicTypeSize) private var textSize

    var body: some View {
        LabelValue.layout(textSize).callAsFunction {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                if let day {
                    Text(DayText.short(day)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            HStack(alignment: .firstTextBaseline) {
                if let feetInches {
                    number(String(feetInches.feet), unit: "ft")
                    number(String(feetInches.inches), unit: "in")
                } else if let value {
                    number(value, unit: unit)
                } else {
                    Text("Add").foregroundStyle(Color.accentColor)
                }
            }
        }
        .animation(.snappy, value: value)
        .contentShape(Rectangle())
    }

    @ViewBuilder
    private func number(_ value: String, unit: String) -> some View {
        Text(value)
            .font(.body.weight(.semibold))
            .monospacedDigit()
            .contentTransition(.numericText())
        Text(unit).font(.subheadline).foregroundStyle(.secondary)
    }
}

/// A row's label and value: side by side, stacked at accessibility text sizes so
/// neither is squeezed into a broken word. Used by My data and the metric page.
enum LabelValue {
    static func layout(_ size: DynamicTypeSize) -> AnyLayout {
        size.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(alignment: .firstTextBaseline))
    }
}
