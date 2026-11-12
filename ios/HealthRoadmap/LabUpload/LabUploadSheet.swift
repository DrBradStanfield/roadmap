import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// "Add medical records" (US-52 AC7–AC13): where the report is (Files, Photos or the
/// camera), then the file read on the phone, then consent before the first send, then
/// each report sent and reviewed. The web twin is widget-src/src/components/UploadModal.tsx.
struct LabUploadSheet: View {
    let engine: HealthEngine
    let store: RecordStore

    @Environment(\.dismiss) private var dismiss
    @Environment(\.analytics) private var analytics
    /// The sheet's one named state, moved only by `send(_:)` (LabUploadFlow).
    @State private var step = Self.firstStep
    #if DEBUG
    private static var firstStep: LabUploadFlow.Step { LabSaveAllDemo.step ?? .choose }
    #else
    private static let firstStep = LabUploadFlow.Step.choose
    #endif
    @State private var importing = false
    @State private var scanning = false
    @State private var picking = false
    @State private var photo: PhotosPickerItem?
    /// A review is saving: the sheet stays open until it lands.
    @State private var reviewSaving = false
    /// The read or send under way, cancelled when the sheet closes (review R1, Codex).
    @State private var work: Task<Void, Never>?
    /// Each report's choices on its review, by report (US-52 AC8b): kept when the review goes,
    /// so save all saves what the person chose; a Try again's new answer starts fresh.
    @State private var held: [UUID: LabChoices] = [:]

    /// Close and swipe-down wait for a save, or for save all (AC8b).
    private var closeHeld: Bool {
        if case .savingAll = step { return true }
        return reviewSaving
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Add medical records")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { work?.cancel(); dismiss() }.disabled(closeHeld) }
                    if case .choose = step, AIConsent.labUpload.given {
                        ToolbarItem(placement: .primaryAction) {
                            Menu {
                                Button("Stop sharing", systemImage: "hand.raised", role: .destructive) {
                                    AIConsent.labUpload.withdraw()
                                    send(.restart)
                                }
                            } label: { Image(systemName: "ellipsis.circle") }
                        }
                    }
                }
        }
        .interactiveDismissDisabled(closeHeld)
        .onDisappear { work?.cancel() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.folder, .pdf, .jpeg, .png, .zip], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first { pick { await read(file: url) } }
        }
        // Presented from the sheet's root, like Files: an inline PhotosPicker row took
        // the whole sheet down with it when a photo was picked (iOS 27, seen 2026-10-22).
        .photosPicker(isPresented: $picking, selection: $photo, matching: .images)
        .onChange(of: photo) {
            guard let item = photo else { return }
            photo = nil
            pick { await read(photo: item) }
        }
        .fullScreenCover(isPresented: $scanning) {
            DocumentScanner { pages in
                scanning = false
                if !pages.isEmpty { pick { await read { [try await LabFileReader.pictures(pages, name: "Scanned report")] } } }
            }
            .ignoresSafeArea()
        }
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .choose:
            chooser
        case .consent(let documents):
            AIConsentView(consent: .labUpload) { start { await send(documents) } }
        case .working(let what, let progress, _):
            VStack {
                LabReadingDiagram(step: what, progress: progress)
                // A way out of a wait that may run to the timeout (AC7a); Close stays too.
                Button("Cancel") { work?.cancel(); send(.cancel) }.buttonStyle(.bordered)
            }
        case .review(let results, let index, let from):
            let result = results[index]
            let waiting = results.count - index
            LabReviewView(engine: engine, store: store, result: result, position: (index + 1, results.count), saving: $reviewSaving,
                          tryAgain: result.retry == nil ? nil : { retry(results, at: index) },
                          held: Binding(get: { held[result.id] }, set: { held[result.id] = $0 }),
                          saveAll: from == nil && waiting >= 2 ? ("Save all (\(waiting) reports)", { saveAll(results, from: index) }) : nil,
                          leaveTitle: from == nil ? nil : "Back to summary") {
                send(.next($0))
            }
            .id(result.id)
        case .savingAll(_, let progress):
            SaveAllProgressView(progress: progress)
        case .saveAllDone(let results, let summary):
            SaveAllSummaryView(results: results, summary: summary, open: { send(.open($0)) }, done: { send(.done) })
        case .failed(let message):
            VStack(spacing: 16) {
                Text(message).multilineTextAlignment(.center)
                Button("Choose another file") { send(.restart) }.buttonStyle(.bordered)
            }
            .padding()
        case .finished:
            EmptyView()
        }
    }

    /// The one way the step moves; the last report done with closes the sheet.
    private func send(_ event: LabUploadFlow.Event) {
        step = LabUploadFlow.transition(step, event)
        if case .finished = step { dismiss() }
    }

    // MARK: Where the report is (AC10)

    /// Files first: it reaches Dropbox, Google Drive and iCloud Drive through their apps,
    /// and hands over only the file picked (Brad 2026-10-25). Then Photos and Scan.
    private var chooser: some View {
        List {
            Section { LabUploadExplainer() }
            Section {
                Button { importing = true } label: {
                    SourceRow(title: "Files", symbol: "folder", detail: "A PDF, photo, ZIP or folder")
                }
                .accessibilityIdentifier("labSource.files")
            } header: {
                Text("Where are your medical records?")
            } footer: {
                Text("Files reaches Dropbox, Google Drive and iCloud Drive when their apps are on this iPhone. The app gets only the file you pick.")
            }
            Section {
                Button { picking = true } label: {
                    SourceRow(title: "Photos", symbol: "photo.on.rectangle", detail: "A photo of a paper report")
                }
                .accessibilityIdentifier("labSource.photos")
                if DocumentScanner.isAvailable {
                    Button { scanning = true } label: {
                        SourceRow(title: "Scan", symbol: "doc.viewfinder", detail: "Use the camera, one page at a time")
                    }
                    .accessibilityIdentifier("labSource.scan")
                }
            }
        }
    }

    /// Runs a read or a send as the sheet's tracked work, which Close cancels. One at a
    /// time: a new one cancels the last, so a late answer never moves the screen (review R1).
    private func start(_ operation: @escaping @MainActor () async -> Void) {
        work?.cancel()
        work = Task { await operation() }
    }

    /// Starts a read from a pick. Only from the sources: a second pick while one is under
    /// way (a double tap) is ignored and never cancels the first (review R6). The screen
    /// moves at the pick, so nothing can slip in before the read starts.
    private func pick(_ operation: @escaping @MainActor () async -> Void) {
        guard case .choose = step else { return }
        send(.picked)
        start(operation)
    }

    // MARK: Reading, on the phone

    /// Reads the report on the phone, then sends it, or asks for consent first.
    /// Nothing leaves the phone for the server before the user agrees. Started by `pick`.
    private func read(_ documents: () async throws -> [LabFileReader.Document]) async {
        do {
            let read = try await documents()
            // Closed or cancelled while it read: nothing is sent (review R1).
            try Task.checkCancellation()
            if AIConsent.labUpload.given {
                await send(read)
            } else {
                send(.needsConsent(read))
            }
        } catch {
            if !Task.isCancelled { send(.failed(error.localizedDescription)) }
        }
    }

    /// A file or folder from Files. The picker's access closes once it is read, before
    /// the engine names it; a folder counts its reports on the reading screen.
    private func read(file url: URL) async {
        await read {
            let read: [LabFileReader.Document]
            do {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                read = try await LabFileReader.decoded(picked: url, progress: { done, total in
                    send(.readProgress(done: done, total: total, at: .now))
                }, ask: { [engine] in await engine.uploadRules(files: $0, members: $1) })
            }
            return await engine.named(read)
        }
    }

    private func read(photo item: PhotosPickerItem) async {
        await read {
            guard let data = try await item.loadTransferable(type: Data.self) else { throw LabFileReader.Failure.unreadable("The photo") }
            return [try await LabFileReader.photo(data)]
        }
    }

    // MARK: Sending, with consent

    private func send(_ documents: [LabFileReader.Document]) async {
        guard AIConsent.labUpload.given else { send(.needsConsent(documents)); return }
        let results = await Self.extractEach(documents, extract: extract) { n, _ in
            send(.sending(n, of: documents, at: .now))
        }
        if let results {
            held = [:]
            send(.extracted(results))
        }
    }

    private func extract(_ document: LabFileReader.Document) async throws -> String {
        try await LabUploadClient().extract(document, unitSystem: store.myData?.unitSystem ?? "si")
    }

    /// Try again (AC7a): the report read on the phone goes again, with no new pick. Cancel
    /// goes back to the review it came from. Tapped only: the app never retries on its own.
    /// The screen moves at the tap, so a same-instant Next or Done cannot be overridden later.
    private func retry(_ results: [LabResult], at index: Int) {
        send(.retrying(at: index))
        start { if let again = await Self.retried(results, at: index, extract: extract) { send(.retried(again, at: index)) } }
    }

    /// Save all (US-52 AC8b): each waiting report saved in turn, in picked order, as its own
    /// Save would, through the same calls. A refusal that would repeat for every report left
    /// (the record the review showed is gone: erased, changed, or the cloud disconnected)
    /// stops the run (`saveWaiting`). The record stays pinned to the one the review showed
    /// until the run ends.
    private func saveAll(_ results: [LabResult], from index: Int) {
        store.pinScreen()
        analytics?.event(.labSaveAll)  // AC8b's usage signal: once per run, nothing with it
        send(.saveAll)
        start {
            defer { store.unpinScreen() }
            for i in index..<results.count {
                if Task.isCancelled { return }
                send(.reportStarted(i))
                switch await LabReportSave.saveWaiting(results[i], held: held[results[i].id], engine: engine, store: store) {
                case .success(let outcome):
                    send(.reportFinished(i, outcome))
                case .failure(let stop):
                    send(.stopped(i, stop))
                    return
                }
            }
        }
    }

    /// `results` with the report at `index` sent again; nil when it keeps no report or the
    /// task was cancelled.
    static func retried(_ results: [LabResult], at index: Int, extract: (LabFileReader.Document) async throws -> String) async -> [LabResult]? {
        guard let document = results[index].retry, let again = await extractEach([document], extract: extract, progress: { _, _ in }) else { return nil }
        var results = results
        results[index] = again[0]
        return results
    }

    /// A failed read in plain words: the server's own, or ours. Never an exception's text.
    static func words(for error: Error) -> String {
        switch error {
        case is AppAttestClient.Failure: error.localizedDescription
        case let url as URLError: AppAttestClient.words(for: url, subject: "The server")
        default: "Something went wrong, so this report was not read. Please try again."
        }
    }

    /// Each report sent in turn, or nil once the sheet is closed: a report not yet
    /// sent when the task is cancelled is never sent (review R1, Codex).
    static func extractEach(_ documents: [LabFileReader.Document], extract: (LabFileReader.Document) async throws -> String,
                            progress: (Int, LabFileReader.Document) -> Void) async -> [LabResult]? {
        var results: [LabResult] = []
        for (n, document) in documents.enumerated() {
            if Task.isCancelled { return nil }
            progress(n, document)
            do {
                let extraction = try await extract(document)
                results.append(LabResult(name: document.name, truncated: document.truncated, extractionJSON: extraction, failure: nil,
                                         original: document.original))
            } catch {
                // Try again only for a failure that may mend: the network (a timeout, no
                // connection, a dropped one), the phone's App Attest (US-52 AC1c) or the
                // server's own trouble (5xx). A refused
                // attestation (401), a file too large (413), one the AI declined (422) and the
                // daily limit (429) fail the same way again (review R5).
                let (failure, mends): (String, Bool) = switch error {
                case AppAttestClient.Failure.server(status: 422, message: _): ("The AI could not read this file.", false)
                case AppAttestClient.Failure.server(status: let status, message: _): (words(for: error), status >= 500)
                case is URLError, AppAttestClient.Failure.device: (words(for: error), true)
                default: (words(for: error), false)
                }
                results.append(LabResult(name: document.name, truncated: false, extractionJSON: nil, failure: failure, retry: mends ? document : nil))
            }
        }
        return Task.isCancelled ? nil : results
    }
}

/// One way in to "Add medical records": a symbol, a title and a few words on what happens.
struct SourceRow: View {
    let title: String
    let symbol: String
    let detail: String
    /// Grows with the text: a fixed 30 points let the icon touch its words at the
    /// largest text sizes (US-52 AC10b, break-it 2026-10-30).
    @ScaledMetric(relativeTo: .title3) private var iconWidth = 30.0

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: iconWidth)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).foregroundStyle(Color.primary)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(Color.secondary)
            }
        }
        .padding(.vertical, 2)
    }
}

/// One file's answer from the server, or why there is none.
struct LabResult: Sendable {
    /// A new answer, a Try again's included, opens a fresh review.
    let id = UUID()
    let name: String
    let truncated: Bool
    let extractionJSON: String?
    let failure: String?
    /// The picked file, to keep in the person's cloud (US-52 AC13d); the engine keeps it only there.
    var original: LabFileReader.Original? = nil
    /// The report as read on the phone, kept after a failure Try again can mend (AC7a).
    var retry: LabFileReader.Document? = nil
}
