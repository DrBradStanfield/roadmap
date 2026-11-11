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
    /// Sends the report again after a failure that may mend (US-52 AC7a); nil: none.
    var tryAgain: (() -> Void)? = nil
    /// The report's choices, held by the sheet so save all keeps them (AC8b); nil until first shown.
    @Binding var held: LabChoices?
    /// Save all, while two or more reports wait (US-52 AC8b); nil: not offered.
    var saveAll: (title: String, action: () -> Void)? = nil
    /// The leave button's words when it does not go on to the next report (a review opened
    /// from the save-all summary goes back to it, AC8b); nil: Skip, Next report or Done.
    var leaveTitle: String? = nil
    /// Skip, Next report or Done, with what this report's own Save did (nil: it did not run).
    let onDone: (ReportOutcome?) -> Void

    @Environment(\.analytics) private var analytics
    @State private var review: LabReview?
    /// This report's own Save, once it ran.
    @State private var saved: LabReportSave?
    /// Why the review could not be read.
    @State private var problem: String?

    /// What was saved, in the review's words; nil until a save wrote something.
    private var outcome: String? { saved?.outcome }

    private var choices: Binding<LabChoices> {
        Binding(get: { held ?? LabChoices() }, set: { held = $0 })
    }

    var body: some View {
        Form {
            Section {
                Text(result.name).font(.headline)
                if position.1 > 1 { Text("Report \(position.0) of \(position.1)").foregroundStyle(.secondary) }
                if result.truncated { Text("Only the first 20 pages were read.").foregroundStyle(.secondary) }
            }
            if let failure = result.failure {
                Section {
                    Text(failure)
                    if let tryAgain { Button("Try again", systemImage: "arrow.clockwise", action: tryAgain) }
                }
            } else if let review {
                reviewSections(review)
            }
            if let problem = problem ?? saved?.problem { Section { Text(problem).foregroundStyle(.red) } }
            if let outcome { Section("Saved") { Text(outcome) } }
            Section {
                if outcome == nil, let review, review.isLabReport, result.failure == nil {
                    let count = choices.wrappedValue.ticked.count
                    Button("Save \(count) value\(count == 1 ? "" : "s")") { Task { await save() } }
                        .fontWeight(.semibold)
                        .disabled(saving || choices.wrappedValue.valuesWait(review) != nil)
                }
                if outcome == nil, review?.document != nil, result.failure == nil {
                    Button(choices.wrappedValue.keepDocument || !archiveOnly ? "Save the document" : "Save the original") { Task { await save() } }
                        .fontWeight(.semibold)
                        .disabled(saving || !(choices.wrappedValue.keepDocument || archiveOnly))
                }
                // Held while a save runs: leaving would drop its outcome, and a second save
                // of the same file could start before this one has committed.
                Button(leaveTitle ?? (outcome == nil ? "Skip" : (position.0 < position.1 ? "Next report" : "Done"))) { onDone(saved?.reportOutcome) }
                    .disabled(saving)
            }
            // Its own group under this report's Save: it acts on every waiting report, not this one.
            if outcome == nil, let saveAll {
                let after = position.1 - position.0
                Section {
                    Button(saveAll.title, action: saveAll.action).fontWeight(.semibold).disabled(saving)
                } footer: {
                    Text("Saves this report and the \(after == 1 ? "one" : "\(after)") after it, as they stand. A value with a question stays out unless you tick it.")
                }
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
        LabSavePlan.archiveOnly(review, result: result, cloudConnected: store.cloudErase != nil)
    }

    @ViewBuilder
    private func reviewSections(_ review: LabReview) -> some View {
        if let document = review.document {
            documentCard(document)
        } else if !review.isLabReport {
            Section { Text("No blood test values or document were found in this file.") }
        } else {
            Section {
                DatePicker("Day of the test", selection: choices.testDay, in: ...Date.now, displayedComponents: .date)
                if review.reportDay == nil {
                    Text("The report does not print a full date. Set the day of the test.").font(.footnote).foregroundStyle(.orange)
                    Toggle("This is the right day", isOn: choices.dayConfirmed)
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
                                // The status tone, not system orange: AA contrast as caption text, light and dark.
                                Text("\(question) Tick it only if so.").font(.caption).foregroundStyle(Color.status("attention"))
                            } else if item.check {
                                Text("Check this value and its unit against the report").font(.caption).foregroundStyle(.orange)
                            }
                        }
                    }
                }
            }
            if !review.notSaved.isEmpty || review.unreadCount > 0 {
                Section("Not saved") {
                    ForEach(Array(review.notSaved.enumerated()), id: \.offset) { Text("\($0.element.label): \($0.element.reason)") }
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
            Toggle("Save this document", isOn: choices.keepDocument)
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
            TextField("Document title", text: choices.documentTitle, axis: .vertical).analyticsMasked()
            if choices.wrappedValue.documentDateKnown {
                DatePicker("Date", selection: choices.documentDate, in: ...Date.now, displayedComponents: .date)
                Button("Date unknown") { choices.wrappedValue.documentDateKnown = false }
            } else {
                LabeledContent("Date", value: "Date unknown")
                Button("Set the date") { choices.wrappedValue.documentDateKnown = true }
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

    private func binding(_ ref: String) -> Binding<Bool> {
        Binding(get: { choices.wrappedValue.ticked.contains(ref) },
                set: { on in if on { choices.wrappedValue.ticked.insert(ref) } else { choices.wrappedValue.ticked.remove(ref) } })
    }

    private func load() async {
        guard review == nil, let json = result.extractionJSON else { return }
        do {
            let loaded = try await engine.labReview(extractionJSON: json, now: .now, recordJSON: store.recordJSON, sourceFileName: result.name,
                                              contentHash: result.original?.contentHash ?? "", deviceId: store.deviceId)
            review = loaded
            // A report shown before keeps what the person chose on it (AC8b).
            if held == nil { held = LabChoices(review: loaded) }
        } catch {
            problem = error.localizedDescription
        }
    }

    /// The report's own Save: its values (then its original) or its document.
    private func save() async {
        guard !saving else { return }
        let plan = LabSavePlan(result: result, review: review, choices: choices.wrappedValue, archiveOnly: archiveOnly)
        if case .nothing = plan { return }
        saving = true
        defer { saving = false }
        analytics?.event(.labSaveOne)  // AC8b's usage signal: once per Save, nothing with it
        saved = await LabReportSave.run(plan, result: result, store: store)
    }
}
