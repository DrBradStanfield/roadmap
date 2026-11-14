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
    @State var entry: Entry?
    /// The metric whose page is pushed.
    @State private var detail: MyData.Row?
    @State var showSync = false
    @State var showSettings = false
    @State var addingLabs = false
    /// Tour tip 3 is due and its heading has come to rest on screen (US-57 AC2).
    @State var bloodTestsTipReady = false
    /// "Add blood test", and the test picked in it (round 7).
    @State var addingTest = false
    @State private var pickedTest: PickedTest?
    /// The page as last built, and the screen it was built for (`currentPage`).
    @State private var page: HealthPage?
    @State private var pageBuiltFor: Int?
    @State var refusal: String?
    @State private var saves = 0
    /// A picker's edit is landing: the pickers wait, so a quick change back is never lost.
    @State var picking = false
    /// US-56: Apple Health's sleep and fitness metrics, read live; the one whose page is pushed.
    @Environment(LiveHealth.self) private var live: LiveHealth?
    @Environment(AppleHealthSync.self) private var healthSync: AppleHealthSync?
    @State var liveDetail: LiveMetric?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.analytics) var analytics
    @Environment(\.dismiss) private var dismiss
    @Environment(\.dynamicTypeSize) var typeSize

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
            .sheet(isPresented: $addingLabs) { LabUploadSheet(engine: engine, store: store) }.labSaveAllDemo($addingLabs)
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
        editing(settingsList(store.myData))
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
    }

    /// The record's list, or why it cannot be shown with Settings and Sync still in reach (lead H114).
    @ViewBuilder
    private func content(@ViewBuilder _ list: (MyData) -> some View) -> some View {
        if let data = store.myData {
            list(data)
        } else if let text = UndrawnRecord.text(hold: store.hold, problem: store.problem) {
            undrawnPage(text)
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
        .contentMargins(.bottom, 12, for: .scrollContent) // The footer clears the floating tab bar (US-73).
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
    static let firstRow = "tour.firstRow"

    /// Once `tip` is due, scrolls its anchor into view (US-57).
    private func bringIntoView(_ tip: some Tip, _ anchor: @autoclosure () -> String?, proxy: ScrollViewProxy, at point: UnitPoint) async {
        for await due in tip.shouldDisplayUpdates where due {
            withAnimation { proxy.scrollTo(anchor(), anchor: point) }
        }
    }

    // MARK: Rows

    /// `column`: the section's widest reading, which sets every row's value column.
    func metric(_ row: MyData.Row, card: Bool = false, column: ValueRow.Column? = nil) -> some View {
        metric(row, label: Self.valueRow(row, tint: MetricChart.colors(for: row.metric)[0], card: card, column: column))
    }

    /// A row drawn as `label` that opens `page`'s page. A unit switch still landing would open a
    /// sheet on the old choices (AC17e), so it waits.
    func metric(_ page: MyData.Row, label: ValueRow) -> some View {
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
    func binding<Value: Equatable>(_ shown: Value, _ edit: @escaping (Value) -> RecordEdit) -> Binding<Value> {
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
