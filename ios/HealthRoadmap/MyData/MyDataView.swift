import SwiftUI

/// The My health tab (PROTOTYPE, docs/drafts/my-health-tab.md; was My data, US-25 AC5, AC17):
/// one page by topic, weight first, each topic's values then its plan cards. About you,
/// reminders, Apple Health and the record sit in a settings sheet behind the person button
/// (`Layout.settings`). Every change goes through `RecordStore.apply`, so the engine's rules
/// decide what is saved. The web twins are StartingInfoVitals.tsx and BloodTestTimeline.tsx.
///
/// No title bar (Brad 2026-10-22): the person button, lab upload and Sync sit on the title line.
/// A tap on a value opens its page in the tab's navigation stack (MetricDetailView).
struct MyDataView: View {
    /// The tab itself, or the settings sheet behind its person button.
    enum Layout { case health, settings }

    /// Which value the entry sheet is for, with the screen it was read on: the sheet's save is checked
    /// against that, whatever lands before it appears (Codex R2).
    private enum Entry: Identifiable {
        case height(RecordStore.Screen)

        var id: String { "height" }
    }

    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync
    var layout: Layout = .health
    @State private var entry: Entry?
    /// The metric whose page is pushed.
    @State private var detail: MyData.Row?
    @State private var showSync = false
    @State private var showSettings = false
    @State private var addingLabs = false
    @State private var refusal: String?
    @State private var saves = 0
    /// A picker's edit is landing: the pickers wait, so a quick change back is never lost.
    @State private var picking = false
    /// The tile whose explainer is open (waist-to-height, weight, protein).
    @State private var openedTile: StatTile?
    /// US-56: Apple Health's heart, sleep and fitness metrics, read live; the one whose page is pushed.
    @Environment(LiveHealth.self) private var live: LiveHealth?
    @State private var liveDetail: LiveMetric?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.analytics) private var analytics
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        switch layout {
        case .health: health
        case .settings: settings
        }
    }

    private var health: some View {
        // The tab's NavigationStack is RootView's; this screen hides its bar.
        ScrollViewReader { proxy in
            editing(content { healthList($0, proxy: proxy) })
        }
            .toolbar(.hidden, for: .navigationBar)
            .solidStatusBar()
            .navigationDestination(item: $detail) { row in
                MetricDetailView(store: store, row: row, saved: saved)
            }
            .navigationDestination(item: $liveDetail) { metric in
                if let live { LiveHealthPage(live: live, metric: metric, bands: metric == .vo2Max ? store.myData?.vo2Bands?.value : nil,
                                              guide: store.myData?.guides?[metric.guideKey]) }
            }
            // Read from Health each time My health shows and on return to the app; nothing is kept (US-56 AC2).
            .task { await live?.refresh() }
            .onChange(of: scenePhase) { if scenePhase == .active { live?.wake() } }
            .sheet(isPresented: $showSync) { SyncView(sync: sync) }
            // Here, not on the header's "+": a sheet declared in a section header took
            // its grey text, large font and icon-only labels (seen 2026-10-22).
            .sheet(isPresented: $addingLabs) { LabUploadSheet(engine: engine, store: store) }
            .sheet(isPresented: $showSettings) {
                NavigationStack { MyDataView(engine: engine, store: store, sync: sync, layout: .settings) }
            }
            .sheet(item: $openedTile) { tile in
                TileExplainerSheet(title: tile.label, about: tile.about, evidence: tile.evidence)
            }
            .animation(.spring(duration: 0.35, bounce: 0.2), value: store.myData?.profile.alcohol?.value)
    }

    private var settings: some View {
        editing(content(settingsList))
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
    }

    /// The record's list, or why it cannot be shown.
    @ViewBuilder
    private func content(@ViewBuilder _ list: (MyData) -> some View) -> some View {
        if let data = store.myData {
            list(data)
        } else {
            ContentUnavailableView("Your record could not be opened", systemImage: "exclamationmark.triangle", description: Text(store.problem ?? ""))
        }
    }

    private func editing(_ view: some View) -> some View {
        view
            .sheet(item: $entry) { entry in
                sheet(for: entry)
                    .presentationDetents([.medium, .large])
            }
            .refusalAlert($refusal)
            .sensoryFeedback(.success, trigger: saves)
    }

    // MARK: My health

    private func healthList(_ data: MyData, proxy: ScrollViewProxy) -> some View {
        let plan = TopicPlan(store.plan)
        let tiles = PlanTiles(store.plan)
        return List {
            top(plan, proxy: proxy)
            weight(data, plan: plan, tiles: tiles)
            heading(.sleep)
            LiveCardsSection(metrics: [.sleep], title: nil, keepsReconnect: false) { liveDetail = $0 }
            cards(plan[.sleep])
            heading(.fitness)
            LiveCardsSection(metrics: [.vo2Max, .restingHeartRate, .heartRate, .steps], bands: data.vo2Bands?.value.map { [.vo2Max: $0] } ?? [:],
                             title: nil, keepsReconnect: true) { liveDetail = $0 }
            cards(plan[.fitness])
            bloodPressure(data, plan: plan)
            bloodTests(data, plan: plan, tiles: tiles)
            // No heading of its own: the engine's sections carry their titles ("Cancer Screening"…).
            ScreeningsSection(store: store, data: data, saved: saved, open: open)
            cards(plan[.screening])
            if !plan[.skin].isEmpty {
                heading(.skin)
                cards(plan[.skin])
            }
            // No heading of its own: the section's header says Supplements.
            SupplementsSection(store: store, supplements: data.supplements, saved: saved)
            cards(plan[.supplements], footer: plan.ownershipLine)
            Section {
            } footer: {
                Text(PlanList.disclaimer)
            }
        }
        .listStyle(.insetGrouped)
    }

    /// The title with the person button, lab upload and Sync; the jump chips; the urgent banner.
    @ViewBuilder
    private func top(_ plan: TopicPlan, proxy: ScrollViewProxy) -> some View {
        Section {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(HealthTopic.allCases.filter { $0.chip != nil }) { topic in
                        Button(topic.chip ?? "") {
                            withAnimation { proxy.scrollTo(topic.anchor, anchor: .top) }
                        }
                        .buttonStyle(.bordered)
                        .buttonBorderShape(.capsule)
                        .controlSize(.small)
                        .tint(.primary)
                    }
                }
                .padding(.horizontal, 4)
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            if let urgent = plan.urgent, let first = urgent.suggestions.first {
                Button {
                    withAnimation { proxy.scrollTo(TopicPlan.anchor(urgent), anchor: .center) }
                } label: {
                    Label("Needs attention: \(first.title)", systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.white)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(Color.status("urgent"), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(PressableStyle())
                .accessibilityHint("Scrolls to the card")
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
        } header: {
            HStack(spacing: 14) {
                Text("My health")
                    .font(.largeTitle.bold())
                    // A section header greys its text; the title stays in the label colour.
                    .foregroundStyle(Color(.label))
                    .accessibilityAddTraits(.isHeader)
                Spacer()
                Group {
                    Button { showSettings = true } label: {
                        Label("Settings", systemImage: "person.crop.circle")
                    }
                    Button { addingLabs = true } label: {
                        Label("Add medical records", systemImage: "plus")
                    }
                    .accessibilityHint("Upload a lab report or clinic letter")
                    Button { showSync = true } label: {
                        Label("Sync", systemImage: SyncStatusText.symbol(sync.status, provider: sync.provider))
                    }
                }
                .labelStyle(.iconOnly)
                .font(.title3)
            }
            .textCase(nil)
        }
    }

    /// A topic's heading, a row so the chips can scroll to it.
    private func heading(_ topic: HealthTopic) -> some View {
        Section {
            topic.title
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color(.label))
                .accessibilityAddTraits(.isHeader)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 20, leading: 4, bottom: 0, trailing: 4))
                .id(topic.anchor)
        }
        .listSectionSpacing(.compact)
    }

    /// A topic's plan cards, each in the plan's own card style.
    @ViewBuilder
    private func cards(_ cards: [PlanCard], footer: String? = nil) -> some View {
        if !cards.isEmpty {
            Section {
                ForEach(cards, id: \.anchor) { card in
                    PlanCardView(card: card, askAboutAlcohol: card.suggestions.contains { $0.id == Suggestion.reduceAlcohol } ? alcoholQuestion : nil)
                        .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }
            } footer: {
                if let footer { Text(footer).accessibilityIdentifier("plan.ownershipLine") }
            }
            .listSectionSpacing(.compact)
        }
    }

    /// Weight & diabetes (Brad, round 2): waist-to-height, weight with its BMI, HbA1c; then the
    /// weight cards; then the weight and diabetes medicines.
    @ViewBuilder
    private func weight(_ data: MyData, plan: TopicPlan, tiles: PlanTiles) -> some View {
        heading(.weight)
        let weight = data.vitals.first { $0.metric == "weight" }
        let waist = data.vitals.first { $0.metric == "waist" }
        let hba1c = data.bloodTests.first { $0.metric == "hba1c" }
        let whtr = tiles["whtr"]
        let ratio = whtr.flatMap { tile in waist.map { WaistToHeight(tile: tile, waist: $0, height: data.profile.height) } }
        let column = ValueRow.Column([(ratio?.tile.value, ratio?.previous, "", nil)]
            + [weight, hba1c].compactMap { $0 }.map { ($0.latest?.value, $0.previous, $0.unit, nil) })
        Section {
            // The ratio's row opens the waist page, where waist is added or corrected. With no
            // ratio (no waist yet), the waist row itself, so a first waist can be added.
            if let ratio, let waist {
                Button { open(waist) } label: {
                    ValueRow(label: ratio.tile.label, value: ratio.tile.value, unit: "", day: waist.latest?.day,
                             target: ratio.tile.status?.label, previous: ratio.previous, grade: PlanTiles.grade(ratio.tile),
                             trend: ratio.trend, tint: MetricChart.colors(for: "waist")[0], column: column)
                }
                .tint(.primary)
                .disabled(store.unitSwitches > 0)
            } else if let waist {
                metric(waist, column: column)
            }
            if let weight {
                Button { open(weight) } label: {
                    ValueRow(label: weight.label, value: weight.latest?.value, unit: weight.unit, day: weight.latest?.day,
                             target: tiles["bmi"].map { "\($0.label) \($0.value)" } ?? weight.target, previous: weight.previous,
                             grade: weight.grade, gradeWords: weight.gradeWords, note: weight.note, trend: weight.trend ?? [],
                             tint: MetricChart.colors(for: weight.metric)[0], column: column)
                }
                .tint(.primary)
                .disabled(store.unitSwitches > 0)
            }
            if let hba1c { metric(hba1c, column: column) }
        }
        .listSectionSpacing(.compact)
        cards(plan[.weight])
        MedicationsSection(store: store, data: data, saved: saved, only: "weight-medications")
    }

    /// Today's large blood pressure card, then the blood pressure cards.
    @ViewBuilder
    private func bloodPressure(_ data: MyData, plan: TopicPlan) -> some View {
        heading(.bloodPressure)
        if let pressure = data.vitals.first(where: { $0.metric == MyData.bloodPressure }) {
            Section { metric(pressure, card: pressure.latest != nil) }
                .listSectionSpacing(.compact)
        }
        cards(plan[.bloodPressure])
    }

    /// The rows in today's order, eGFR under creatinine; the cholesterol medicines; the lipid cards.
    @ViewBuilder
    private func bloodTests(_ data: MyData, plan: TopicPlan, tiles: PlanTiles) -> some View {
        heading(.bloodTests)
        // HbA1c shows once, under Weight & diabetes (Brad, round 2).
        let rows = data.bloodTests.filter { $0.metric != "hba1c" }
        let labs = data.labTests ?? []
        Section {
            let column = ValueRow.Column((rows + labs).map { ($0.latest?.value, $0.previous, $0.unit, nil) })
            ForEach(rows) { row in
                if row.metric == "creatinine", let egfr = tiles["egfr"] {
                    VStack(alignment: .leading, spacing: 2) {
                        metric(row, column: column)
                        Button { openedTile = egfr } label: {
                            Text("\(egfr.label) \(egfr.value) \(egfr.unit)").font(.caption).foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                } else {
                    metric(row, column: column)
                }
            }
            ForEach(labs) { lab in
                Button { open(lab) } label: {
                    Self.valueRow(lab, tint: MetricChart.labTint, column: column)
                }
                .tint(.primary)
                .disabled(store.unitSwitches > 0)
            }
        }
        .listSectionSpacing(.compact)
        MedicationsSection(store: store, data: data, saved: saved, only: "lipid-medications")
        cards(plan[.bloodTests])
    }

    /// The reduce-alcohol card's question (US-60), as My plan asked it.
    private var alcoholQuestion: AlcoholQuestion? {
        AlcoholQuestion(answered: store.myData?.profile.alcohol?.value) { [store, analytics] in
            let seen = store.screen
            return { choice in
                Task {
                    switch await store.apply(.alcohol(choice), as: seen) {
                    case .saved: analytics?.event(.alcoholAnswered)
                    case .refused(let message, _): refusal = message
                    }
                }
            }
        }
    }

    // MARK: Settings

    private func settingsList(_ data: MyData) -> some View {
        List {
            aboutYou(data)
            RemindersSection()
            AppleHealthSection()
            // US-65: entries the engine could not read are kept unchanged; one calm line says how many.
            if let note = data.unreadableNote {
                Section {
                } footer: {
                    Text(note)
                }
            }
            RecordSection(store: store, sync: sync)
            Section {
            } footer: {
                Label(SyncStatusText.myDataFooter(provider: sync.provider, earlier: sync.syncedBefore), systemImage: "lock.shield")
                    .frame(maxWidth: .infinity)
            }
        }
        .listStyle(.insetGrouped)
    }

    private func aboutYou(_ data: MyData) -> some View {
        Section {
            Picker("Sex", selection: binding(data.profile.sex ?? "") { .profile(sex: $0) }) {
                Text(MyData.sexLabel("female")).tag("female")
                Text(MyData.sexLabel("male")).tag("male")
            }
            .pickerStyle(.segmented)
            .disabled(picking)

            Picker("Birth year", selection: binding(data.profile.birthYear ?? 0) { .birthYear($0, storedMonth: data.profile.birthMonth, now: .now) }) {
                if data.profile.birthYear == nil { Text("Not set").tag(0) }
                ForEach(DayText.birthYears(now: .now), id: \.self) { Text(String($0)).tag($0) }
            }
            .disabled(picking)

            Picker("Birth month", selection: binding(data.profile.birthMonth ?? 0) { .profile(birthMonth: $0) }) {
                if data.profile.birthMonth == nil { Text("Not set").tag(0) }
                ForEach(DayText.birthMonths(year: data.profile.birthYear ?? 0, now: .now, keeping: data.profile.birthMonth), id: \.self) { Text(DayText.monthName($0)).tag($0) }
            }
            .disabled(picking)

            Button { entry = .height(store.screen) } label: {
                ValueRow(label: "Height", value: data.profile.height, unit: data.profile.heightUnit, day: nil, feetInches: data.profile.feetInches)
            }
            .tint(.primary)
            .disabled(store.unitSwitches > 0)

            // US-60: the answer the reduce-alcohol card's Dismiss asks for; "Not answered" clears it.
            Picker("Alcohol", selection: binding(data.profile.alcohol?.value) { .alcohol($0) }) {
                Text("Not answered").tag(MyData.Alcohol?.none)
                ForEach(MyData.Alcohol.allCases, id: \.self) { Text($0.label).tag(Optional($0)) }
            }
            .disabled(picking)

            LabeledContent("Units") { units(data) }
        } header: {
            SectionTitle.aboutYou()
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

    // MARK: Rows

    /// `column`: the section's widest reading, which sets every row's value column.
    private func metric(_ row: MyData.Row, card: Bool = false, column: ValueRow.Column? = nil) -> some View {
        // A unit switch still landing would open a sheet on the old choices (AC17e).
        Button { open(row) } label: {
            Self.valueRow(row, tint: MetricChart.colors(for: row.metric)[0], card: card, column: column)
        }
        .tint(.primary)
        .disabled(store.unitSwitches > 0)
    }

    /// The engine's row as a `ValueRow`: its value, target, previous value, trend and grade.
    static func valueRow(_ row: MyData.Row, tint: Color, card: Bool = false, column: ValueRow.Column? = nil) -> ValueRow {
        ValueRow(label: row.label, value: row.latest?.value, unit: row.unit, day: row.latest?.day,
                 target: row.target, previous: row.previous, grade: row.grade, gradeWords: row.gradeWords, note: row.note,
                 trend: row.trend ?? [], tint: tint, card: card, column: column)
    }

    /// Every value opens its page (US-25 AC9, US-58 AC4b): every metric has a guide, and a page
    /// with no readings says "No data yet" and offers "Add your first value".
    private func open(_ row: MyData.Row) {
        detail = row
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
            .reads(in: store.inputRange(for: "height", in: seen.units))
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
        if result == .saved() { saves += 1 }
        return result
    }
}

/// A section title with controls at its trailing end, large enough to hit easily.
struct ControlsHeader<Trailing: View>: View {
    let title: SectionTitle
    @ViewBuilder let trailing: Trailing

    var body: some View {
        // The buttons go under the title when both do not fit on one line: beside them at the
        // largest text sizes, "Vitals" broke mid-word as "Vi-tals" (US-25 AC17g, break-it 2026-10-30).
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 14) {
                title.fixedSize()
                Spacer()
                buttons
            }
            VStack(alignment: .leading, spacing: 8) {
                title
                HStack(spacing: 14) { buttons }
            }
        }
    }

    private var buttons: some View {
        trailing
            .labelStyle(.iconOnly)
            .font(.title3)
            .textCase(nil)
    }
}

extension View {
    /// For a tab with no title bar, My data's and My plan's: iOS 26's edge effect leaves rows
    /// legible under the clock. A zero-height inset whose background reaches into the status bar hides them.
    func solidStatusBar() -> some View {
        safeAreaInset(edge: .top, spacing: 0) {
            Color.clear.frame(height: 0).background(Color(uiColor: .systemGroupedBackground), ignoresSafeAreaEdges: .top)
        }
    }
}
