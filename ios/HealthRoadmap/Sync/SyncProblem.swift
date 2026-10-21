import Foundation

/// Why the record is not synced, as the engine classed it (ios/engine/cloud.ts
/// `failureKind`), and the plain words the Sync screen says for it.
struct SyncProblem: Equatable {
    enum Kind: String {
        /// The provider refused the sign-in: only signing in again fixes it.
        case signIn = "sign-in"
        /// A newer app wrote the record: this one must update before it syncs.
        case tooNew = "too-new"
        /// No network, or the provider did not answer: it retries by itself.
        case unreachable
    }

    let kind: Kind

    /// The engine's failure JSON: `{"kind": "...", "detail": "..."}`.
    init(json: String) {
        let object = (try? JSONSerialization.jsonObject(with: Data(json.utf8))) as? [String: Any]
        kind = (object?["kind"] as? String).flatMap(Kind.init(rawValue:)) ?? .unreachable
    }

    /// An engine call that failed: its message is the failure JSON when the
    /// engine classed it, anything else counts as unreachable.
    init(_ error: Error) {
        if case HealthEngine.EngineError.callFailed(let message) = error {
            self.init(json: message)
        } else {
            self.init(kind: .unreachable)
        }
    }

    init(kind: Kind) {
        self.kind = kind
    }

    /// What the Sync screen says. Every case tells the user their edits are safe,
    /// because they are: the phone keeps them until the cloud takes them (US-09 AC4).
    func words(_ provider: CloudProvider) -> String {
        switch kind {
        case .signIn: "\(provider.label) needs you to sign in again. Your changes are on this iPhone until then."
        case .tooNew: "A newer version of Health Roadmap wrote this record. Update the app to sync. Your changes are on this iPhone."
        case .unreachable: "\(provider.label) could not be reached. Your changes are on this iPhone, and go up when it answers."
        }
    }
}
