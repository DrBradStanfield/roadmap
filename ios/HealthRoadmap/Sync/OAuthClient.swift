import Foundation

/// Signs in to Dropbox or Google Drive and keeps the access token fresh
/// (US-25 AC11). PKCE throughout: the phone holds no client secret, and no
/// server sees a token. The browser step is passed in (`Authenticate`), which
/// the Sync screen gives from SwiftUI's `webAuthenticationSession`.
@MainActor
final class OAuthClient {
    /// Opens the provider's sign-in page and answers the URL it redirected to.
    typealias Authenticate = (_ url: URL, _ callbackScheme: String) async throws -> URL

    enum Failure: LocalizedError, Equatable {
        case cancelled
        case refused(String)
        /// The provider no longer honours the refresh token: sign in again.
        case signInAgain
        case unreachable(String)

        var errorDescription: String? {
            switch self {
            case .cancelled: "Sign-in was cancelled."
            case .refused(let why): why
            case .signInAgain: "Sign in again to keep syncing."
            case .unreachable(let why): why
            }
        }
    }

    /// A finished sign-in, not yet kept: the caller checks the account first.
    struct SignedIn: Sendable {
        let provider: CloudProvider
        let tokens: OAuthTokens
        /// Which account signed in: Dropbox's `account_id`, or Drive's
        /// `about.user.permissionId` (drive.file gives no email or id token).
        let account: String
    }

    private let tokens: TokenStore
    private let session: URLSession
    private let now: () -> Date
    /// The provider's client id; tests pass one for Google before the real one exists.
    private let clientId: (CloudProvider) -> String
    /// One refresh at a time per provider: two saves asking at once share it.
    private var refreshing: [CloudProvider: Task<OAuthTokens, Error>] = [:]

    init(tokens: TokenStore = TokenStore(), session: URLSession = .shared, now: @escaping () -> Date = Date.init,
         clientId: @escaping (CloudProvider) -> String = { $0.clientId }) {
        self.tokens = tokens
        self.session = session
        self.now = now
        self.clientId = clientId
    }

    func isSignedIn(_ provider: CloudProvider) -> Bool {
        tokens.load(provider) != nil
    }

    /// The authorize URL for one sign-in.
    func authorizeURL(_ provider: CloudProvider, pkce: PKCE) -> URL {
        var parts = URLComponents(url: provider.authorizeURL, resolvingAgainstBaseURL: false)!
        let query = [
            "client_id": clientId(provider),
            "response_type": "code",
            "redirect_uri": provider.redirectURI,
            "code_challenge": pkce.challenge,
            "code_challenge_method": "S256",
            "state": pkce.state,
        ].merging(provider.extraAuthorizeParameters) { $1 }
        parts.queryItems = query.sorted { $0.key < $1.key }.map { URLQueryItem(name: $0.key, value: $0.value) }
        return parts.url!
    }

    /// Sign in and exchange the code. Nothing is kept until `keep`: a sign-in
    /// as another account must not replace the connected one's tokens.
    func signIn(_ provider: CloudProvider, authenticate: Authenticate) async throws -> SignedIn {
        guard !clientId(provider).isEmpty else { throw Failure.refused("\(provider.label) sign-in is not set up in this build yet.") }
        let pkce = PKCE()
        let returned: URL
        do {
            returned = try await authenticate(authorizeURL(provider, pkce: pkce), provider.callbackScheme)
        } catch {
            throw Failure.cancelled
        }
        let code = try Self.code(from: returned, state: pkce.state)
        let answer = try await post(provider, [
            "grant_type": "authorization_code",
            "code": code,
            "client_id": clientId(provider),
            "redirect_uri": provider.redirectURI,
            "code_verifier": pkce.verifier,
        ])
        guard let refresh = answer.refreshToken else { throw Failure.refused("\(provider.label) gave no lasting sign-in. Try again.") }
        // drive.file is the whole access; a user who unticked it gave the app nothing.
        if provider == .googleDrive, !(answer.scope ?? "").split(separator: " ").contains(Substring(CloudProvider.driveFileScope)) {
            throw Failure.refused("Allow access to the files this app creates in Google Drive, or the record cannot sync.")
        }
        let kept = OAuthTokens(accessToken: answer.accessToken, refreshToken: refresh, expiresAt: expiry(answer))
        let account = provider == .dropbox ? answer.accountId : try await driveAccount(answer.accessToken)
        guard let account, !account.isEmpty else { throw Failure.refused("\(provider.label) did not say which account signed in. Try again.") }
        return SignedIn(provider: provider, tokens: kept, account: account)
    }

    /// Keep a sign-in's tokens in the Keychain.
    func keep(_ signedIn: SignedIn) throws {
        try tokens.save(signedIn.tokens, for: signedIn.provider)
    }

    /// Drive's stable id for the signed-in user. `about` answers under drive.file.
    private func driveAccount(_ accessToken: String) async throws -> String? {
        var request = URLRequest(url: URL(string: "https://www.googleapis.com/drive/v3/about?fields=user(permissionId)")!)
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await session.data(for: request), (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw Failure.unreachable("Google Drive did not answer. Check the connection and try again.")
        }
        let about = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        return (about?["user"] as? [String: Any])?["permissionId"] as? String
    }

    /// A current access token, refreshed a minute before it expires, or now when `force`.
    func accessToken(_ provider: CloudProvider, force: Bool) async throws -> String {
        guard let saved = tokens.load(provider) else { throw Failure.signInAgain }
        if !force, now() < saved.expiresAt.addingTimeInterval(-60) { return saved.accessToken }
        if let running = refreshing[provider] { return try await running.value.accessToken }
        let task = Task { try await self.refresh(provider, saved) }
        refreshing[provider] = task
        defer { refreshing[provider] = nil }
        return try await task.value.accessToken
    }

    /// Forget the tokens. The cloud file is untouched.
    func signOut(_ provider: CloudProvider) {
        tokens.delete(provider)
    }

    private func refresh(_ provider: CloudProvider, _ saved: OAuthTokens) async throws -> OAuthTokens {
        let answer = try await post(provider, [
            "grant_type": "refresh_token",
            "refresh_token": saved.refreshToken,
            "client_id": clientId(provider),
        ])
        // Google may rotate the refresh token; Dropbox keeps the one it gave.
        let next = OAuthTokens(accessToken: answer.accessToken, refreshToken: answer.refreshToken ?? saved.refreshToken, expiresAt: expiry(answer))
        try tokens.save(next, for: provider)
        return next
    }

    private func expiry(_ answer: TokenAnswerBody) -> Date {
        now().addingTimeInterval(TimeInterval(answer.expiresIn ?? 3600))
    }

    /// The code in the redirect, if the redirect is ours and carries one.
    static func code(from url: URL, state: String) throws -> String {
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in items.first { $0.name == name }?.value }
        guard value("state") == state else { throw Failure.refused("That sign-in did not come from this app. Try again.") }
        if value("error") == "access_denied" { throw Failure.cancelled }
        guard let code = value("code"), !code.isEmpty else { throw Failure.refused("The sign-in returned no code. Try again.") }
        return code
    }

    private struct TokenAnswerBody: Decodable {
        let accessToken: String
        let refreshToken: String?
        let expiresIn: Int?
        let scope: String?
        let accountId: String?
        enum CodingKeys: String, CodingKey {
            case accessToken = "access_token", refreshToken = "refresh_token", expiresIn = "expires_in", scope, accountId = "account_id"
        }
    }

    /// One form POST to the token endpoint. A 400 or 401 means the grant is gone.
    private func post(_ provider: CloudProvider, _ form: [String: String]) async throws -> TokenAnswerBody {
        var request = URLRequest(url: provider.tokenURL)
        request.httpMethod = "POST"
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(Self.formBody(form).utf8)
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            throw Failure.unreachable("\(provider.label) did not answer. Check the connection and try again.")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 400 || status == 401 { throw Failure.signInAgain }
        guard status == 200, let body = try? JSONDecoder().decode(TokenAnswerBody.self, from: data) else {
            throw Failure.unreachable("\(provider.label) sign-in failed (\(status)). Try again.")
        }
        return body
    }

    /// application/x-www-form-urlencoded, every reserved character escaped.
    static func formBody(_ form: [String: String]) -> String {
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-._~"))
        return form.sorted { $0.key < $1.key }
            .map { "\($0.key)=\($0.value.addingPercentEncoding(withAllowedCharacters: allowed) ?? "")" }
            .joined(separator: "&")
    }
}
