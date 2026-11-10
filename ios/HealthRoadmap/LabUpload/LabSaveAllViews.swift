import SwiftUI

/// Save all under way (US-52 AC8b): Close waits, and the line counts the reports done or under way.
struct SaveAllProgressView: View {
    let progress: SaveAllProgress

    var body: some View {
        VStack(spacing: 16) {
            ProgressView(value: Double(progress.done), total: Double(max(progress.total, 1)))
            Text("Saving \(progress.done + progress.inFlight.count) of \(progress.total)")
                .foregroundStyle(.secondary)
        }
        .padding()
    }
}

/// What save all did (AC8b): the reports not saved first, each with why and a tap that
/// opens its review, then what was saved.
struct SaveAllSummaryView: View {
    let results: [LabResult]
    let summary: SaveAllSummary
    let open: (Int) -> Void
    let done: () -> Void

    var body: some View {
        Form {
            if !summary.notSaved.isEmpty {
                Section {
                    ForEach(summary.notSaved, id: \.index) { row in
                        Button { open(row.index) } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(results[row.index].name).foregroundStyle(Color.primary)
                                Text(row.reason).font(.footnote).foregroundStyle(Color.secondary)
                            }
                        }
                    }
                } header: {
                    Text("\(summary.notSaved.count) report\(summary.notSaved.count == 1 ? "" : "s") not saved")
                } footer: {
                    if summary.stopped != nil { Text("Save all stopped there, so the reports after it were not tried.") }
                }
            }
            Section {
                Text("Saved \(summary.values) value\(summary.values == 1 ? "" : "s") and \(summary.documents) document\(summary.documents == 1 ? "" : "s")")
            }
            Section { Button("Done", action: done) }
        }
    }
}
