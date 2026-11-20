import SwiftUI

/// The one review page for a whole upload (design PR 15, US-52 AC8c, US-13 AC13, AC14): drawn
/// only from the engine's view, results filling in as each file is read, one Save. Every tap is
/// one engine event (`send`); the page holds no rule, no mode and no word of its own, and draws
/// every engine string as plain text (never Markdown; only a letter's body goes through
/// DocumentText). Its local state is plain view state: what is open, a picker's date, a title
/// being typed. The web twin is widget-src/src/components/UploadModal.tsx.
struct UploadReviewView: View {
    let page: UploadPage
    let send: (UploadAction) -> Void
    /// A letter's Markdown, as Save writes it; nil when it cannot be read.
    let letter: (String) async -> String?
    /// The done screen's Done: the sheet closes.
    let finish: () -> Void

    @Environment(\.analytics) private var analytics
    @State private var showAll = false
    /// The documents list, and the letters open in it, by file id.
    @State private var documentsOpen = false
    @State private var openLetters: Set<String> = []
    @State private var notSavedOpen = false
    /// Pickers open by key ("day:<file>" or "date:<file>"), with the date each shows until Done sends it.
    @State private var picking: [String: Picking] = [:]
    /// An open picker: the day tapped (YYYY-MM-DD), nil until one is.
    private struct Picking { var day: String? }
    @State private var titles: [String: String] = [:]
    @State private var letters: [String: String] = [:]

    /// `open`: Show all, the documents list and these letters start open (the design review's shots).
    init(page: UploadPage, send: @escaping (UploadAction) -> Void, letter: @escaping (String) async -> String?,
         open letters: Set<String> = [], finish: @escaping () -> Void) {
        self.page = page
        self.send = send
        self.letter = letter
        self.finish = finish
        _showAll = State(initialValue: !letters.isEmpty)
        _documentsOpen = State(initialValue: !letters.isEmpty)
        _openLetters = State(initialValue: letters)
    }

    var body: some View {
        List {
            if let done = page.done {
                // Saved: the result, the files, and Done; the review's rows are gone.
                Section {
                    Text(verbatim: done.line).font(.headline)
                    if let archived = done.archived { Text(verbatim: archived) }
                    if let unstored = done.unstored { Text(verbatim: unstored).foregroundStyle(.secondary) }
                }
                Section { filesRow }
            } else {
                Section {
                    Text(verbatim: page.summary)
                        .font(.title3.weight(.semibold))
                        .listRowBackground(Color.clear)
                        .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 0, trailing: 20))
                    if let refused = page.refused {
                        Text(verbatim: refused)
                            .foregroundStyle(Color.status("attention"))
                            .listRowBackground(Color.clear)
                            .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 0, trailing: 20))
                    }
                }
                if let progress = page.progress { progressSection(progress) }
                // Every choice waits while a Save runs: a control shows only what the view says.
                Group {
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
                }
                .disabled(!editable)
            }
        }
        // Save (or Done) stays in reach at the bottom however long the page is.
        .safeAreaInset(edge: .bottom) { bottomBar }
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
                Text(verbatim: progress.line)
                ProgressView(value: Double(progress.done), total: Double(max(progress.total, 1)))
                    .accessibilityHidden(true)
                if let zip = progress.zip { Text(verbatim: zip).font(.footnote).foregroundStyle(.secondary) }
            }
            .accessibilityElement(children: .combine)
            if let stop = page.stop {
                Button { send(.stop) } label: { Text(verbatim: stop.label) }
                    .accessibilityIdentifier("upload.stop")
            }
        }
    }

    // MARK: Sections that need a decision

    @ViewBuilder
    private func section(_ section: UploadPage.Section) -> some View {
        switch section {
        case .undated(let undated):
            Section {
                Text(verbatim: undated.name)
                if let chosen = undated.chosen, let date = DayText.noon(chosen) {
                    // The picked day, shown and changeable; a change goes to the engine at once.
                    DatePicker(selection: Binding(get: { date }, set: { send(.testDay(fileId: undated.fileId, day: DayText.iso($0))) }),
                               in: ...Date.now, displayedComponents: .date) { Text(verbatim: undated.label) }
                } else {
                    datePicker(key: "day:\(undated.fileId)", label: undated.label, opens: undated.choose ?? undated.label) {
                        send(.testDay(fileId: undated.fileId, day: $0))
                    }
                }
            } header: { Text(verbatim: undated.title) }
        case .unsure(let title, let footer, let rows):
            Section {
                ForEach(rows) { valueRow($0) }
            } header: { Text(verbatim: title) } footer: { Text(verbatim: footer) }
        case .failed(let title, let rows, let retry):
            Section {
                ForEach(rows) { fileLine($0.name, $0.line) }
                if let retry {
                    Button { send(.retryAll) } label: { Text(verbatim: retry) }.accessibilityIdentifier("upload.retry")
                }
            } header: { Text(verbatim: title) }
        case .notSaved(let title, let lines, let footer):
            Section {
                DisclosureGroup(isExpanded: opened($notSavedOpen, .labReviewNotSavedOpened)) {
                    ForEach(Array(lines.enumerated()), id: \.offset) { Text(verbatim: $0.element).font(.footnote) }
                    Text(verbatim: footer).font(.footnote).foregroundStyle(.secondary)
                } label: { Text(verbatim: title) }
            }
        case .other:
            EmptyView()
        }
    }

    /// One value: its words, then its tick, or Replace when the record holds that day's value.
    @ViewBuilder
    private func valueRow(_ row: UploadPage.ValueRow) -> some View {
        if let replace = row.replace, let held = row.replaces {
            VStack(alignment: .leading, spacing: 8) {
                valueText(row)
                // What the record holds that day, beside the switch, as the web's conflict cell shows it.
                if let held = row.held { Text(verbatim: held).font(.body.monospacedDigit()).foregroundStyle(.secondary) }
                Toggle(isOn: Binding(get: { row.replacing ?? false }, set: { on in
                    send(.replace(fileId: row.fileId, ref: row.ref, correctsId: on ? held : nil))
                })) { Text(verbatim: replace) }
                    .accessibilityLabel(Text(verbatim: row.replaceLabel ?? replace))
            }
        } else if row.conflict != nil {
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
            Text(verbatim: row.label)
            if let value = row.value { Text(verbatim: [value, row.unit ?? ""].filter { !$0.isEmpty }.joined(separator: " ")).font(.body.monospacedDigit()) }
            // The day it saves on, so the same test from two reports is told apart.
            if let dayLine = row.dayLine { Text(verbatim: dayLine).font(.caption).foregroundStyle(.secondary) }
            ForEach([row.question, row.unitNote].compactMap { $0 }, id: \.self) { Text(verbatim: $0).font(.caption).foregroundStyle(.secondary) }
            // The status tone, not system orange: AA contrast as caption text, light and dark.
            ForEach([row.conflict, row.error].compactMap { $0 }, id: \.self) {
                Text(verbatim: $0).font(.caption).foregroundStyle(Color.status("attention"))
            }
        }
        .accessibilityElement(children: .combine)
    }

    private func fileLine(_ name: String, _ line: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(verbatim: name)
            Text(verbatim: line).font(.footnote).foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }

    // MARK: What Save writes

    private func sureRow(_ sure: UploadPage.Sure) -> some View {
        DisclosureGroup(isExpanded: opened($showAll, .labReviewShowAll)) {
            ForEach(sure.rows) { valueRow($0) }
        } label: {
            let toggle = showAll ? sure.hide ?? sure.showAll : sure.showAll
            ViewThatFits(in: .horizontal) {
                HStack { Text(verbatim: sure.line); Spacer(); Text(verbatim: toggle).foregroundStyle(.tint) }
                VStack(alignment: .leading, spacing: 2) { Text(verbatim: sure.line); Text(verbatim: toggle).foregroundStyle(.tint) }
            }
        }
    }

    /// Every new letter, saved by default (Q3 a): each opens to its title, kind, date and text, drawn
    /// as its saved page is (`DocumentText`), never raw Markdown.
    private func documentsRow(_ documents: UploadPage.Documents) -> some View {
        DisclosureGroup(isExpanded: $documentsOpen) {
            ForEach(documents.rows) { document in
                DisclosureGroup(isExpanded: Binding(get: { openLetters.contains(document.fileId) }, set: { open in
                    if open { openLetters.insert(document.fileId) } else { openLetters.remove(document.fileId) }
                })) {
                    letterBody(document, documents)
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: document.title)
                        Text(verbatim: document.kind).font(.footnote).foregroundStyle(.secondary)
                        Text(verbatim: document.date).font(.footnote).foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } label: { Text(verbatim: documents.line) }
    }

    @ViewBuilder
    private func letterBody(_ document: UploadPage.Document, _ documents: UploadPage.Documents) -> some View {
        TextField(document.title, text: title(document))
            .onSubmit { commitTitles() }
            .onDisappear { if editable { commitTitles() } }
            .submitLabel(.done)
            .analyticsMasked()
            .accessibilityLabel(Text(verbatim: document.title))
        if let kinds = documents.kinds, let key = document.kindKey {
            Picker(selection: Binding(get: { key }, set: { send(.kind(fileId: document.fileId, key: $0)) })) {
                ForEach(kinds) { Text(verbatim: $0.word).tag($0.key) }
            } label: { Text(verbatim: document.kind) }
            .labelsHidden()
        }
        if document.dateKnown, let day = document.day, let date = DayText.noon(day) {
            DatePicker(selection: Binding(get: { date }, set: { send(.documentDate(fileId: document.fileId, day: DayText.iso($0))) }),
                       in: ...Date.now, displayedComponents: .date) { Text(verbatim: document.date) }
                .labelsHidden()
            if let remove = documents.removeDate {
                Button { send(.documentDate(fileId: document.fileId, day: nil)) } label: { Text(verbatim: remove) }
            }
        } else if let set = documents.setDate {
            datePicker(key: "date:\(document.fileId)", label: document.date, opens: set) { send(.documentDate(fileId: document.fileId, day: $0)) }
        }
        if let markdown = letters[document.fileId] {
            DocumentText(markdown: markdown, title: document.title)
        } else {
            ProgressView()
                .frame(maxWidth: .infinity)
                .task { if let text = await letter(document.fileId) { letters[document.fileId] = text } }
        }
    }

    /// A day the person picks: closed, a button in the view's words; open, a calendar and Done,
    /// which sends the day picked. Done waits until a day is tapped: no day is assumed.
    @ViewBuilder
    private func datePicker(key: String, label: String, opens: String, choose: @escaping (String) -> Void) -> some View {
        if let open = picking[key] {
            // Opens with no day selected: one tap on any day, today included, enables Done.
            DayCalendar(picked: { picking[key] = .init(day: $0) }, label: label)
            if let done = page.doneLabel {
                Button {
                    picking[key] = nil
                    if let day = open.day { choose(day) }
                } label: { Text(verbatim: done) }
                .disabled(open.day == nil)
            }
        } else {
            Button { picking[key] = .init(day: nil) } label: { Text(verbatim: opens) }
        }
    }

    private var filesRow: some View {
        DisclosureGroup {
            ForEach(page.files.rows) { fileLine($0.name, $0.status) }
        } label: { Text(verbatim: page.files.row) }
    }

    /// Save with why it waits or why it failed, or Done once saved: the page's one filled button
    /// (the app's accent style, OnAccent text, AA in dark mode too), a fixed width on a wide screen.
    @ViewBuilder private var bottomBar: some View {
        VStack(spacing: 6) {
            if page.done != nil, let label = page.doneLabel {
                Button(action: finish) { Text(verbatim: label) }
                    .buttonStyle(.accent)
                    .accessibilityIdentifier("upload.done")
            } else {
                Button {
                    // A title still being typed goes first: the events step in the order sent.
                    if editable { commitTitles() }
                    send(.save)
                } label: { Text(verbatim: page.save.label) }
                    .buttonStyle(.accent)
                    .disabled(!page.save.enabled)
                    .accessibilityIdentifier("upload.save")
                if let why = page.save.why { Text(verbatim: why).font(.footnote).foregroundStyle(.secondary) }
                if let error = page.save.error { Text(verbatim: error).font(.footnote).foregroundStyle(Color.status("attention")) }
            }
        }
        .frame(maxWidth: 400)
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    /// The view says the choices can change; an older view that does not say lets them.
    private var editable: Bool { page.editable ?? true }

    // MARK: Plain view state

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
