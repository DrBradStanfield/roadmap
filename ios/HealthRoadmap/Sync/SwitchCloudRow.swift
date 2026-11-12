import AuthenticationServices
import SwiftUI

/// "Switch to <cloud>" (US-25 AC11n): Sync's connected branch and the welcome sheet at failed
/// both draw this row, so there is one switch. It asks first, naming the cloud the record is
/// in as the dialog shows, then runs `CloudSync.switchTo`. It keeps no state of its own: a
/// switch running shows as Sync's "Disconnecting…", then the sign-in sheet, and the row is
/// off while the connection is closing or an erase runs. The sign-in is the screen's
/// (`authenticate`): once the Disconnect ends no cloud is connected, so the screen drops this
/// row while the provider's page is up, and a session the row read would go with it.
struct SwitchCloudRow: View {
    let sync: CloudSync
    let provider: CloudProvider
    /// The screen's own web sign-in, read where it stays on screen through the switch.
    let authenticate: OAuthClient.Authenticate
    /// The screen's alert, as for connect errors: the row can go while the switch runs.
    @Binding var message: String?

    @State private var confirming = false

    /// The other configured clouds, which a switch from `current` can go to.
    static func targets(from current: CloudProvider) -> [CloudProvider] {
        CloudProvider.allCases.filter { $0 != current && $0.isConfigured }
    }

    var body: some View {
        Button(SyncStatusText.switchRow(provider)) { confirming = true }
            .disabled(sync.eraseRunning() || sync.status == .disconnecting)
            .confirmationDialog(SyncStatusText.switchRow(provider) + "?", isPresented: $confirming, titleVisibility: .visible) {
                Button(SyncStatusText.switchRow(provider)) {
                    guard let current = sync.provider else { return }
                    Task { await switchCloud(from: current) }
                }
            } message: {
                if let current = sync.provider {
                    Text(SyncStatusText.switchMessage(from: current, to: provider, recordOpen: sync.recordOpen))
                }
            }
    }

    private func switchCloud(from current: CloudProvider) async {
        do {
            let outcome = try await sync.switchTo(provider, authenticate: authenticate)
            message = SyncStatusText.switchEnded(outcome, from: current, to: provider, connected: sync.provider)
        } catch {
            message = error.localizedDescription
        }
    }
}

extension WebAuthenticationSession {
    /// The browser step of a sign-in, run by the screen that read this session.
    var signIn: OAuthClient.Authenticate {
        { url, scheme in try await authenticate(using: url, callbackURLScheme: scheme) }
    }
}
