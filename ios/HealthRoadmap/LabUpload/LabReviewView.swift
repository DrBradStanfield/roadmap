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
    /// The engine's groups for the ticks and day held now (US-13 AC13); nil before the first
    /// answer, or from an engine without them (every value is then a row).
    @State private var groups: LabReviewGroups?
    /// Plain view toggles: the sure values shown, the not-saved detail open.
    @State private var showAll = false
    @State private var notSavedOpen = false

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
                // Nothing to save (every value held or not saved): no Save, only the leave button (D3),
                // unless the report's original still waits to be kept in the cloud (AC13d).
                if outcome == nil, let review, review.isLabReport, result.failure == nil, groups == nil || groups?.save != nil || result.original != nil {
                    Button(groups.map { $0.save ?? "Save the original" } ?? "Save") { Task { await save() } }
                        .fontWeight(.semibold)
                        .disabled(saving || choices.wrappedValue.valuesWait(review) != nil || (groups?.saveRefs.isEmpty == true && result.original == nil))
                }
                if outcome == nil, review?.document != nil, result.failure == nil {
                    Button(choices.wrappedValue.keepDocument || !archiveOnly ? "Save the document" : "Save the original") { Task { await save() } }
                        .fontWeight(.semibold)
                        .disabled(saving || !(choices.wrappedValue.keepDocument || archiveOnly))
                }
                // Held while a save runs: leaving would drop its outcome, and a second save
                // of the same file could start before this one has committed.
                Button(leaveTitle ?? (outcome == nil ? "Skip" : (position.0 < position.1 ? "Next report" : "Done"))) { onDone(saved?.reportOutcome(groups, review: review)) }
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
        // Asked again whenever a tick or the test day changes, and once the review has loaded
        // (a report reopened from save all holds its ticks before its review is read).
        .task(id: review == nil ? nil : held) { await regroup() }
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
                // The summary leads (US-13 AC13).
                if let summary = groups?.summary { Text(summary).font(.headline) }
                DatePicker("Day of the test", selection: choices.testDay, in: ...Date.now, displayedComponents: .date)
                if review.reportDay == nil {
                    Text("The report does not print a full date. Set the day of the test.").font(.footnote).foregroundStyle(Color.status("attention"))
                    Toggle("This is the right day", isOn: choices.dayConfirmed)
                }
                // Values with no day yet wait here, behind the date question; never "will be saved".
                if let groups { ForEach(groups.rows("waiting", of: review)) { valueRow($0) } }
            }
            if let groups {
                groupedSections(review, groups)
            } else {
                // An engine without the groups: every value is a row, and its "Not saved" list, as before.
                Section { ForEach(review.items) { valueRow($0) } }
                let legacy = review.legacyNotSaved
                if !legacy.isEmpty {
                    Section("Not saved") { ForEach(Array(legacy.enumerated()), id: \.offset) { Text($0.element) } }
                }
            }
        }
    }

    /// Rows only for the values the engine is unsure of; the sure ones behind Show all; the
    /// held count; what will not be saved, behind one line (US-13 AC13, D3, D5).
    @ViewBuilder
    private func groupedSections(_ review: LabReview, _ groups: LabReviewGroups) -> some View {
        if let check = groups.check {
            Section {
                ForEach(groups.rows("unsure", of: review)) { item in
                    if let conflict = groups.conflict(item.ref) {
                        // The saved value stays (Q2a): no toggle, it is never written.
                        valueText(item, note: conflict)
                    } else {
                        // A value outside its range says why the save will refuse it.
                        valueRow(item, note: groups.refusal(item.ref))
                    }
                }
            } header: {
                Text(check.title)
            } footer: {
                Text(check.footer)
            }
        }
        if groups.sure != nil || groups.alreadySaved != nil {
            Section {
                if let sure = groups.sure {
                    Text(sure.willSave)
                    if showAll { ForEach(groups.rows("sure", of: review)) { valueRow($0) } }
                    Button(showAll ? sure.hide : sure.showAll) {
                        if !showAll { analytics?.event(.labReviewShowAll) }
                        withAnimation { showAll.toggle() }
                    }
                }
                if let alreadySaved = groups.alreadySaved { Text(alreadySaved).foregroundStyle(.secondary) }
            }
        }
        if let notSaved = groups.notSaved {
            Section {
                DisclosureGroup(isExpanded: notSavedBinding) {
                    ForEach(Array(notSaved.lines.enumerated()), id: \.offset) { Text($0.element).font(.footnote) }
                    Text(notSaved.footer).font(.footnote).foregroundStyle(.secondary)
                } label: {
                    Text(notSaved.title)
                }
            }
        }
    }

    /// One value with its tick (today's row): unticking it keeps it out of the save.
    private func valueRow(_ item: LabReview.Item, note: String? = nil) -> some View {
        Toggle(isOn: binding(item.ref)) { valueText(item, note: note) }
            .disabled(saving)
    }

    @ViewBuilder
    private func valueText(_ item: LabReview.Item, note: String?) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(item.label)
            Text("\(item.value) \(item.unit)").font(.body.monospacedDigit())
            if let day = item.day { Text("Dated \(DayText.short(day)) on the report").font(.caption).foregroundStyle(.secondary) }
            // The status tone, not system orange: AA contrast as caption text, light and dark.
            if let note {
                Text(note).font(.caption).foregroundStyle(Color.status("attention"))
            } else if let question = item.question {
                Text("\(question) Tick it only if so.").font(.caption).foregroundStyle(Color.status("attention"))
            } else if item.check {
                Text("Check this value and its unit against the report").font(.caption).foregroundStyle(Color.status("attention"))
            }
        }
    }

    private var notSavedBinding: Binding<Bool> {
        Binding(get: { notSavedOpen }, set: { open in
            if open && !notSavedOpen { analytics?.event(.labReviewNotSavedOpened) }
            notSavedOpen = open
        })
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
                set: { on in
                    if on { choices.wrappedValue.ticked.insert(ref) } else {
                        analytics?.event(.labReviewUntick)
                        choices.wrappedValue.ticked.remove(ref)
                    }
                })
    }

    /// Asks the engine for the groups of the ticks and day held now (lab reports only).
    private func regroup() async {
        guard let review, review.isLabReport, result.failure == nil, let held else { return }
        // A failed answer keeps the groups shown; a newer tick may have asked again meanwhile,
        // so only the answer for what is held now is kept.
        do {
            let asked = try await LabReportSave.groups(result, review: review, choices: held, engine: engine, store: store)
            if !Task.isCancelled, held == self.held { groups = asked }
        } catch {}
    }

    private func load() async {
        guard review == nil, let json = result.extractionJSON else { return }
        do {
            let loaded = try await engine.labReview(extractionJSON: json, now: .now, recordJSON: store.readable?.json ?? "", sourceFileName: result.name,
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
        problem = nil
        saving = true
        defer { saving = false }
        // Asked for the ticks held at the tap, so a tick a moment before Save is never lost.
        let picked = choices.wrappedValue
        var fresh: LabReviewGroups?
        if let review, review.isLabReport {
            // An engine that cannot answer for these ticks saves nothing on an older answer.
            do { fresh = try await LabReportSave.groups(result, review: review, choices: picked, engine: engine, store: store) } catch {
                problem = "These values could not be saved."
                return
            }
        }
        let plan = LabSavePlan(result: result, review: review, choices: picked, archiveOnly: archiveOnly)
        if case .nothing = plan { return }
        // AC8b's usage signal: once per Save on an upload save all could take, nothing with it.
        if let event = Analytics.Event.saveOne(inUploadOf: position.1) { analytics?.event(event) }
        saved = await LabReportSave.run(plan, result: result, store: store, groups: fresh)
    }
}
