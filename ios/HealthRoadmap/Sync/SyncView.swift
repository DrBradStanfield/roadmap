import SwiftUI

/// The Sync screen (US-25 AC11e), opened from My data's About you line: what sync does,
/// where the record is, its state in plain words, Connect Dropbox or Google
/// Drive, Sync now, and Disconnect. Every action is CloudSync's; this view only
/// draws and asks.
struct SyncView: View {
    let sync: CloudSync
    @Environment(\.dismiss) private var dismiss
    @State private var message: String?
    @State private var confirmDisconnect = false

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SyncStatusCard(status: sync.status, provider: sync.provider)
                }
                if let provider = sync.provider {
                    connected(provider)
                } else {
                    connect
                }
            }
            .navigationTitle("Sync")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) { Button("Done") { dismiss() } }
            }
            .alert("Sync", isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(message ?? "")
            }
            .animation(.snappy, value: sync.status)
        }
    }

    // MARK: Not connected

    @ViewBuilder
    private var connect: some View {
        Section("What sync does") {
            Text("Sync keeps your record in your own Dropbox or Google Drive. The website and a new phone open the same file. Dr Brad's server never sees it.")
        }
        Section {
            ForEach(CloudProvider.allCases) { provider in
                ConnectCloudButton(sync: sync, provider: provider, connected: {}) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Connect \(provider.label)")
                        Text(provider.isConfigured ? "Saves to \(provider.folder)" : "Not set up in this version of the app yet")
                            .font(.footnote)
                            .foregroundStyle(Color.secondary)
                    }
                }
            }
        } footer: {
            Text("You sign in on Dropbox's or Google's own page. The app sees only its own folder there. In Dropbox, that folder also takes lab reports: put a PDF or photo in it, then add it with +.")
        }
    }

    // MARK: Connected

    @ViewBuilder
    private func connected(_ provider: CloudProvider) -> some View {
        Section {
            LabeledContent("Connected to", value: sync.accountEmail ?? provider.label)
            LabeledContent("Folder", value: provider.folder)
        } footer: {
            Text("The website and your other devices use this same file. Dr Brad's server never sees it.")
        }

        Section {
            if case .problem(let problem) = sync.status, problem.kind == .signIn {
                ConnectCloudButton(sync: sync, provider: provider, connected: {}) {
                    Label("Sign in to \(provider.label) again", systemImage: "person.badge.key")
                }
            }
            Button {
                Task { await sync.syncNow() }
            } label: {
                Label("Sync now", systemImage: "arrow.triangle.2.circlepath")
            }
            .disabled(sync.status == .connecting || sync.status == .saving)
        } footer: {
            Text("The app reads \(provider.label) when it opens, when you come back to it, and every minute while it is on screen. Changes made on the website appear here on their own.")
        }

        Section {
            Button("Disconnect from \(provider.label)", role: .destructive) { confirmDisconnect = true }
                .disabled(sync.erasing)
                .confirmationDialog("Disconnect from \(provider.label)?", isPresented: $confirmDisconnect, titleVisibility: .visible) {
                    Button("Disconnect", role: .destructive) { Task { await disconnect(provider) } }
                } message: {
                    Text("Your record stays in \(provider.label). This iPhone keeps a copy and saves only here from now on.")
                }
        }
    }

    // MARK: Actions

    private func disconnect(_ provider: CloudProvider) async {
        guard !sync.erasing else { return } // refused, not unreachable (re-check N3)
        if !(await sync.disconnect()) {
            message = "\(provider.label) could not be reached, so changes made on other devices since the last sync are not on this iPhone. Everything saved on this iPhone is kept."
        }
    }
}

/// The status at the top of Sync: an icon, a headline and a sentence.
private struct SyncStatusCard: View {
    let status: CloudSync.Status
    let provider: CloudProvider?

    var body: some View {
        HStack(spacing: 16) {
            Image(systemName: SyncStatusText.symbol(status, provider: provider))
                .font(.title)
                .foregroundStyle(tint)
                .frame(width: 52, height: 52)
                .background(tint.opacity(0.15), in: Circle())
                .symbolEffect(.pulse, isActive: busy)
                .contentTransition(.symbolEffect(.replace))
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 4) {
                Text(SyncStatusText.headline(status, provider: provider))
                    .font(.headline)
                if case .synced(let when) = status {
                    TimelineView(.periodic(from: .now, by: 30)) { _ in
                        Text("Last synced \(when.formatted(.relative(presentation: .named)))")
                    }
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                }
                if let detail = SyncStatusText.detail(status, provider: provider) {
                    Text(detail)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }

    private var busy: Bool {
        status == .connecting || status == .saving
    }

    private var tint: Color {
        guard provider != nil else { return .secondary }
        return switch status {
        case .synced: .green
        case .problem: .orange
        default: .accentColor
        }
    }
}
