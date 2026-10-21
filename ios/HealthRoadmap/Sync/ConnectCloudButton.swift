import AuthenticationServices
import SwiftUI

/// The one way the app signs in to a cloud (US-25 AC11): Sync's Connect and
/// "Sign in again" rows, and "+"'s Connect Dropbox (US-52 AC11), all run
/// `CloudSync.connect` through this button, so there is one OAuth flow.
struct ConnectCloudButton<Label: View>: View {
    let sync: CloudSync
    let provider: CloudProvider
    /// Runs after a sign-in that connected.
    let connected: () -> Void
    @ViewBuilder let label: () -> Label

    @Environment(\.webAuthenticationSession) private var webAuthenticationSession
    @State private var signingIn = false
    @State private var message: String?

    var body: some View {
        Button {
            Task { await signIn() }
        } label: {
            HStack {
                label()
                Spacer()
                if signingIn { ProgressView().accessibilityLabel("Signing in") }
            }
        }
        .disabled(signingIn || !provider.isConfigured || sync.erasing)
        .alert(provider.label, isPresented: Binding(get: { message != nil }, set: { if !$0 { message = nil } })) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message ?? "")
        }
    }

    private func signIn() async {
        signingIn = true
        defer { signingIn = false }
        do {
            try await sync.connect(provider) { url, scheme in
                try await webAuthenticationSession.authenticate(using: url, callbackURLScheme: scheme)
            }
            connected()
        } catch OAuthClient.Failure.cancelled {
            // The user closed the sign-in sheet: nothing to say.
        } catch {
            message = error.localizedDescription
        }
    }
}
