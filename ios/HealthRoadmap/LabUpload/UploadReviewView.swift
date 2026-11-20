import SwiftUI

/// The one review page for a whole upload (design PR 15, US-52 AC8c, US-13 AC13, AC14): drawn
/// only from the engine's view, results filling in as each file is read, one Save. Every tap is
/// one engine event (`send`); the page holds no rule, no mode and no word of its own. Its local
/// state is plain view state: what is expanded, a picker's date, a title being typed.
/// The web twin is widget-src/src/components/UploadModal.tsx.
struct UploadReviewView: View {
    let page: UploadPage
    let send: (UploadAction) -> Void
    /// A letter's Markdown, as Save writes it; nil when it cannot be read.
    let letter: (String) async -> String?
    /// The done screen's Done (the app's word): the sheet closes.
    let finish: () -> Void

    @Environment(\.analytics) private var analytics
    @State private var showAll = false
    @State private var notSavedOpen = false
    @State private var testDays: [String: Date] = [:]
    @State private var titles: [String: String] = [:]
    @State private var letters: [String: String] = [:]

    var body: some View {
        List {
            if let done = page.done {
                // Saved: the result, the files, and Done; the review's rows are gone.
                Section {
                    Text(done.line).font(.headline)
                    if let archived = done.archived { Text(archived) }
                    if let unstored = done.unstored { Text(unstored).foregroundStyle(.secondary) }
                }
                Section { filesRow }
                bottomButton("Done", enabled: true, identifier: "upload.done", action: finish)
            } else {
                Section {
                    Text(page.summary)
                        .font(.title3.weight(.semibold))
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 0, trailing: 20))
                }
                if let progress = page.progress { progressSection(progress) }
                ForEach(page.sections) { section($0) }
                if !page.notices.isEmpty {
                    Section { ForEach(page.notices) { fileLine($0.name, $0.line) } }
                }
                // What Save writes, collapsed, in one card.
                Section {
                    if let sure = page.sure { sureRow(sure) }
                    if let documents = page.documents { documentsRow(documents) }
                    filesRow
                }
                saveSection
            }
        }
        // Wide screens (iPad): a readable column, not rows stretched across the page.
        .frame(maxWidth: 700)
        .frame(maxWidth: .infinity)
        .background(Color(.systemGroupedBackground))
        .accessibilityIdentifier("upload.review")
    }

    // MARK: Progress

    private func progressSection(_ progress: UploadPage.Progress) -> some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Text(progress.line)
                ProgressView(value: Double(progress.done), total: Double(max(progress.total, 1)))
                    .accessibilityHidden(true)
                if let zip = progress.zip { Text(zip).font(.footnote).foregroundStyle(.secondary) }
            }
            .accessibilityElement(children: .combine)
            if let stop = page.stop {
                Button(stop.label) { send(.stop) }
                    .accessibilityIdentifier("upload.stop")
            }
        }
    }

    // MARK: Sections that need a decision

    @ViewBuilder
    private func section(_ section: UploadPage.Section) -> some View {
        switch section {
        case .undated(let fileId, let title, let label, let name):
            Section {
                Text(name)
                DatePicker(label, selection: testDay(fileId), in: ...Date.now, displayedComponents: .date)
            } header: { Text(title) }
        case .unsure(let title, let footer, let rows):
            Section {
                ForEach(rows) { valueRow($0) }
            } header: { Text(title) } footer: { Text(footer) }
        case .failed(let title, let rows, let retry):
            Section {
                ForEach(rows) { fileLine($0.name, $0.line) }
                if let retry {
                    Button(retry) { send(.retryAll) }.accessibilityIdentifier("upload.retry")
                }
            } header: { Text(title) }
        case .notSaved(let title, let lines, let footer):
            Section {
                DisclosureGroup(isExpanded: opened($notSavedOpen, .labReviewNotSavedOpened)) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { Text($0.element).font(.footnote) }
                    Text(footer).font(.footnote).foregroundStyle(.secondary)
                } label: { Text(title) }
            }
        case .other:
            EmptyView()
        }
    }

    /// One value with its tick. A conflict keeps the saved value (Q2a): its line, no tick.
    @ViewBuilder
    private func valueRow(_ row: UploadPage.ValueRow) -> some View {
        if row.conflict != nil {
            valueText(row)
        } else {
            Toggle(isOn: Binding(get: { row.ticked }, set: { on in
                if !on { analytics?.event(.labReviewUntick) }
                send(.tick(fileId: row.fileId, ref: row.ref, on: on))
            })) { valueText(row) }
        }
    }

    private func valueText(_ row: UploadPage.ValueRow) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(row.label)
            // The status tone, not system orange: AA contrast as caption text, light and dark.
            ForEach([row.conflict, row.error].compactMap { $0 }, id: \.self) {
                Text($0).font(.caption).foregroundStyle(Color.status("attention"))
            }
        }
    }

    private func fileLine(_ name: String, _ line: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(name)
            Text(line).font(.footnote).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: What Save writes

    private func sureRow(_ sure: UploadPage.Sure) -> some View {
        DisclosureGroup(isExpanded: opened($showAll, .labReviewShowAll)) {
            ForEach(sure.rows) { valueRow($0) }
        } label: {
            ViewThatFits(in: .horizontal) {
                HStack { Text(sure.line); Spacer(); Text(sure.showAll).foregroundStyle(.tint) }
                VStack(alignment: .leading, spacing: 2) { Text(sure.line); Text(sure.showAll).foregroundStyle(.tint) }
            }
        }
    }

    /// Every new letter, saved by default (Q3 a): each opens to its title, date and text, drawn as
    /// its saved page is (`DocumentText`), never raw Markdown.
    private func documentsRow(_ documents: UploadPage.Documents) -> some View {
        DisclosureGroup {
            ForEach(documents.rows) { document in
                DisclosureGroup {
                    letterBody(document)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(document.title)
                        Text(document.kind).font(.footnote).foregroundStyle(.secondary)
                        Text(document.date).font(.footnote).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } label: { Text(documents.line) }
    }

    @ViewBuilder
    private func letterBody(_ document: UploadPage.Document) -> some View {
        TextField(document.title, text: title(document))
            .onSubmit { commitTitles() }
            .onDisappear { commitTitles() }
            .submitLabel(.done)
            .analyticsMasked()
            .accessibilityLabel(document.title)
        if document.dateKnown, let date = DayText.noon(document.date) {
            DatePicker(document.date, selection: Binding(get: { date }, set: {
                send(.documentDate(fileId: document.fileId, day: DayText.iso($0)))
            }), in: ...Date.now, displayedComponents: .date)
            .labelsHidden()
        }
        if let markdown = letters[document.fileId] {
            DocumentText(markdown: markdown, title: document.title)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity)
                .task { if let text = await letter(document.fileId) { letters[document.fileId] = text } }
        }
    }

    private var filesRow: some View {
        DisclosureGroup {
            ForEach(page.files.rows) { fileLine($0.name, $0.status) }
        } label: { Text(page.files.row) }
    }

    private var saveSection: some View {
        bottomButton(page.save.label, enabled: page.save.enabled, identifier: "upload.save") {
            analytics?.event(.labSaveAll)  // the one Save of the whole upload; never a count
            commitTitles() // a title still being typed goes first: the events step in the order sent
            send(.save)
        } notes: {
            if let why = page.save.why { Text(why).font(.footnote).foregroundStyle(.secondary) }
            if let error = page.save.error { Text(error).font(.footnote).foregroundStyle(Color.status("attention")) }
        }
    }

    /// The page's one filled button, aligned with the cards (a fixed width on a wide screen), its
    /// notes under it with no divider.
    private func bottomButton(_ label: String, enabled: Bool, identifier: String, action: @escaping () -> Void,
                              @ViewBuilder notes: () -> some View = { EmptyView() }) -> some View {
        Section {
            Group {
                Button(action: action) { Text(label).frame(maxWidth: .infinity, minHeight: 34) }
                    .buttonStyle(.borderedProminent)
                    .disabled(!enabled)
                    .accessibilityIdentifier(identifier)
                    .frame(maxWidth: 400)
                    .frame(maxWidth: .infinity)
                notes().padding(.horizontal, 20).padding(.top, 4)
            }
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 0, bottom: 4, trailing: 0))
        }
    }

    // MARK: Plain view state

    /// A report's day: the picker's own until the person picks one, which goes to the engine.
    private func testDay(_ fileId: String) -> Binding<Date> {
        Binding(get: { testDays[fileId] ?? .now }, set: { day in
            testDays[fileId] = day
            send(.testDay(fileId: fileId, day: DayText.iso(day)))
        })
    }

    private func title(_ document: UploadPage.Document) -> Binding<String> {
        Binding(get: { titles[document.fileId] ?? document.title }, set: { titles[document.fileId] = $0 })
    }

    /// Every title typed and changed goes to the engine, once.
    private func commitTitles() {
        let current = Dictionary(uniqueKeysWithValues: (page.documents?.rows ?? []).map { ($0.fileId, $0.title) })
        for (fileId, typed) in titles where !typed.isEmpty && typed != current[fileId] { send(.title(fileId: fileId, title: typed)) }
        titles = [:]
    }

    /// A disclosure's binding that counts its first opening (never a count or a value).
    private func opened(_ flag: Binding<Bool>, _ event: Analytics.Event) -> Binding<Bool> {
        Binding(get: { flag.wrappedValue }, set: { open in
            if open && !flag.wrappedValue { analytics?.event(event) }
            flag.wrappedValue = open
        })
    }
}
