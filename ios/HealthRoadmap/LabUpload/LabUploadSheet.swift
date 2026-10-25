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
            if case .success(let urls) = result, let url = urls.first { start { await read(file: url) } }
        }
        // Presented from the sheet's root, like Files: an inline PhotosPicker row took
        // the whole sheet down with it when a photo was picked (iOS 27, seen 2026-10-22).
        .photosPicker(isPresented: $picking, selection: $photo, matching: .images)
        .onChange(of: photo) {
            guard let item = photo else { return }
            photo = nil
            start { await read(photo: item) }
        }
        .fullScreenCover(isPresented: $scanning) {
            DocumentScanner { pages in
                scanning = false
                if !pages.isEmpty { start { await read { [try await LabFileReader.pictures(pages, name: "Scanned report")] } } }
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
            LabReadingDiagram(step: what, progress: progress)
        case .review(let results, let index):
            LabReviewView(engine: engine, store: store, result: results[index], position: (index + 1, results.count), saving: $reviewSaving) {
                if index + 1 < results.count {
                    step = .review(results, index: index + 1)
                } else {
                    dismiss()
                }
            }
            .id(index)
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

    /// Runs a read or a send as the sheet's tracked work, which Close cancels.
    private func start(_ operation: @escaping @MainActor () async -> Void) {
        work = Task { await operation() }
    }

    // MARK: Reading, on the phone

    /// Reads the report on the phone, then sends it, or asks for consent first.
    /// Nothing leaves the phone for the server before the user agrees.
    /// A second pick while one is under way (a double tap) is ignored (review R6).
    private func read(_ documents: () async throws -> [LabFileReader.Document]) async {
        guard case .choose = step else { return }
        step = .working("Reading the file on your iPhone")
        do {
            let read = try await documents()
            // Closed while it read: nothing is sent (review R1).
            try Task.checkCancellation()
            if AIConsent.labUpload.given {
                await send(read)
            } else {
                step = .consent(read)
            }
        } catch {
            step = .failed(error.localizedDescription)
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
        let units = store.myData?.unitSystem ?? "si"
        let results = await Self.extractEach(documents, extract: { try await LabUploadClient().extract($0, unitSystem: units) }) { n, document in
            step = .working("Reading the values in \(document.name)", .init(done: n, total: documents.count, started: .now))
        }
        if let results { step = .review(results, index: 0) }
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
            } catch AppAttestClient.Failure.server(status: 422, message: _) {
                results.append(LabResult(name: document.name, truncated: false, extractionJSON: nil, failure: "The AI could not read this file."))
            } catch {
                results.append(LabResult(name: document.name, truncated: false, extractionJSON: nil, failure: error.localizedDescription))
            }
        }
        return Task.isCancelled ? nil : results
    }
}

/// One way in to "Add medical records": a symbol, a title and a few words on what happens.
private struct SourceRow: View {
    let title: String
    let symbol: String
    let detail: String

    var body: some View {
        HStack(spacing: 14) {
            Image(systemName: symbol)
                .font(.title3)
                .foregroundStyle(.tint)
                .frame(width: 30)
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
    let name: String
    let truncated: Bool
    let extractionJSON: String?
    let failure: String?
    /// The picked file, to keep in the person's cloud (US-52 AC13d); the engine keeps it only there.
    var original: LabFileReader.Original? = nil
}
