import SwiftUI

/// The settings sheet's list: About you, reminders, Apple Health and the record. Split out of MyDataView.swift.
extension MyDataView {
    // MARK: Settings

    func settingsList(_ data: MyData) -> some View {
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
            recordSections
        }
        .listStyle(.insetGrouped)
    }

    /// Export and Delete all my data, then where the record is kept: also when it cannot be drawn.
    @ViewBuilder
    var recordSections: some View {
        RecordSection(store: store, sync: sync)
        Section {
        } footer: {
            Label(SyncStatusText.myDataFooter(provider: sync.provider, earlier: sync.syncedBefore), systemImage: "lock.shield")
                .frame(maxWidth: .infinity)
        }
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
}
