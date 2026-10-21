import Charts
import SwiftUI

/// One metric's values, newest first, with a chart (US-25 AC9). Tapping a value
/// corrects it: a new row, the old one kept and struck through as entered in
/// error. There is no delete: the record is append-only (Brad 2026-09-24).
/// The web twin is widget-src/src/components/HistoryPanel.tsx, with the
/// correction the web's matrices offer on a saved cell.
struct HistoryView: View {
    let store: RecordStore
    let row: MyData.Row
    /// Counts a save, for the success haptic.
    let saved: (RecordStore.ApplyResult) -> RecordStore.ApplyResult

    @Environment(\.dismiss) private var dismiss
    /// Which sheet is open: a new value, or a correction of a row.
    @State private var editing: Editing?

    private enum Editing: Identifiable {
        case add
        case correct(MetricHistory.Row)
        var id: String {
            switch self {
            case .add: "add"
            case .correct(let row): row.id
            }
        }
    }

    var body: some View {
        let history = store.history(for: row.metric)
        NavigationStack {
            List {
                if let history, history.rows.isEmpty {
                    ContentUnavailableView {
                        Label("No values yet", systemImage: "chart.xyaxis.line")
                    } description: {
                        Text("Add your first \(row.label) value.")
                    } actions: {
                        Button("Add a value") { editing = .add }.buttonStyle(.borderedProminent)
                    }
                } else if let history {
                    let points = history.rows.filter(\.isActive).compactMap(ChartPoint.init)
                    if points.count >= 2 {
                        Section { trend(points, unit: history.unit) }
                    }
                    Section {
                        ForEach(history.rows) { value in
                            if value.isActive {
                                Button { editing = .correct(value) } label: { HistoryRow(row: value, unit: history.unit) }
                                    .tint(.primary)
                                    .accessibilityHint("Opens a correction")
                            } else {
                                HistoryRow(row: value, unit: history.unit)
                            }
                        }
                    } header: {
                        Text("Values")
                    } footer: {
                        Text("Tap a value to correct it. The old value stays in your record, struck through and marked as entered in error.")
                    }
                }
            }
            .listStyle(.insetGrouped)
            .navigationTitle(row.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button { editing = .add } label: { Label("Add a value", systemImage: "plus") }
                }
            }
            .sheet(item: $editing) { editing in
                sheet(for: editing).presentationDetents([.medium, .large])
            }
        }
    }

    @ViewBuilder
    private func sheet(for editing: Editing) -> some View {
        switch editing {
        case .add:
            ValueEntrySheet(title: row.label, unit: row.unit, current: row.latest?.value, asksForDay: true, read: store.number) { value, day in
                saved(store.apply(.add(metric: row.metric, value: value, day: day)))
            } replace: { existingId, value in
                saved(store.apply(.correct(id: existingId, value: value)))
            }
        case .correct(let value):
            ValueEntrySheet(title: "Correct \(DayText.short(value.day))", unit: row.unit, current: value.value, asksForDay: false, read: store.number) { number, _ in
                saved(store.apply(.correct(id: value.id, value: number)))
            }
        }
    }

    private func trend(_ points: [ChartPoint], unit: String) -> some View {
        Chart(points) { point in
            LineMark(x: .value("Day", point.date), y: .value(unit, point.value))
                .interpolationMethod(.monotone)
            PointMark(x: .value("Day", point.date), y: .value(unit, point.value))
        }
        .chartYScale(domain: .automatic(includesZero: false))
        .frame(height: 160)
        .accessibilityLabel("\(row.label) over time")
    }
}

/// One active value on the chart.
private struct ChartPoint: Identifiable {
    let id: String
    let date: Date
    let value: Double

    init?(_ row: MetricHistory.Row) {
        guard let date = DayText.date(row.day), let value = Double(row.value) else { return nil }
        id = row.id
        self.date = date
        self.value = value
    }
}

/// A value and its day; an entered-in-error value is struck through and says so.
private struct HistoryRow: View {
    let row: MetricHistory.Row
    let unit: String

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(DayText.short(row.day))
                if !row.isActive {
                    Text("Entered in error").font(.caption).foregroundStyle(.secondary)
                } else if row.current {
                    Text("Used in your plan").font(.caption).foregroundStyle(.tint)
                } else if row.correction {
                    Text("Corrected").font(.caption).foregroundStyle(.secondary)
                }
            }
            Spacer()
            Text(row.value)
                .font(.body.weight(row.isActive ? .semibold : .regular))
                .monospacedDigit()
                .strikethrough(!row.isActive)
                .foregroundStyle(row.isActive ? .primary : .secondary)
            Text(unit).font(.subheadline).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(row.isActive ? "\(row.value) \(unit), \(DayText.short(row.day))" : "Entered in error: \(row.value) \(unit), \(DayText.short(row.day))")
    }
}
