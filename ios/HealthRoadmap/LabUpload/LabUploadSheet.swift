import PhotosUI
import SwiftUI
import UniformTypeIdentifiers

/// "Add medical records" (US-52 AC7–AC13, AC8c): where the records are (Files, Photos or the
/// camera), then the one review page of the shared upload, drawn from the engine's view, with
/// consent before the first send as the engine's own phase. The web twin is
/// widget-src/src/components/UploadModal.tsx.
struct LabUploadSheet: View {
    let engine: HealthEngine
    let store: RecordStore

    @Environment(\.dismiss) private var dismiss
    @Environment(\.analytics) private var analytics
    /// The sheet's one named state, moved only by `send(_:)` (LabUploadFlow).
    @State private var step = LabUploadFlow.Step.choose
    @State private var importing = false
    @State private var scanning = false
    @State private var picking = false
    @State private var photo: PhotosPickerItem?
    /// The pick being read into bytes, cancelled when the sheet closes.
    @State private var work: Task<Void, Never>?
    /// Close and swipe-down wait from a Save's tap until its outcome draws, and while the view says so.
    private var closeHeld: Bool {
        guard case .shared(let shared) = step else { return false }
        if shared.saveClaimed { return true }
        guard case .drawn(let text) = shared.model.state else { return false }
        return shared.page(text)?.closeEnabled == false
    }

    var body: some View {
        NavigationStack {
            content
                .navigationTitle("Add medical records")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("Close") { close() }.disabled(closeHeld) }
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
        .onDisappear { leave() }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.folder, .pdf, .jpeg, .png, .zip], allowsMultipleSelection: false) { result in
            if case .success(let urls) = result, let url = urls.first {
                pick { [engine] in try await LabFileReader.picked(url, ask: { await engine.uploadRules(files: $0, members: $1) }) }
            }
        }
        // Presented from the sheet's root, like Files: an inline PhotosPicker row took
        // the whole sheet down with it when a photo was picked (iOS 27, seen 2026-10-22).
        .photosPicker(isPresented: $picking, selection: $photo, matching: .images)
        .onChange(of: photo) {
            guard let item = photo else { return }
            photo = nil
            pick {
                guard let data = try await item.loadTransferable(type: Data.self) else { throw LabFileReader.Failure.unreadable("The photo") }
                return [try await LabFileReader.picked(photo: data)]
            }
        }
        .fullScreenCover(isPresented: $scanning) {
            DocumentScanner { pages in
                scanning = false
                if !pages.isEmpty { pick { [try await LabFileReader.picked(scan: pages)] } }
            }
            .ignoresSafeArea()
        }
    }

    @ViewBuilder private var content: some View {
        switch step {
        case .choose:
            chooser
        case .shared(let shared):
            sharedPage(shared)
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

    /// The shared upload's page, drawn from the engine's view (UploadReviewView); its consent is
    /// the engine's phase.
    @ViewBuilder private func sharedPage(_ shared: UploadSession) -> some View {
        switch shared.model.state {
        case .drawn(let text):
            if let page = shared.page(text) {
                if page.phase == "consent" {
                    // Nothing has run yet, not even a hash (AC13e): the engine waits for this agree.
                    AIConsentView(consent: .labUpload) { Task { await shared.runner.consented() } }
                } else {
                    UploadReviewView(page: page, send: shared.send, letter: shared.letter, saveClaimed: shared.saveClaimed) {
                        shared.send(.close)
                        dismiss()
                    }
                }
            } else if let words = shared.engineError {
                // A view that does not read draws the doors' own words, never a blank page.
                Text(verbatim: words).multilineTextAlignment(.center).padding()
            }
        case .refused(let refusal):
            VStack(spacing: 16) {
                // A call that answered nothing says the doors' own engine-error words, from the last view.
                if let words = refusal?.message ?? shared.engineError { Text(verbatim: words).multilineTextAlignment(.center) }
                Button("Choose another file") { shared.send(.discard); send(.restart) }.buttonStyle(.bordered)
            }
            .padding()
        case .starting, .unavailable:
            ProgressView()
        }
    }

    /// The one way the step moves; Done closes the sheet. Leaving the shared page unpins its record.
    private func send(_ event: LabUploadFlow.Event) {
        let before = step
        step = LabUploadFlow.transition(step, event)
        if case .shared(let session) = before, !isShared(step, session) { session.end() }
        if case .finished = step { dismiss() }
    }

    private func isShared(_ step: LabUploadFlow.Step, _ session: UploadSession) -> Bool {
        if case .shared(let now) = step { now === session } else { false }
    }

    /// Close: the shared upload is left, dropping what it read.
    private func close() {
        // A Save tapped and not yet answered holds Close, even before its saving view draws.
        guard !closeHeld else { return }
        leave()
        dismiss()
    }

    /// The sheet is going: the pick being read is cancelled (never held or sent), and the shared
    /// upload is left and its record unpinned.
    private func leave() {
        work?.cancel()
        if case .shared(let shared) = step {
            shared.send(.discard)
            shared.end()
        }
    }

    // MARK: Where the records are (AC10)

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

    /// Starts the shared upload from a pick: its bytes read off the main thread, then held and
    /// read by the engine. Only from the sources: a second pick while one is under way (a double
    /// tap) is ignored. A pick the reader refuses says why in its words; an engine without the
    /// shared upload's doors cannot read it.
    private func pick(_ files: @escaping @Sendable () async throws -> [UploadRunner.Picked]) {
        guard case .choose = step else { return }
        let session = UploadSession(engine: engine, store: store, analytics: analytics)
        send(.sharedPicked(session))
        work?.cancel()
        work = Task {
            let started = await session.start({ try await files() }, needsConsent: !AIConsent.labUpload.given)
            guard !Task.isCancelled else { return }
            switch started {
            case .running: break
            case .refused(let message): send(.failed(message))
            case .fallback: send(.failed(Self.notRead))
            }
        }
    }

    /// The app's words for a pick it could not read at all (an engine too old for the upload).
    static let notRead = "Something went wrong, so this report was not read. Please try again."
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
