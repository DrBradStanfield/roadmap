import SwiftUI

/// The My data tab (US-25 AC5): about you, units, vitals and blood tests, each
/// row with its current value. Every change goes through `RecordStore.apply`,
/// so the engine's rules decide what is saved. The web twins are
/// StartingInfoVitals.tsx and BloodTestTimeline.tsx.
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

    let store: RecordStore
    @State private var entry: Entry?
    @State private var refusal: String?
    @State private var saves = 0

    var body: some View {
        Group {
            if let data = store.myData {
                List {
                    aboutYou(data)
                    units(data)
                    metrics("Vitals", data.vitals)
                    metrics("Blood tests", data.bloodTests)
                    Section {
                    } footer: {
                        Label("Saved only on this iPhone, never in its backups. Until cloud sync arrives, a new phone starts empty.", systemImage: "lock.shield")
                            .frame(maxWidth: .infinity)
                    }
                }
                .listStyle(.insetGrouped)
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
        Section("About you") {
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
                ForEach(1...12, id: \.self) { Text(DayText.gregorian.monthSymbols[$0 - 1]).tag($0) }
            }

            Button { entry = .height } label: {
                ValueRow(label: "Height", value: data.profile.height, unit: data.profile.heightUnit, day: nil)
            }
            .tint(.primary)
        }
    }

    private func units(_ data: MyData) -> some View {
        Section("Units") {
            Picker("Units", selection: binding(data.unitSystem) { .units($0) }) {
                Text("Metric").tag("si")
                Text("US").tag("conventional")
            }
            .pickerStyle(.segmented)
        }
    }

    private func metrics(_ title: String, _ rows: [MyData.Row]) -> some View {
        Section(title) {
            ForEach(rows) { row in
                Button { entry = .metric(row) } label: {
                    ValueRow(label: row.label, value: row.latest?.value, unit: row.unit, day: row.latest?.day)
                }
                .tint(.primary)
            }
        }
    }

    // MARK: Entry

    @ViewBuilder
    private func sheet(for entry: Entry) -> some View {
        switch entry {
        case .height:
            let profile = store.myData?.profile
            ValueEntrySheet(title: "Height", unit: profile?.heightUnit ?? "", current: profile?.height, asksForDay: false, read: store.number) { value, _ in
                saved(store.apply(.profile(height: value)))
            }
        case .metric(let row):
            ValueEntrySheet(title: row.label, unit: row.unit, current: row.latest?.value, asksForDay: true, read: store.number) { value, day in
                saved(store.apply(.add(metric: row.metric, value: value, day: day)))
            } replace: { existingId, value in
                saved(store.apply(.correct(id: existingId, value: value)))
            }
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

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                if let day {
                    Text(DayText.short(day)).font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            if let value {
                Text(value)
                    .font(.body.weight(.semibold))
                    .monospacedDigit()
                    .contentTransition(.numericText())
                Text(unit).font(.subheadline).foregroundStyle(.secondary)
            } else {
                Text("Add").foregroundStyle(Color.accentColor)
            }
        }
        .animation(.snappy, value: value)
        .contentShape(Rectangle())
    }
}
