import SwiftUI

/// The extracted values for the user to confirm (US-52 AC8). Each shows its day;
/// values without one take the test's day, which the user can change and must pick
/// when the report printed none. Only ticked values are written, by the engine's
/// `labImport` edit (health-core's bulkAppendValues). A letter or other document
/// shows the web's card instead (AC13d): keep it or not, its title and date, its
/// kind and a preview; it is filed by health-core's saveDocuments, the original in
/// the person's cloud when one is connected. A lab report's original is kept there
/// too. The web twin is widget-src/src/components/ReviewTable.tsx.
struct LabReviewView: View {
    let engine: HealthEngine
    let store: RecordStore
    let result: LabResult
    let position: (Int, Int)
    /// A save is under way; the sheet around the review holds its Close too.
    @Binding var saving: Bool
    let onDone: () -> Void

    @State private var review: LabReview?
    @State private var ticked: Set<String> = []
    @State private var testDay = Date.now
    /// The report printed no full day: Save waits until the user says the day is right (US-13 AC8's rule).
    @State private var dayConfirmed = false
    @State private var outcome: String?
    @State private var problem: String?
    /// The document card (AC13d): kept unless the record already holds one from this file.
    @State private var keepDocument = false
    @State private var documentTitle = ""
    @State private var documentDateKnown = false
    @State private var documentDate = Date.now

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
                    Button("Save \(ticked.count) value\(ticked.count == 1 ? "" : "s")") { Task { await save() } }
                        .disabled(saving || ticked.isEmpty || (review?.reportDay == nil && !dayConfirmed && needsTestDay))
                }
                if outcome == nil, review?.document != nil, result.failure == nil {
                    Button(keepDocument || !archiveOnly ? "Save the document" : "Save the original") { Task { await saveDocument() } }
                        .disabled(saving || !(keepDocument || archiveOnly))
                }
                // Held while a save runs: leaving would drop its outcome, and a second save
                // of the same file could start before this one has committed.
                Button(outcome == nil ? "Skip" : (position.0 < position.1 ? "Next report" : "Done")) { onDone() }
                    .disabled(saving)
            }
        }
        // Values and documents are checked against the record this review opened on: an
        // erase that arrives meanwhile refuses the save (the sheets' rule, US-25 AC11).
        .onAppear { store.pinScreen() }
        .task { await load() }
        .onDisappear { store.unpinScreen() }
    }

    /// The web's archive-only path (US-14 AC4, US-35 AC8): a document whose bytes a held
    /// metadata-only row stands for has its original filed behind that row, with the
    /// card's title and date, even when the keep tick is off.
    private var archiveOnly: Bool {
        review?.document?.held == true && store.cloudErase != nil && result.original != nil
    }

    @ViewBuilder
    private func reviewSections(_ review: LabReview) -> some View {
        if let document = review.document {
            documentCard(document)
        } else if !review.isLabReport {
            Section { Text("No blood test values or document were found in this file.") }
        } else {
            Section {
                DatePicker("Day of the test", selection: $testDay, in: ...Date.now, displayedComponents: .date)
                if review.reportDay == nil {
                    Text("The report does not print a full date. Set the day of the test.").font(.footnote).foregroundStyle(.orange)
                    Toggle("This is the right day", isOn: $dayConfirmed)
                }
            }
            Section("Values found") {
                ForEach(review.items) { item in
                    Toggle(isOn: binding(item.ref)) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(item.label)
                            Text("\(item.value) \(item.unit)").font(.body.monospacedDigit())
                            if let day = item.day { Text("Dated \(DayText.short(day)) on the report").font(.caption).foregroundStyle(.secondary) }
                            if let question = item.question {
                                Text("\(question) Tick it only if so.").font(.caption).foregroundStyle(.orange)
                            } else if item.check {
                                Text("Check this value and its unit against the report").font(.caption).foregroundStyle(.orange)
                            }
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

    /// The web's document card: the keep tick, an editable title and date, the kind as a
    /// read-only badge, and the first 300 characters of the text.
    @ViewBuilder
    private func documentCard(_ document: LabReview.Document) -> some View {
        Section {
            Toggle("Save this document", isOn: $keepDocument)
            if document.alreadySaved {
                Text("Already saved: your record has a document from this file. Tick it to save it again.")
                    .font(.footnote).foregroundStyle(.secondary)
            }
            LabeledContent("Kind") {
                Text(document.classification.replacingOccurrences(of: "_", with: " ").capitalized)
                    .font(.footnote.weight(.semibold))
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .background(Color.purple.opacity(0.15), in: Capsule())
            }
            TextField("Document title", text: $documentTitle, axis: .vertical).analyticsMasked()
            if documentDateKnown {
                DatePicker("Date", selection: $documentDate, in: ...Date.now, displayedComponents: .date)
                Button("Date unknown") { documentDateKnown = false }
            } else {
                LabeledContent("Date", value: "Date unknown")
                Button("Set the date") { documentDateKnown = true }
            }
        } header: {
            SectionTitle(title: "Document", symbol: "doc.text.fill", tint: .purple)
        } footer: {
            Text(store.cloudErase == nil ? "Saved to your record as text. With a cloud connected in Sync, the original file is kept there too."
                 : result.original != nil ? "Saved to your record, with the original file kept in your cloud."
                 : "Saved to your record as text.")
        }
        if !document.preview.isEmpty {
            Section("Preview") {
                Text(document.preview).font(.footnote).foregroundStyle(.secondary)
            }
        }
    }

    /// A ticked value with no day of its own takes the test's day.
    private var needsTestDay: Bool {
        review?.items.contains { ticked.contains($0.ref) && $0.day == nil } ?? false
    }

    private func binding(_ ref: String) -> Binding<Bool> {
        Binding(get: { ticked.contains(ref) }, set: { on in if on { ticked.insert(ref) } else { ticked.remove(ref) } })
    }

    private func load() async {
        guard review == nil, let json = result.extractionJSON else { return }
        do {
            let loaded = try await engine.labReview(extractionJSON: json, now: .now, recordJSON: store.recordJSON, sourceFileName: result.name,
                                              contentHash: result.original?.contentHash ?? "", deviceId: store.deviceId)
            review = loaded
            if let document = loaded.document {
                keepDocument = !document.alreadySaved
                documentTitle = document.title
                if let day = document.documentDate, let date = DayText.noon(day) {
                    documentDateKnown = true
                    documentDate = date
                }
            }
            // A value the extractor asked about starts unticked: never saved unnoticed.
            ticked = Set(loaded.items.filter { $0.question == nil }.map(\.ref))
            if let day = loaded.reportDay, let date = DayText.noon(day) { testDay = date }
        } catch {
            problem = error.localizedDescription
        }
    }

    private func save() async {
        guard let json = result.extractionJSON, !saving else { return }
        saving = true
        defer { saving = false }
        let refs = review?.items.map(\.ref).filter { ticked.contains($0) } ?? []
        let day = DayText.iso(testDay)
        problem = nil
        switch await store.importLabs(extractionJSON: json, refs: refs, reportDay: day) {
        case .failure(let refusal):
            problem = refusal.message
        case .success(let summary):
            outcome = Self.describe(summary)
            await keepOriginal(json, day: day)
        }
    }

    /// The lab report's original, kept in the cloud as the web's hidden row (the engine
    /// keeps it only there); the values are already saved.
    private func keepOriginal(_ json: String, day: String) async {
        guard let original = result.original else { return }
        let choice = DocumentChoice(kind: .labArchive, sourceFileName: result.name, reportDay: day, mimeType: original.mimeType, contentHash: original.contentHash)
        switch await store.saveDocument(extractionJSON: json, choice: choice, original: original) {
        case .saved(let count, let stored, let unstored, let stale):
            let line = Self.originalLine(count: count, stored: stored, unstored: unstored, stale: stale, kept: "The original report is kept in your cloud.")
            outcome = [outcome, line].compactMap { $0 }.joined(separator: "\n")
        case .refused(let message):
            problem = message
        }
    }

    private func saveDocument() async {
        guard let json = result.extractionJSON, keepDocument || archiveOnly, !saving else { return }
        saving = true
        defer { saving = false }
        problem = nil
        let choice = DocumentChoice(kind: .document, sourceFileName: result.name, title: documentTitle,
                                    documentDate: documentDateKnown ? DayText.iso(documentDate) : nil,
                                    mimeType: result.original?.mimeType ?? "", contentHash: result.original?.contentHash)
        switch await store.saveDocument(extractionJSON: json, choice: choice, original: result.original) {
        case .saved(let count, let stored, let unstored, let stale):
            let first = count > 0 ? "The document is saved to your record." : "Your record already holds this file, so nothing new was saved."
            let line = Self.originalLine(count: count, stored: stored, unstored: unstored, stale: stale, kept: "The original file is kept in your cloud.")
            outcome = [first, line].compactMap { $0 }.joined(separator: "\n")
        case .refused(let message):
            problem = message
        }
    }

    /// What a save says of the original: `kept` when the cloud took it; that it changed
    /// since the review read it; the web's words (US-14 AC4) when the cloud did not take
    /// it; nothing when none was offered or nothing was new.
    static func originalLine(count: Int, stored: Bool?, unstored: Int, stale: Bool, kept: String) -> String? {
        if stale { return "The original changed or could not be read, so only its text was saved." }
        return switch stored {
        case true?: kept
        case false? where count > 0 || unstored > 0: "The original file couldn't be stored; its details are saved."
        default: nil
        }
    }

    static func describe(_ summary: LabSaveSummary) -> String {
        var parts = ["\(summary.saved) value\(summary.saved == 1 ? "" : "s") saved to your record."]
        if summary.skipped > 0 { parts.append("\(summary.skipped) left as they were: that day already had a value.") }
        for refused in summary.refused { parts.append("Not saved, \(refused.label): \(refused.message)") }
        return parts.joined(separator: "\n")
    }
}
