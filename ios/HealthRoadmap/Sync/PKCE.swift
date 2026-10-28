import CryptoKit
import Foundation
import Security

/// Proof Key for Code Exchange (RFC 7636): how a phone app signs in with no
/// client secret. The web's twin is widget-src/src/storage/pkce.ts.
struct PKCE: Sendable {
    /// Kept on the phone and sent only with the code exchange.
    let verifier: String
    /// SHA-256 of the verifier, sent in the authorize URL.
    let challenge: String
    /// Round-trips through the provider; a return with another state is not ours.
    let state: String

    init() {
        self.init(verifier: Self.randomText(bytes: 32), state: Self.randomText(bytes: 16))
    }

    init(verifier: String, state: String) {
        self.verifier = verifier
        self.state = state
        challenge = Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }

    static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    private static func randomText(bytes count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        _ = SecRandomCopyBytes(kSecRandomDefault, count, &bytes)
        return base64URL(Data(bytes))
    }
}
