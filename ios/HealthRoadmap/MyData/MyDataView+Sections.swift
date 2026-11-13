import SwiftUI
import TipKit

/// My health's topic sections: headings, plan cards and each topic's rows. Split out of MyDataView.swift.
extension MyDataView {
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
    func topicSection(_ topic: HealthTopic, _ page: HealthPage, footer: String? = nil,
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
    func liveTopic(_ topic: HealthTopic, _ page: HealthPage, bands: [LiveMetric: Vo2MaxBands] = [:]) -> some View {
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
    var planNotice: some View {
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
    func weightRows(_ page: HealthPage) -> some View {
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
    func cholesterolRows(_ page: HealthPage) -> some View {
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
    func bloodTestRows(_ page: HealthPage) -> some View {
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
    func bloodTest(_ row: MyData.Row, column: ValueRow.Column, page: HealthPage) -> some View {
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
}
