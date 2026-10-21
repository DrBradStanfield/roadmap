import SwiftUI

/// The extracted values for the user to confirm (US-52 AC8). Each shows its day;
/// values without one take the test's day, which the user can change and must pick
/// when the report printed none. Only ticked values are written, by the engine's
/// `labImport` edit (health-core's bulkAppendValues). The web twin is
/// widget-src/src/components/ReviewTable.tsx.
struct LabReviewView: View {
    let engine: HealthEngine
    let store: RecordStore
    let result: LabResult
    let position: (Int, Int)
    let onDone: () -> Void

    @State private var review: LabReview?
    @State private var ticked: Set<String> = []
    @State private var testDay = Date.now
    @State private var outcome: String?
    @State private var problem: String?

    var body: some View {
        Form {
            Section {
                Text(result.name).font(.headline)
                if position.1 > 1 { Text("Report \(position.0) of \(position.1)").foregroundStyle(.secondary) }
                if result.truncated { Text("Only the first 20 pages were read.").foregroundStyle(.secondary) }
            }
            if let failure = result.failure {
                Section { Text(failure) }
            } else if let review {
                reviewSections(review)
            }
            if let problem { Section { Text(problem).foregroundStyle(.red) } }
            if let outcome { Section("Saved") { Text(outcome) } }
            Section {
                if outcome == nil, review?.isLabReport == true, result.failure == nil {
                    Button("Save \(ticked.count) value\(ticked.count == 1 ? "" : "s")") { save() }
                        .disabled(ticked.isEmpty)
                }
                Button(outcome == nil ? "Skip" : (position.0 < position.1 ? "Next report" : "Done")) { onDone() }
            }
        }
        .onAppear(perform: load)
    }

    @ViewBuilder
    private func reviewSections(_ review: LabReview) -> some View {
        if !review.isLabReport {
            Section { Text("This does not look like a lab report, so there are no values to save. Filing other documents is not in the app yet.") }
        } else {
            Section {
                DatePicker("Day of the test", selection: $testDay, in: ...Date.now, displayedComponents: .date)
                if review.reportDay == nil {
                    Text("The report does not print a full date. Check the day before saving.").font(.footnote).foregroundStyle(.orange)
                }
            }
            Section("Values found") {
                ForEach(review.items) { item in
                    Toggle(isOn: binding(item.ref)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.label)
                            Text("\(item.value) \(item.unit)").font(.body.monospacedDigit())
                            if let day = item.day { Text("Dated \(DayText.short(day)) on the report").font(.caption).foregroundStyle(.secondary) }
                            if item.check { Text("Check this value against the report").font(.caption).foregroundStyle(.orange) }
                        }
                    }
                }
            }
            if !review.notSaved.isEmpty || review.unreadCount > 0 {
                Section("Not saved") {
                    ForEach(review.notSaved, id: \.label) { Text("\($0.label): \($0.reason)") }
                    if review.unreadCount > 0 { Text("\(review.unreadCount) value\(review.unreadCount == 1 ? "" : "s") could not be read.") }
                }
            }
        }
    }

    private func binding(_ ref: String) -> Binding<Bool> {
        Binding(get: { ticked.contains(ref) }, set: { on in if on { ticked.insert(ref) } else { ticked.remove(ref) } })
    }

    private func load() {
        guard review == nil, let json = result.extractionJSON else { return }
        do {
            let loaded = try engine.labReview(extractionJSON: json, now: .now)
            review = loaded
            ticked = Set(loaded.items.map(\.ref))
            if let day = loaded.reportDay, let date = Self.localDate(day) { testDay = date }
        } catch {
            problem = error.localizedDescription
        }
    }

    private func save() {
        guard let json = result.extractionJSON else { return }
        let refs = review?.items.map(\.ref).filter { ticked.contains($0) } ?? []
        let day = DayText.iso(testDay)
        problem = nil
        do {
            switch try engine.labSaveSummary(recordJSON: store.recordJSON, extractionJSON: json, refs: refs, reportDay: day, now: .now, deviceId: store.deviceId) {
            case .failure(let refusal):
                problem = refusal.message
            case .success(let summary):
                switch store.apply(.labImport(extractionJSON: json, refs: refs, reportDay: day)) {
                case .saved: outcome = Self.describe(summary)
                case .refused(let message, _): problem = message
                }
            }
        } catch {
            problem = error.localizedDescription
        }
    }

    /// Noon on a YYYY-MM-DD day in the phone's zone, for the date picker.
    static func localDate(_ day: String) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        return DayText.gregorian.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }

    static func describe(_ summary: LabSaveSummary) -> String {
        var parts = ["\(summary.saved) value\(summary.saved == 1 ? "" : "s") saved to your record."]
        if summary.skipped > 0 { parts.append("\(summary.skipped) left as they were: that day already had a value.") }
        for refused in summary.refused { parts.append("Not saved, \(refused.label): \(refused.message)") }
        return parts.joined(separator: "\n")
    }
}
