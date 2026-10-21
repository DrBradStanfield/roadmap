import AuthenticationServices
import SwiftUI

/// The Sync screen (US-25 AC11e), opened from My data's toolbar: where the record
/// is, its state in plain words, Connect Dropbox or Google Drive, Sync now, and
/// Disconnect. Every action is CloudSync's; this view only draws and asks.
struct SyncView: View {
    let sync: CloudSync
    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @Environment(\.dismiss) private var dismiss
    /// The provider whose sign-in is under way.
    @State private var signingIn: CloudProvider?
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

    private var connect: some View {
        Section {
            ForEach(CloudProvider.allCases) { provider in
                Button {
                    Task { await signIn(provider) }
                } label: {
                    HStack {
                        Label("Connect \(provider.label)", systemImage: "link.icloud")
                        Spacer()
                        if signingIn == provider { ProgressView() }
                    }
                }
                .disabled(signingIn != nil || !provider.isConfigured || sync.erasing)
            }
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                Text("The app talks to your cloud directly. Dr Brad's server never sees your record. It sits in the app's own folder: Apps › Health Plan by Dr Brad in Dropbox, Health Plan by Dr Brad in Google Drive.")
                if !CloudProvider.googleDrive.isConfigured {
                    Text("Google Drive sign-in is not set up in this build yet.")
                }
            }
        }
    }

    // MARK: Connected

    @ViewBuilder
    private func connected(_ provider: CloudProvider) -> some View {
        Section {
            if case .problem(let problem) = sync.status, problem.kind == .signIn {
                Button {
                    Task { await signIn(provider) }
                } label: {
                    Label("Sign in to \(provider.label) again", systemImage: "person.badge.key")
                }
                .disabled(signingIn != nil)
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

    private func signIn(_ provider: CloudProvider) async {
        signingIn = provider
        defer { signingIn = nil }
        do {
            try await sync.connect(provider) { url, scheme in
                try await webAuthenticationSession.authenticate(using: url, callbackURLScheme: scheme)
            }
        } catch OAuthClient.Failure.cancelled {
            // The user closed the sign-in sheet: nothing to say.
        } catch {
            message = error.localizedDescription
        }
    }

    private func disconnect(_ provider: CloudProvider) async {
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
            Image(systemName: symbol)
                .font(.title)
                .foregroundStyle(tint)
                .frame(width: 52, height: 52)
                .background(tint.opacity(0.15), in: Circle())
                .symbolEffect(.pulse, isActive: busy)
                .contentTransition(.symbolEffect(.replace))
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

    private var symbol: String {
        guard provider != nil else { return "iphone" }
        return switch status {
        case .onPhone: "iphone"
        case .connecting, .saving: "arrow.triangle.2.circlepath.icloud"
        case .synced: "checkmark.icloud.fill"
        case .problem: "exclamationmark.icloud.fill"
        }
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
