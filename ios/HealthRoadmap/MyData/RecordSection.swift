import SwiftUI

/// The last section of My data (US-25 AC16): "Export my record" and "Delete all my
/// data". The delete is two steps: a page that says what goes and what stays,
/// then iOS's own "Delete everything?" alert.
struct RecordSection: View {
    let store: RecordStore
    let sync: CloudSync

    var body: some View {
        Section {
            ShareLink(item: RecordExport(json: store.recordJSON), preview: SharePreview(RecordExport.fileName)) {
                Label("Export my record", systemImage: "square.and.arrow.up")
            }
            NavigationLink {
                EraseView(sync: sync)
            } label: {
                Label(EraseText.title, systemImage: "trash").foregroundStyle(.red)
            }
        } header: {
            Text("Your record")
        } footer: {
            Text("Export shares \(RecordExport.fileName), the same file the website keeps. Anyone you give it to can read your health record.")
        }
    }
}

/// Step one: what an erase deletes, where, and what it cannot reach. Step two is
/// the alert behind its button.
private struct EraseView: View {
    let sync: CloudSync
    @Environment(DataEraser.self) private var eraser
    @Environment(\.dismiss) private var dismiss
    @State private var confirming = false
    @State private var outcome: DataEraser.Outcome?

    var body: some View {
        List {
            Section {
                Text(EraseText.confirm(provider: sync.provider, earlier: sync.syncedBefore, appleHealth: eraser.appleHealthConnected))
            }
            Section {
                Button(role: .destructive) {
                    confirming = true
                } label: {
                    HStack {
                        Text(EraseText.deleteButton)
                        Spacer()
                        if eraser.erasing { ProgressView() }
                    }
                }
                .disabled(eraser.erasing)
            }
        }
        // Leaving mid-erase would reach Sync's Disconnect; CloudSync refuses it then too (review R2).
        .navigationBarBackButtonHidden(eraser.erasing)
        .navigationTitle(EraseText.title)
        .navigationBarTitleDisplayMode(.inline)
        .alert(EraseText.finalTitle, isPresented: $confirming) {
            Button(EraseText.deleteButton, role: .destructive) {
                Task { outcome = await eraser.eraseAll() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(EraseText.finalMessage)
        }
        .alert(EraseText.title, isPresented: Binding(get: { outcome != nil }, set: { if !$0 { finish() } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(words)
        }
    }

    private var words: String {
        switch outcome {
        case .erased(let text), .notSent(let text), .refused(let text): text
        case nil: ""
        }
    }

    /// After an erase, the new-user questions on the empty record (US-54 AC7);
    /// a refusal stays here to try again.
    private func finish() {
        guard let shown = outcome else { return }
        outcome = nil
        if case .refused = shown { return }
        dismiss()
        eraser.erasedAndSeen()
    }
}
