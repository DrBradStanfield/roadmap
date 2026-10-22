import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// Where the report is (Dropbox, Google Drive, Files, Photos or the camera),
/// then the file read on the phone, then consent before the first send, then
/// each report sent and reviewed.
struct LabUploadSheet: View {
    let engine: HealthEngine
    let store: RecordStore
    let sync: CloudSync

    private enum Step {
        case choose
        case consent([LabFileReader.Document])
        /// What is happening now, and how far through the reports the send is (nil before it starts).
        case working(String, LabReadingDiagram.Progress? = nil)
        case review([LabResult], index: Int)
        case failed(String)
    }

    private enum Source: Hashable { case dropbox, googleDrive }

    @Environment(\.dismiss) private var dismiss
    @State private var step = Step.choose
    @State private var path: [Source] = []
    @State private var importing = false
    @State private var scanning = false
    @State private var picking = false
    @State private var photo: PhotosPickerItem?

    var body: some View {
        NavigationStack(path: $path) {
            content
                .navigationTitle("Add medical records")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
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
                .navigationDestination(for: Source.self) { source in
                    switch source {
                    case .dropbox:
                        DropboxLabFiles(engine: engine, sync: sync, pick: { file in Task { await read(dropbox: file) } }, browseFiles: browseFiles)
                    case .googleDrive:
                        GoogleDriveLabFiles(sync: sync, browseFiles: browseFiles)
                    }
                }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.folder, .pdf, .jpeg, .png, .zip], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first { Task { await read(file: url) } }
        }
        // Presented from the sheet's root, like Files: an inline PhotosPicker row took
        // the whole sheet down with it when a photo was picked (iOS 27, seen 2026-10-22).
        .photosPicker(isPresented: $picking, selection: $photo, matching: .images)
        .onChange(of: photo) {
            guard let item = photo else { return }
            photo = nil
            Task { await read(photo: item) }
        }
        .fullScreenCover(isPresented: $scanning) {
            DocumentScanner { pages in
                scanning = false
                if !pages.isEmpty { Task { await read { [try LabFileReader.pictures(pages, name: "Scanned report")] } } }
            }
            .ignoresSafeArea()
        }
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .choose:
            chooser
        case .consent(let documents):
            AIConsentView(consent: .labUpload) { Task { await send(documents) } }
        case .working(let what, let progress):
            LabReadingDiagram(step: what, progress: progress)
        case .review(let results, let index):
            LabReviewView(engine: engine, store: store, result: results[index], position: (index + 1, results.count)) {
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

    private var chooser: some View {
        List {
            Section { LabUploadExplainer() }
            Section {
                NavigationLink(value: Source.dropbox) {
                    SourceRow(title: "From Dropbox", symbol: "shippingbox",
                              detail: "Pick a folder or files")
                }
                NavigationLink(value: Source.googleDrive) {
                    SourceRow(title: "From Google Drive", symbol: "externaldrive", detail: "Pick a folder or files")
                }
                Button(action: browseFiles) {
                    SourceRow(title: "A folder or ZIP", symbol: "folder", detail: "From Files or iCloud Drive")
                }
                Button { picking = true } label: {
                    SourceRow(title: "From Photos", symbol: "photo.on.rectangle", detail: "A photo of a paper report")
                }
                if DocumentScanner.isAvailable {
                    Button { scanning = true } label: {
                        SourceRow(title: "Scan a paper report", symbol: "doc.viewfinder", detail: "Use the camera, one page at a time")
                    }
                }
            } header: {
                Text("Where are your medical records?")
            }
        }
    }

    private func browseFiles() {
        importing = true
    }

    // MARK: Reading, on the phone

    /// Reads the report on the phone, then sends it, or asks for consent first.
    /// Nothing leaves the phone for the server before the user agrees.
    /// A second pick while one is under way (a double tap) is ignored (review R6).
    private func read(_ documents: () async throws -> [LabFileReader.Document]) async {
        guard case .choose = step else { return }
        path = []
        step = .working("Reading the file on your iPhone")
        do {
            let read = try await documents()
            if AIConsent.labUpload.given {
                await send(read)
            } else {
                step = .consent(read)
            }
        } catch {
            step = .failed(error.localizedDescription)
        }
    }

    private func read(file url: URL) async {
        await read {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let read = try url.hasDirectoryPath ? LabFileReader.documents(inFolder: url) : LabFileReader.documents(picked: url)
            return await engine.named(read)
        }
    }

    private func read(photo item: PhotosPickerItem) async {
        await read {
            guard let data = try await item.loadTransferable(type: Data.self), let image = UIImage(data: data) else {
                throw LabFileReader.Failure.unreadable("The photo")
            }
            return [try LabFileReader.pictures([image], name: "Photo")]
        }
    }

    /// A Dropbox file, refused before it downloads when it is over the web's limit.
    private func read(dropbox file: HealthEngine.CloudLabFile) async {
        guard case .choose = step else { return }
        guard LabFileReader.fits(name: file.name, bytes: file.size) else {
            path = []
            step = .failed(LabFileReader.Failure.tooLarge(file.name).localizedDescription)
            return
        }
        await read {
            step = .working("Getting the file from Dropbox")
            let fetched: (name: String, data: Data)
            do {
                fetched = try await engine.labFile(file)
            } catch {
                throw DropboxFailure(error)
            }
            // Read under the name Dropbox gives it now, not the one the list showed (re-check R3).
            return await engine.named(try LabFileReader.documents(from: fetched.data, name: fetched.name))
        }
    }

    // MARK: Sending, with consent

    private func send(_ documents: [LabFileReader.Document]) async {
        guard AIConsent.labUpload.given else { step = .consent(documents); return }
        let units = store.myData?.unitSystem ?? "si"
        var results: [LabResult] = []
        for (n, document) in documents.enumerated() {
            step = .working("Reading the values in \(document.name)", .init(done: n, total: documents.count, started: .now))
            do {
                let extraction = try await LabUploadClient().extract(document, unitSystem: units)
                results.append(LabResult(name: document.name, truncated: document.truncated, extractionJSON: extraction, failure: nil,
                                         original: document.original))
            } catch let AppAttestClient.Failure.server(status, message) where status == 422 {
                _ = message
                results.append(LabResult(name: document.name, truncated: false, extractionJSON: nil, failure: "The AI could not read this file."))
            } catch {
                results.append(LabResult(name: document.name, truncated: false, extractionJSON: nil, failure: error.localizedDescription))
            }
        }
        step = .review(results, index: 0)
    }
}

/// A Dropbox download that failed, in plain words: the engine's own refusal
/// (`{"refused": "…"}`: not a listed lab file, empty, too large), or what the
/// cloud failure means. The marker tells them apart, never the first character (re-check R1).
struct DropboxFailure: LocalizedError {
    let errorDescription: String?

    init(_ error: Error) {
        if case HealthEngine.EngineError.callFailed(let message) = error,
           let object = try? JSONSerialization.jsonObject(with: Data(message.utf8)) as? [String: Any],
           let words = object["refused"] as? String {
            errorDescription = words
        } else if SyncProblem(error).kind == .signIn {
            errorDescription = "Dropbox needs you to sign in again. Open From Dropbox to sign in."
        } else {
            errorDescription = "Dropbox could not be reached. Check the connection and try again."
        }
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
