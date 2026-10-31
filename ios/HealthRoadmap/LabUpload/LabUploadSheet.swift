import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// "Add medical records" (US-52 AC7–AC13): where the report is (Files, Photos or the
/// camera), then the file read on the phone, then consent before the first send, then
/// each report sent and reviewed. The web twin is widget-src/src/components/UploadModal.tsx.
struct LabUploadSheet: View {
    let engine: HealthEngine
    let store: RecordStore

    private enum Step {
        case choose
        case consent([LabFileReader.Document])
        /// What is happening now, and how far through the reports the send is (nil before it starts).
        case working(String, LabReadingDiagram.Progress? = nil)
        case review([LabResult], index: Int)
        case failed(String)
    }

    @Environment(\.dismiss) private var dismiss
    @State private var step = Step.choose
    @State private var importing = false
    @State private var scanning = false
    @State private var picking = false
    @State private var photo: PhotosPickerItem?
    /// A review is saving: the sheet stays open until it lands.
    @State private var reviewSaving = false
    /// The read or send under way, cancelled when the sheet closes (review R1, Codex).
    @State private var work: Task<Void, Never>?
    /// Where Cancel on the reading screen goes: the sources, or the review a Try again left (AC7a).
    @State private var cancelTo = Step.choose

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Add medical records")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { work?.cancel(); dismiss() }.disabled(reviewSaving) }
                    if case .choose = step, AIConsent.labUpload.given {
                        ToolbarItem(placement: .primaryAction) {
                            Menu {
                                Button("Stop sharing", systemImage: "hand.raised", role: .destructive) {
                                    AIConsent.labUpload.withdraw()
                                    step = .choose
                                }
                            } label: { Image(systemName: "ellipsis.circle") }
                        }
                    }
                }
        }
        .interactiveDismissDisabled(reviewSaving)
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
        case .working(let what, let progress):
            VStack {
                LabReadingDiagram(step: what, progress: progress)
                // A way out of a wait that may run to the timeout (AC7a); Close stays too.
                Button("Cancel") { work?.cancel(); step = cancelTo }.buttonStyle(.bordered)
            }
        case .review(let results, let index):
            LabReviewView(engine: engine, store: store, result: results[index], position: (index + 1, results.count), saving: $reviewSaving,
                          tryAgain: results[index].retry == nil ? nil : { retry(results, at: index) }) {
                if index + 1 < results.count {
                    step = .review(results, index: index + 1)
                } else {
                    dismiss()
                }
            }
            .id(results[index].id)
        case .failed(let message):
            VStack(spacing: 16) {
                Text(message).multilineTextAlignment(.center)
                Button("Choose another file") { step = .choose }.buttonStyle(.bordered)
            }
            .padding()
        }
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
        cancelTo = .choose
        step = .working("Reading the file on your iPhone")
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
                step = .consent(read)
            }
        } catch {
            if !Task.isCancelled { step = .failed(error.localizedDescription) }
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
                read = try await LabFileReader.decoded(picked: url) { done, total in
                    step = .working("Reading report \(done + 1) of \(total)", .init(done: done, total: total, started: .now))
                }
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
        guard AIConsent.labUpload.given else { step = .consent(documents); return }
        cancelTo = .choose
        let results = await Self.extractEach(documents, extract: extract) { n, document in
            step = .working("Reading the values in \(document.name)", .init(done: n, total: documents.count, started: .now))
        }
        if let results { step = .review(results, index: 0) }
    }

    private func extract(_ document: LabFileReader.Document) async throws -> String {
        try await LabUploadClient().extract(document, unitSystem: store.myData?.unitSystem ?? "si")
    }

    /// Try again (AC7a): the report read on the phone goes again, with no new pick. Cancel
    /// goes back to the review it came from. Tapped only: the app never retries on its own.
    /// The screen moves at the tap, so a same-instant Next or Done cannot be overridden later.
    private func retry(_ results: [LabResult], at index: Int) {
        cancelTo = .review(results, index: index)
        step = .working("Reading the values in \(results[index].name)")
        start { if let again = await Self.retried(results, at: index, extract: extract) { step = .review(again, index: index) } }
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
                // connection, a dropped one) or the server's own trouble (5xx). A refused
                // attestation (401), a file too large (413), one the AI declined (422) and the
                // daily limit (429) fail the same way again (review R5).
                let (failure, mends): (String, Bool) = switch error {
                case AppAttestClient.Failure.server(status: 422, message: _): ("The AI could not read this file.", false)
                case AppAttestClient.Failure.server(status: let status, message: _): (words(for: error), status >= 500)
                case is URLError: (words(for: error), true)
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
