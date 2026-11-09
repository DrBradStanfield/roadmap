import SwiftUI
import TipKit

/// The My health tab (US-73; was My data and My plan, US-25 AC5, AC17): one page by topic,
/// weight first, each topic's values then its plan cards, as the engine places them; the
/// view draws only `HealthPage`, built once per record change. About you, reminders, Apple Health and the record sit in a settings sheet behind the person button
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
    enum Entry: Identifiable {
        case height(RecordStore.Screen)
        /// A value for a test picked in "Add blood test" (US-73 AC8): one the record lists, or one by name.
        case test(MyData.Row, RecordStore.Screen)
        case named(String, units: [String], RecordStore.Screen)

        var id: String {
            switch self {
            case .height: "height"
            case .test(let row, _): "test.\(row.id)"
            case .named(let name, _, _): "named.\(name)"
            }
        }
    }

    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync
    var layout: Layout = .health
    /// A plan card came on screen: the review prompt waits for it (US-25 AC10).
    var planShown: () -> Void = {}
    /// The settings sheet closed: a backup offer its saves made due can show now (US-57 AC8).
    var settingsClosed: () -> Void = {}
    @State private var entry: Entry?
    /// The metric whose page is pushed.
    @State private var detail: MyData.Row?
    @State private var showSync = false
    @State private var showSettings = false
    @State private var addingLabs = false
    /// Tour tip 3 is due and its heading has come to rest on screen (US-57 AC2).
    @State private var bloodTestsTipReady = false
    /// "Add blood test", and the test picked in it (round 7).
    @State private var addingTest = false
    @State private var pickedTest: PickedTest?
    /// The page as last built, and the screen it was built for (`currentPage`).
    @State private var page: HealthPage?
    @State private var pageBuiltFor: Int?
    @State private var refusal: String?
    @State private var saves = 0
    /// A picker's edit is landing: the pickers wait, so a quick change back is never lost.
    @State private var picking = false
    /// US-56: Apple Health's sleep and fitness metrics, read live; the one whose page is pushed.
    @Environment(LiveHealth.self) private var live: LiveHealth?
    @Environment(AppleHealthSync.self) private var healthSync: AppleHealthSync?
    @State private var liveDetail: LiveMetric?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.analytics) private var analytics
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) private var typeSize

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
            .sheet(isPresented: $addingTest, onDismiss: {
                if let pickedTest { entry = Self.entry(for: pickedTest, now: store.screen, data: store.myData) }
                pickedTest = nil
            }) {
                if let data = store.myData { AddBloodTestSheet(engine: engine, data: data) { pickedTest = PickedTest(pick: $0, seen: store.screen) } }
            }
            // Settings' own saves wait for it to close before the backup offer (US-57 AC8).
            .sheet(isPresented: $showSettings, onDismiss: settingsClosed) {
                NavigationStack { MyDataView(engine: engine, store: store, sync: sync, layout: .settings) }
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
            ContentUnavailableView(store.problem?.heading ?? "Your record did not load", systemImage: "exclamationmark.triangle", description: Text(store.problem?.words ?? ""))
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

    /// The page for this screen: built once per draw, when its series have been read; until
    /// then, from what the store shows now.
    private var currentPage: HealthPage {
        if let page, pageBuiltFor == Self.pageKey(store) { return page }
        return HealthPage(store)
    }

    /// What the page is built for: the screen drawn, so a redraw at a new day or for another
    /// storefront builds it again. The worked-out series it reads are kept per screen drawn too
    /// (`RecordStore.chart`); until they are read again the page draws the last ones, a frame's
    /// stale day or source at most, with the new plan's own eGFR value (review round 3).
    static func pageKey(_ store: RecordStore) -> Int { store.draws }

    private func healthList(_ data: MyData, proxy: ScrollViewProxy) -> some View {
        let page = currentPage
        return List {
            top(page, proxy: proxy)
            planNotice
            topicSection(.weight, page, rows: { weightRows(page) }, after: {
                MedicationsSection(store: store, sections: page.weightMedications, data: data, saved: saved, placed: page.medicines)
            })
            liveTopic(.sleep, page)
            liveTopic(.fitness, page, bands: data.vo2Bands?.value.map { [.vo2Max: $0] } ?? [:])
            topicSection(.bloodPressure, page, rows: {
                if let pressure = page.pressure {
                    Section { metric(pressure, card: pressure.latest != nil) }
                        .listSectionSpacing(.compact)
                }
                if let creatinine = page.creatinine {
                    Section { bloodTest(creatinine, column: page.pressureColumn, page: page) }
                        .listSectionSpacing(.compact)
                }
            })
            topicSection(.cholesterol, page, rows: { cholesterolRows(page) }, after: {
                MedicationsSection(store: store, sections: page.lipidMedications, data: data, saved: saved, placed: page.medicines)
            })
            if page.showsScreening {
                topicSection(.screening, page, rows: {
                    ScreeningsSection(store: store, data: data, saved: saved, open: open, grouped: page.screenings)
                })
            }
            if !page[.skin].isEmpty { topicSection(.skin, page) }
            topicSection(.bloodTests, page, controls: { recordButtons }, rows: { bloodTestRows(page) })
            topicSection(.supplements, page, footer: page.ownershipLine, after: {
                SupplementsSection(store: store, supplements: data.supplements, saved: saved)
            })
            if !page[.other].isEmpty { topicSection(.other, page) }
            if let documents = data.documents?.value { DocumentSections(store: store, documents: documents) }
            Section {
            } footer: {
                VStack(spacing: 12) {
                    Text(PlanText.disclaimer)
                    // Chat and lab upload send data (US-52 AC9, D9), so the line claims only where the
                    // plan was worked out, and in the engine's own whole milliseconds (D2's plan budget).
                    if case .planned(_, _, let ms) = store.plan {
                        Label(PlanText.workedOut(ms: ms), systemImage: "lock.shield").frame(maxWidth: .infinity)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        // The title where a large title sits, not under the list's top margin (Brad, round 7).
        .contentMargins(.top, 0, for: .scrollContent)
        // The worked-out rows read their engine series once per screen drawn (US-73 AC7), then
        // the page is built from them.
        .task(id: Self.pageKey(store)) {
            let key = Self.pageKey(store)
            for series in HealthPage.series { _ = await store.chart(for: series, series: series) }
            guard !Task.isCancelled, key == Self.pageKey(store) else { return }
            self.page = HealthPage(store)
            pageBuiltFor = key
        }
        // Each tour tip, once due, brings its anchor into view (US-57); a weight section with
        // no card passes tip 2 (review R4).
        .task { await bringIntoView(SnapshotTip(), Self.firstRow, proxy: proxy, at: .center) }
        .task { await bringIntoView(FoundationTip(), currentPage.firstWeightCard, proxy: proxy, at: .center) }
        .task {
            // Tip 3 is drawn only once its heading has stopped moving: due while the heading
            // was off screen and the list mid-scroll (after tip 2's Next or a tap outside it, or
            // scrolling to the top after a tap by the clock), its popover never showed (US-57 AC2).
            for await due in BloodTestsTip().shouldDisplayUpdates {
                guard due else { bloodTestsTipReady = false; continue }
                withAnimation { proxy.scrollTo(HealthTopic.bloodTests.anchor, anchor: .top) }
                try? await Task.sleep(for: .milliseconds(700))
                proxy.scrollTo(HealthTopic.bloodTests.anchor, anchor: .top)
                bloodTestsTipReady = true
            }
        }
        .tourStep(FoundationTip(), hasNoAnchor: page.firstWeightCard == nil)
    }

    /// The scroll id of Weight & diabetes' first row, tour tip 1's anchor.
    private static let firstRow = "tour.firstRow"

    /// Once `tip` is due, scrolls its anchor into view (US-57).
    private func bringIntoView(_ tip: some Tip, _ anchor: @autoclosure () -> String?, proxy: ScrollViewProxy, at point: UnitPoint) async {
        for await due in tip.shouldDisplayUpdates where due {
            withAnimation { proxy.scrollTo(anchor(), anchor: point) }
        }
    }

    /// The title with the person button, lab upload and Sync, as a row so nothing holds space
    /// under it; then the urgent banner, only when a card is urgent.
    @ViewBuilder
    private func top(_ page: HealthPage, proxy: ScrollViewProxy) -> some View {
        Section {
            let title = Text("My health").font(.largeTitle.bold()).accessibilityAddTraits(.isHeader)
            let buttons = HStack(spacing: 14) {
                Button { showSettings = true } label: {
                    Label("Settings", systemImage: "person.crop.circle")
                }
                recordButtons
            }
            .buttonStyle(.borderless)
            .labelStyle(.iconOnly)
            .font(.title3)
            // The buttons go under the title when both do not fit: beside them at the largest
            // sizes, the title broke mid-word ("heal th", TextSizeLayoutTests, US-25 AC26).
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 14) { title.fixedSize(); Spacer(); buttons }
                VStack(alignment: .leading, spacing: 8) { title; buttons }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 0, trailing: 4))
            .listRowSeparator(.hidden)
            // The jump pills (Brad, round 6): they scroll with the page; equal widths across the cards' width (round 7).
            // One above another at accessibility sizes, where three across cut each to "Bl…".
            (typeSize.isAccessibilitySize ? AnyLayout(VStackLayout(spacing: 8)) : AnyLayout(HStackLayout(spacing: 8))) {
                ForEach(HealthTopic.pills) { topic in
                    Button {
                        analytics?.event(.jumpPillTapped)
                        withAnimation { proxy.scrollTo(topic.anchor, anchor: .top) }
                    } label: {
                        // One line, shrunk at the largest sizes rather than cut to "Blood te…" (TextSizeLayoutTests).
                        Text(topic.title.title).lineLimit(1).minimumScaleFactor(0.7).frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .buttonBorderShape(.capsule)
                    .controlSize(.small)
                    .tint(.primary)
                }
            }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            .listRowSeparator(.hidden)
            if let urgent = page.urgent {
                Button {
                    withAnimation { proxy.scrollTo(urgent.anchor, anchor: .center) }
                } label: {
                    Label("Needs attention: \(urgent.title)", systemImage: "exclamationmark.triangle.fill")
                        .font(.subheadline.weight(.semibold))
                        // White was hard to read on dark mode's light red; the page background reads on both reds.
                        .foregroundStyle(Color(.systemBackground))
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(14)
                        .background(Color.status("urgent"), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .buttonStyle(PressableStyle())
                .accessibilityHint("Scrolls to the card")
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
            }
        }
        .listSectionSpacing(.compact)
    }

    /// Lab upload and Sync: on the title line and on the Blood tests heading.
    @ViewBuilder
    private var recordButtons: some View {
        Button { addingLabs = true } label: {
            Label("Add medical records", systemImage: "plus")
        }
        .accessibilityHint("Upload a lab report or clinic letter")
        Button { showSync = true } label: {
            Label("Sync", systemImage: SyncStatusText.symbol(sync.status, provider: sync.provider))
        }
    }

    /// A topic's heading, a row in the list's own flow, so the pills can scroll to it; any
    /// controls at its trailing end (Blood tests: lab upload and Sync, round 7). At the largest
    /// sizes a one-word title shrinks to one line and any controls go under it, so no word
    /// breaks ("Supplem-ents", TextSizeLayoutTests, US-25 AC26).
    /// Tour tip 3 (US-57 AC7) rides on Blood tests' heading; its action is the lab upload.
    private func heading(_ topic: HealthTopic, @ViewBuilder controls: () -> some View = { EmptyView() }) -> some View {
        TopicHeading(topic.title, anchor: topic.anchor, tip: topic == .bloodTests && bloodTestsTipReady ? { addingLabs = true } : nil, controls: controls)
    }

    /// One topic as every section draws it: its heading, its urgent cards over its rows (Brad
    /// 2026-11-05: an urgent suggestion on a row shows there too), its rows, its other cards
    /// (with `footer` under them), then anything after (a section's medicines).
    @ViewBuilder
    private func topicSection(_ topic: HealthTopic, _ page: HealthPage, footer: String? = nil,
                              @ViewBuilder controls: () -> some View = { EmptyView() },
                              @ViewBuilder rows: () -> some View = { EmptyView() },
                              @ViewBuilder after: () -> some View = { EmptyView() }) -> some View {
        heading(topic, controls: controls)
        cardSection(page[topic].urgent, page: page)
        rows()
        cardSection(page[topic].cards, page: page, footer: footer)
        after()
    }

    /// Sleep or Fitness: the Apple Health cards between the topic's urgent and other cards. The
    /// section reads Health itself, so a live refresh never rebuilds this list (/simplify, efficiency).
    private func liveTopic(_ topic: HealthTopic, _ page: HealthPage, bands: [LiveMetric: Vo2MaxBands] = [:]) -> some View {
        LiveCardsSection(metrics: topic.liveMetrics, bands: bands, keepsReconnect: topic == .fitness, hasCards: !page[topic].isEmpty) {
            liveDetail = $0
        } header: {
            heading(topic)
            cardSection(page[topic].urgent, page: page)
        } footer: {
            cardSection(page[topic].cards, page: page)
        }
    }

    /// Why there is no plan yet, when there is none: health-core's PlanError needs sex and
    /// height, set in Settings; any other failure in the engine's words.
    @ViewBuilder
    private var planNotice: some View {
        switch store.plan {
        case .needsDetails:
            Section {
                Label("Your plan needs a few details", systemImage: "person.text.rectangle").font(.headline)
                Text(PlanText.needsDetails).foregroundStyle(.secondary)
                Button("Add your details") { showSettings = true }
            }
        case .failed(let reason):
            Section {
                Label("Your plan could not be worked out", systemImage: "exclamationmark.triangle").font(.headline)
                Text(reason).foregroundStyle(.secondary)
            }
        case .planned, nil:
            EmptyView()
        }
    }

    /// Plan cards in the plan's own card style. A card on screen is the plan shown, which the
    /// review prompt waits for (US-25 AC10); the first Weight & diabetes card carries tour tip 2.
    @ViewBuilder
    private func cardSection(_ cards: [PlanCard], page: HealthPage, footer: String? = nil) -> some View {
        if !cards.isEmpty {
            Section {
                ForEach(cards, id: \.anchor) { card in
                    let view = PlanCardView(card: card, askAboutAlcohol: card.asking(alcoholQuestion))
                        .listRowInsets(EdgeInsets(top: 6, leading: 0, bottom: 6, trailing: 0))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                        .onAppear(perform: planShown)
                    if card.anchor == page.firstWeightCard { view.tourTip(FoundationTip()) } else { view }
                }
            } footer: {
                if let footer { Text(footer).accessibilityIdentifier("plan.ownershipLine") }
            }
            .listSectionSpacing(.compact)
        }
    }

    /// Weight & diabetes (Brad, round 2): waist-to-height, weight with its BMI, HbA1c.
    private func weightRows(_ page: HealthPage) -> some View {
        Section {
            // Tour tip 1 (US-57 AC4) on the first row. The ratio's row opens the waist page, where
            // waist is added or corrected; with no ratio (no waist yet), the waist row itself.
            Group {
                if let ratio = page.whtr, let waist = page.waist {
                    metric(waist, label: ValueRow(label: ratio.history.label, value: ratio.latest.value, unit: "", day: ratio.latest.day,
                                                  target: ratio.history.target, previous: ratio.previous, grade: PlanTiles.grade(page.tiles["whtr"]),
                                                  trend: ratio.trend, tint: MetricChart.colors(for: "waist")[0], column: page.weightColumn))
                } else if let waist = page.waist {
                    metric(waist, column: page.weightColumn)
                }
            }
            .tourTip(SnapshotTip())
            .id(Self.firstRow)
            if let weight = page.weight {
                metric(weight, label: ValueRow(label: weight.label, value: weight.latest?.value, unit: weight.unit, day: weight.latest?.day,
                                               target: page.weightTarget, previous: weight.previous, grade: weight.grade, gradeWords: weight.gradeWords,
                                               note: weight.note, trend: weight.trend ?? [], tint: MetricChart.colors(for: weight.metric)[0], column: page.weightColumn))
            }
            if let hba1c = page.hba1c { metric(hba1c, column: page.weightColumn) }
        }
        .listSectionSpacing(.compact)
    }

    /// ApoB, LDL, total cholesterol, HDL, non-HDL when the plan works it out, triglycerides and Lp(a).
    private func cholesterolRows(_ page: HealthPage) -> some View {
        Section {
            ForEach(page.lipids) { row in
                metric(row, column: page.lipidColumn)
                // Non-HDL is total cholesterol less HDL: its row opens total cholesterol's page, which explains it.
                if row.metric == "hdl", let nonHdl = page.nonHdl {
                    metric(nonHdl.total, label: ValueRow(label: nonHdl.tile.label, value: nonHdl.tile.value, unit: nonHdl.tile.unit, day: nonHdl.total.latest?.day,
                                                         target: nonHdl.tile.status?.label, grade: PlanTiles.grade(nonHdl.tile),
                                                         tint: MetricChart.colors(for: "total_cholesterol")[0], column: page.lipidColumn))
                }
            }
        }
        .listSectionSpacing(.compact)
    }

    /// Every blood test, eGFR's one row under creatinine (it stands for the lab's eGFR), then
    /// "Add blood test".
    private func bloodTestRows(_ page: HealthPage) -> some View {
        Section {
            ForEach(page.bloodTests) { bloodTest($0, column: page.bloodColumn, page: page) }
            ForEach(page.labs) { lab in
                metric(lab, label: Self.valueRow(lab, tint: MetricChart.labTint, column: page.bloodColumn))
            }
            // A row like "Add another supplement"; a test found by name opens its entry.
            Button { addingTest = true } label: { Label("Add blood test", systemImage: "plus.circle.fill") }
        }
        .listSectionSpacing(.compact)
    }

    /// A blood test's row; creatinine's has eGFR's one row under it (US-73 AC7): the plan's
    /// current eGFR, with the series' previous value and trend. It opens the page of its
    /// source, the lab eGFR's or creatinine's, each linking to the other.
    @ViewBuilder
    private func bloodTest(_ row: MyData.Row, column: ValueRow.Column, page: HealthPage) -> some View {
        metric(row, column: column)
        if row.metric == "creatinine", let egfr = page.egfr {
            metric(egfr.page, label: ValueRow(label: egfr.label, value: egfr.value, unit: egfr.unit, day: egfr.day, target: egfr.target,
                                              previous: egfr.previous, grade: egfr.grade, trend: egfr.trend,
                                              tint: MetricChart.colors(for: row.metric)[0], column: column))
        }
    }

    /// The reduce-alcohol card's question (US-60), as the plan cards ask it: offered unanswered and
    /// to a drinker. Called at the tap, it checks the answer against the screen then.
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
        metric(row, label: Self.valueRow(row, tint: MetricChart.colors(for: row.metric)[0], card: card, column: column))
    }

    /// A row drawn as `label` that opens `page`'s page. A unit switch still landing would open a
    /// sheet on the old choices (AC17e), so it waits.
    private func metric(_ page: MyData.Row, label: ValueRow) -> some View {
        Button { open(page) } label: { label }
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

    /// A pick in Add blood test with the screen it was made on (Codex R2).
    struct PickedTest {
        let pick: AddBloodTestSheet.Pick
        let seen: RecordStore.Screen
    }

    /// The entry a pick opens once its sheet has gone: a row and the screen it was read on, of
    /// one moment. When the units moved since the pick, the row as it reads now, on the screen
    /// now, so the sheet's unit and the check on its save agree (Codex R2).
    static func entry(for picked: PickedTest, now: RecordStore.Screen, data: MyData?) -> Entry? {
        switch picked.pick {
        case .row(let row) where picked.seen == now: .test(row, now)
        case .row(let row): data.flatMap { MetricDetailView.live(row, in: $0) }.map { .test($0, now) }
        case .named(let name, let units): .named(name, units: units, now)
        }
    }

    @ViewBuilder
    private func sheet(for entry: Entry) -> some View {
        switch entry {
        case .test(let row, let seen):
            MetricEntrySheet(store: store, row: row, seen: seen, saved: addedTest)
        case .named(let name, let units, let seen):
            NamedTestEntry(store: store, name: name, units: units, seen: seen, saved: addedTest)
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

    /// A save from the Add blood test sheet: US-73's usage signal, never which test or value.
    private func addedTest(_ result: RecordStore.ApplyResult) -> RecordStore.ApplyResult {
        if result == .saved() { analytics?.event(.bloodTestAdded) }
        return saved(result)
    }
}

extension View {
    /// For a tab with no title bar, My health's: iOS 26's edge effect leaves rows
    /// legible under the clock. A zero-height inset whose background reaches into the status bar hides them.
    func solidStatusBar() -> some View {
        safeAreaInset(edge: .top, spacing: 0) {
            Color.clear.frame(height: 0).background(Color(uiColor: .systemGroupedBackground), ignoresSafeAreaEdges: .top)
        }
    }
}
