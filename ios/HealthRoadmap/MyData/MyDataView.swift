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
    /// What a tap opened, with the screen it was read on: the sheet's save is checked
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
                    aboutYou(data)
                    vitals(data)
                    metrics(data.bloodTests) { SectionTitle.bloodTests() }
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
        } header: {
            header(.aboutYou()) {
                Button { addingLabs = true } label: {
                    Label("Add medical records", systemImage: "plus")
                }
                Button { showSync = true } label: {
                    Label("Sync", systemImage: SyncStatusText.symbol(sync.status, provider: sync.provider))
                }
            }
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

    /// Metric or US, compact, on the Vitals line (AC17).
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
            ForEach(rows) { metric($0) }
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
                if index == 0 { header(.vitals()) { units(data) } }
            }
            .listSectionSpacing(.compact)
        }
    }

    private func metric(_ row: MyData.Row, card: Bool = false) -> some View {
        // A unit switch still landing would open a sheet on the old choices (AC17e).
        Button { open(row) } label: {
            ValueRow(label: row.label, value: row.latest?.value, unit: row.unit, day: row.latest?.day,
                     trend: row.trend ?? [], tint: MetricChart.colors(for: row.metric)[0].softInDark,
                     card: card ? MetricChart.symbol(for: row.metric) : nil)
        }
        .tint(.primary)
        .disabled(store.unitSwitches > 0)
    }

    /// A value with any history opens its page; one with none opens entry (AC9).
    private func open(_ row: MyData.Row) {
        if MetricDetailView.opensHistory(store.history(for: row.metric)) {
            detail = row
        } else {
            entry = .metric(row, store.screen)
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
            ValueEntrySheet(title: "Height", unit: profile?.heightUnit ?? "", current: profile?.height, asksForDay: false, read: store.number) { value, _ in
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

/// One row: the label, then the value and its unit, or "Add" when there is none.
private struct ValueRow: View {
    let label: String
    let value: String?
    let unit: String
    /// YYYY-MM-DD, shown under the label.
    let day: String?
    /// A US height, shown as 5 ft 10 in in place of the value (AC17).
    var feetInches: MyData.FeetInches?
    /// The recent days, drawn small beside the value (AC17d).
    var trend: [Double] = []
    var tint: Color = .blue
    /// Drawn as an Apple Health card under this symbol: name and day on top, the value
    /// large below with a larger trend beside it.
    var card: String?
    @Environment(\.dynamicTypeSize) private var textSize
    /// Counts the value's own changes: a new value in the same unit, not a units switch (review R3).
    @State private var bounces = 0
    @State private var shownUnit: String?

    var body: some View {
        Group {
            if let card, let value { cardBody(card, value: value) } else { rowBody }
        }
        .animation(.snappy, value: value)
        .onChange(of: value) {
            if shownUnit == nil || shownUnit == unit { bounces += 1 }
            shownUnit = unit
        }
        .onAppear { shownUnit = unit }
        .contentShape(Rectangle())
    }

    private func cardBody(_ symbol: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Label(label, systemImage: symbol)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(tint)
                Spacer()
                if let day {
                    Text(DayText.short(day)).font(.footnote).foregroundStyle(.secondary)
                }
                Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(.tertiary)
            }
            HStack(alignment: .bottom) {
                HStack(alignment: .firstTextBaseline, spacing: 4) {
                    Text(value)
                        .font(.system(.title, design: .rounded).weight(.semibold))
                        .monospacedDigit()
                        .contentTransition(.numericText())
                        .modifier(Bounce(trigger: bounces, anchor: .leading))
                    Text(unit).font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                }
                Spacer(minLength: 12)
                if !textSize.isAccessibilitySize {
                    Sparkline(points: trend, tint: tint, size: CGSize(width: 110, height: 40))
                }
            }
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }

    private var rowBody: some View {
        LabelValue.layout(textSize).callAsFunction {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                if let day {
                    Text(DayText.short(day)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            HStack(alignment: .firstTextBaseline) {
                Sparkline(points: trend, tint: tint)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] - 2 }
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
    }

    @ViewBuilder
    private func number(_ value: String, unit: String) -> some View {
        Text(value)
            .font(.body.weight(.semibold))
            .monospacedDigit()
            .contentTransition(.numericText())
            .modifier(Bounce(trigger: bounces, anchor: .trailing))
        Text(unit).font(.subheadline).foregroundStyle(.secondary)
    }
}

/// A small spring when a new value arrives, saved here or synced in (AC17d); not on a
/// units switch. Still under Reduce Motion.
private struct Bounce: ViewModifier {
    let trigger: Int
    let anchor: UnitPoint
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content.keyframeAnimator(initialValue: 1.0, trigger: trigger) { content, scale in
            content.scaleEffect(reduceMotion ? 1 : scale, anchor: anchor)
        } keyframes: { _ in
            SpringKeyframe(1.15, duration: 0.15, spring: .snappy)
            SpringKeyframe(1.0, spring: .bouncy)
        }
    }
}

/// A row's label and value: side by side, stacked at accessibility text sizes so
/// neither is squeezed into a broken word. Used by My data and the metric page.
enum LabelValue {
    /// Side by side, the value centred on the row (Brad 2026-10-23): on the label's first
    /// line, a value whose label has a day or a note under it sat high.
    static func layout(_ size: DynamicTypeSize) -> AnyLayout {
        size.isAccessibilitySize ? AnyLayout(VStackLayout(alignment: .leading, spacing: 4)) : AnyLayout(HStackLayout(alignment: .center))
    }
}
