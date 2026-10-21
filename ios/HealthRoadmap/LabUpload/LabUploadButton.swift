import SwiftUI
import UniformTypeIdentifiers

/// The "+" that uploads a lab report (US-52 AC7), ready for a toolbar:
/// `.toolbar { LabUploadButton(engine: engine, store: store) }`.
struct LabUploadButton: View {
    let engine: HealthEngine
    let store: RecordStore
    @State private var showing = false

    var body: some View {
        Button {
            showing = true
        } label: {
            Image(systemName: "plus")
        }
        .accessibilityLabel("Upload a lab report")
        .sheet(isPresented: $showing) {
            LabUploadSheet(engine: engine, store: store)
        }
    }
}

/// Consent, then the file importer (Files, and Dropbox or Google Drive when their
/// apps are installed), then each file read and sent, then the review.
struct LabUploadSheet: View {
    let engine: HealthEngine
    let store: RecordStore

    private enum Step {
        case consent, pick, working(String), review([LabResult], index: Int), failed(String)
    }

    @Environment(\.dismiss) private var dismiss
    @State private var step: Step = AIConsent.labUpload.given ? .pick : .consent
    @State private var importing = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Upload lab results")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
                    if case .pick = step {
                        ToolbarItem(placement: .primaryAction) {
                            Menu {
                                Button("Stop sharing", systemImage: "hand.raised", role: .destructive) {
                                    AIConsent.labUpload.withdraw()
                                    step = .consent
                                }
                            } label: { Image(systemName: "ellipsis.circle") }
                        }
                    }
                }
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.pdf, .jpeg, .png, .zip], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first { Task { await upload(url) } }
        }
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .consent:
            AIConsentView(consent: .labUpload) { step = .pick }
        case .pick:
            VStack(spacing: 16) {
                Image(systemName: "doc.badge.plus").font(.system(size: 48)).foregroundStyle(.tint)
                Text("Pick a lab report: a PDF, a photo (JPEG or PNG), or a ZIP of them. Files from Dropbox or Google Drive show up here when their apps are installed.")
                    .multilineTextAlignment(.center)
                Button("Choose a file") { importing = true }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
            }
            .padding()
        case .working(let what):
            ProgressView(what).padding()
        case .review(let results, let index):
            LabReviewView(engine: engine, store: store, result: results[index], position: (index + 1, results.count)) {
                step = index + 1 < results.count ? .review(results, index: index + 1) : .pick
                if index + 1 >= results.count { dismiss() }
            }
            .id(index)
        case .failed(let message):
            VStack(spacing: 16) {
                Text(message).multilineTextAlignment(.center)
                Button("Choose another file") { importing = true }.buttonStyle(.bordered)
            }
            .padding()
        }
    }

    private func upload(_ url: URL) async {
        guard AIConsent.labUpload.given else { step = .consent; return }
        step = .working("Reading the file")
        let documents: [LabFileReader.Document]
        do {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            let data = try Data(contentsOf: url)
            documents = try LabFileReader.documents(from: data, name: url.lastPathComponent)
        } catch {
            step = .failed(error.localizedDescription)
            return
        }
        let units = store.myData?.unitSystem ?? "si"
        var results: [LabResult] = []
        for (n, document) in documents.enumerated() {
            step = .working(documents.count > 1 ? "Reading report \(n + 1) of \(documents.count)" : "Reading the values")
            do {
                let extraction = try await LabUploadClient().extract(document, unitSystem: units)
                results.append(LabResult(name: document.name, truncated: document.truncated, extractionJSON: extraction, failure: nil))
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

/// One file's answer from the server, or why there is none.
struct LabResult: Sendable {
    let name: String
    let truncated: Bool
    let extractionJSON: String?
    let failure: String?
}
