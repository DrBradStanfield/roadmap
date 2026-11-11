import SwiftUI

/// Save all under way (US-52 AC8b): Close waits, and the line counts the reports done or under way.
struct SaveAllProgressView: View {
    let progress: SaveAllProgress

    var body: some View {
        VStack(spacing: 16) {
            ProgressView(value: Double(progress.done), total: Double(max(progress.total, 1)))
            Text("Saving \(progress.done + progress.inFlight.count) of \(progress.total)")
            // Why Close is off.
            Text("Keep this open until it finishes.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
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
                            // The chevron says the row opens that report's review.
                            HStack(spacing: 12) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(results[row.index].name).foregroundStyle(Color.primary)
                                    Text(row.reason).font(.footnote).foregroundStyle(Color.secondary)
                                }
                                Spacer(minLength: 0)
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold))
                                    .foregroundStyle(Color(.tertiaryLabel))
                                    .accessibilityHidden(true)
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
