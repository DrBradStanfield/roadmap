import XCTest
@testable import HealthRoadmap

/// US-25 AC11: the sign-in pieces. Tokens live in the Keychain, this device
/// only; PKCE matches RFC 7636; a token is refreshed with no client secret,
/// and a refused refresh asks the user to sign in again.
@MainActor
final class SignInTests: XCTestCase {
    private var tokens: TokenStore!

    override func setUp() async throws {
        tokens = TokenStore(service: "test.\(UUID().uuidString)")
    }

    override func tearDown() async throws {
        for provider in CloudProvider.allCases { tokens.delete(provider) }
    }

    func testTokensRoundTripInTheKeychainThisDeviceOnly() throws {
        let saved = OAuthTokens(accessToken: "a", refreshToken: "r", expiresAt: Date(timeIntervalSince1970: 2_000_000_000))
        try tokens.save(saved, for: .dropbox)
        XCTAssertEqual(tokens.load(.dropbox), saved)
        XCTAssertNil(tokens.load(.googleDrive))
        XCTAssertEqual(tokens.accessibility(.dropbox), kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        var next = saved
        next.accessToken = "b"
        try tokens.save(next, for: .dropbox)
        XCTAssertEqual(tokens.load(.dropbox)?.accessToken, "b")
        tokens.delete(.dropbox)
        XCTAssertNil(tokens.load(.dropbox))
    }

    func testPKCEMatchesTheRFCExample() {
        let pkce = PKCE(verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk", state: "s")
        XCTAssertEqual(pkce.challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")
        XCTAssertNotEqual(PKCE().verifier, PKCE().verifier)
    }

    func testTheDropboxAuthorizeURLAsksForOfflineAccessWithTheWebsApp() throws {
        let url = OAuthClient(tokens: tokens).authorizeURL(.dropbox, pkce: PKCE(verifier: "v", state: "s"))
        let query = Dictionary(uniqueKeysWithValues: (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(query["client_id"], "xf96vqvjotm5xhx")
        XCTAssertEqual(query["redirect_uri"], "db-xf96vqvjotm5xhx://2/token")
        XCTAssertEqual(query["token_access_type"], "offline")
        XCTAssertEqual(query["code_challenge_method"], "S256")
        XCTAssertEqual(query["state"], "s")
    }

    func testARedirectFromAnotherSignInIsRefused() throws {
        XCTAssertEqual(try OAuthClient.code(from: URL(string: "db-x://2/token?code=c1&state=s")!, state: "s"), "c1")
        XCTAssertThrowsError(try OAuthClient.code(from: URL(string: "db-x://2/token?code=c1&state=other")!, state: "s"))
        XCTAssertThrowsError(try OAuthClient.code(from: URL(string: "db-x://2/token?error=access_denied&state=s")!, state: "s")) {
            XCTAssertEqual($0 as? OAuthClient.Failure, .cancelled)
        }
    }

    func testSignInExchangesTheCodeWithTheVerifierAndKeepsTheTokens() async throws {
        var form = ""
        StubHTTP.handler = { request in
            // The token exchange's form; the account call after it has a JSON body.
            if request.url.path == "/oauth2/token" { form = String(decoding: request.body, as: UTF8.self) }
            return .init(body: Data(#"{"access_token":"a1","refresh_token":"r1","expires_in":14400,"account_id":"dbid:1"}"#.utf8))
        }
        let client = OAuthClient(tokens: tokens, session: StubHTTP.session())
        let signedIn = try await client.signIn(.dropbox) { url, scheme in
            XCTAssertEqual(scheme, "db-xf96vqvjotm5xhx")
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "db-xf96vqvjotm5xhx://2/token?code=the-code&state=\(state)")!
        }
        XCTAssertTrue(form.contains("grant_type=authorization_code"))
        XCTAssertTrue(form.contains("code=the-code"))
        XCTAssertTrue(form.contains("code_verifier="))
        XCTAssertTrue(form.contains("redirect_uri=db-xf96vqvjotm5xhx%3A%2F%2F2%2Ftoken"))
        XCTAssertFalse(form.contains("secret"))
        XCTAssertNil(tokens.load(.dropbox), "nothing is kept before the caller checks the account")
        try client.keep(signedIn)
        XCTAssertEqual(tokens.load(.dropbox)?.refreshToken, "r1")
    }

    func testAnExpiredTokenIsRefreshedAndAForcedOneToo() async throws {
        try tokens.save(OAuthTokens(accessToken: "old", refreshToken: "r1", expiresAt: .now.addingTimeInterval(30)), for: .dropbox)
        var forms: [String] = []
        StubHTTP.handler = { request in
            forms.append(String(decoding: request.body, as: UTF8.self))
            return .init(body: Data(#"{"access_token":"new\#(forms.count)","expires_in":14400}"#.utf8))
        }
        let client = OAuthClient(tokens: tokens, session: StubHTTP.session())
        let fresh = try await client.accessToken(.dropbox, force: false)
        XCTAssertEqual(fresh, "new1", "inside its last minute the token is refreshed")
        let kept = try await client.accessToken(.dropbox, force: false)
        XCTAssertEqual(kept, "new1")
        let forced = try await client.accessToken(.dropbox, force: true)
        XCTAssertEqual(forced, "new2")
        XCTAssertTrue(forms.allSatisfy { $0.contains("grant_type=refresh_token") && $0.contains("refresh_token=r1") })
        XCTAssertEqual(tokens.load(.dropbox)?.refreshToken, "r1", "Dropbox keeps its refresh token")
    }

    func testARefusedRefreshAsksToSignInAgain() async throws {
        try tokens.save(OAuthTokens(accessToken: "old", refreshToken: "revoked", expiresAt: .distantPast), for: .dropbox)
        StubHTTP.handler = { _ in .init(status: 400, body: Data(#"{"error":"invalid_grant"}"#.utf8)) }
        let client = OAuthClient(tokens: tokens, session: StubHTTP.session())
        do {
            _ = try await client.accessToken(.dropbox, force: false)
            XCTFail("a revoked grant cannot give a token")
        } catch {
            XCTAssertEqual(error as? OAuthClient.Failure, .signInAgain)
        }
    }

    /// Adversary A6: the account a sign-in belongs to. Dropbox names it in the token
    /// answer; Google with drive.file only does not, so Drive's about.user.permissionId.
    func testSignInAnswersTheAccountForEachProvider() async throws {
        StubHTTP.handler = { request in
            if request.url.host == "www.googleapis.com" {
                XCTAssertEqual(request.headers["authorization"], "Bearer g1")
                return .init(body: Data(#"{"user":{"permissionId":"perm-7"}}"#.utf8))
            }
            if request.url.host == "oauth2.googleapis.com" {
                return .init(body: Data(#"{"access_token":"g1","refresh_token":"gr","expires_in":3600,"scope":"https://www.googleapis.com/auth/drive.file"}"#.utf8))
            }
            return .init(body: Data(#"{"access_token":"a1","refresh_token":"r1","expires_in":14400,"account_id":"dbid:XYZ"}"#.utf8))
        }
        let client = OAuthClient(tokens: tokens, session: StubHTTP.session(), clientId: { $0 == .googleDrive ? "123-abc.apps.googleusercontent.com" : $0.clientId })
        let back: OAuthClient.Authenticate = { url, _ in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "x:/r?code=c&state=\(state)")!
        }
        let dropbox = try await client.signIn(.dropbox, authenticate: back)
        XCTAssertEqual(dropbox.account, "dbid:XYZ")
        let drive = try await client.signIn(.googleDrive, authenticate: back)
        XCTAssertEqual(drive.account, "perm-7")
        try client.keep(dropbox)
        XCTAssertEqual(tokens.load(.dropbox)?.refreshToken, "r1")
    }

    /// US-25 AC11e (2026-10-22): the email Sync names the account by, from what each
    /// provider gives under the scopes already asked for: Dropbox's get_current_account
    /// (the web's accountEmail, verified only, lower-cased) and Drive's about.user.
    func testSignInAnswersTheEmailEachProviderGivesAndNeverFailsWithoutIt() async throws {
        /// What the stub answers and saw; StubHTTP runs off the main thread.
        final class Stub: @unchecked Sendable {
            private let lock = NSLock()
            private var answer = StubHTTP.Answer(body: Data(#"{"email":"Brad@Example.com","email_verified":true}"#.utf8))
            private var fields = ""
            private var accountCalls: [StubHTTP.Request] = []
            var accountAnswer: StubHTTP.Answer {
                get { lock.withLock { answer } }
                set { lock.withLock { answer = newValue } }
            }
            var aboutFields: String {
                get { lock.withLock { fields } }
                set { lock.withLock { fields = newValue } }
            }
            var calls: [StubHTTP.Request] { lock.withLock { accountCalls } }
            func called(_ request: StubHTTP.Request) { lock.withLock { accountCalls.append(request) } }
        }
        let stub = Stub()
        StubHTTP.handler = { @Sendable request in // nonisolated: StubHTTP calls it off the main thread
            if request.url.host == "www.googleapis.com" {
                stub.aboutFields = URLComponents(url: request.url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "fields" }?.value ?? ""
                return .init(body: Data(#"{"user":{"permissionId":"perm-7","emailAddress":"g@example.com"}}"#.utf8))
            }
            if request.url.host == "oauth2.googleapis.com" {
                return .init(body: Data(#"{"access_token":"g1","refresh_token":"gr","expires_in":3600,"scope":"https://www.googleapis.com/auth/drive.file"}"#.utf8))
            }
            if request.url.path == "/2/users/get_current_account" {
                stub.called(request)
                return stub.accountAnswer
            }
            return .init(body: Data(#"{"access_token":"a1","refresh_token":"r1","expires_in":14400,"account_id":"dbid:XYZ"}"#.utf8))
        }
        let client = OAuthClient(tokens: tokens, session: StubHTTP.session(), clientId: { $0 == .googleDrive ? "123-abc.apps.googleusercontent.com" : $0.clientId })
        let back: OAuthClient.Authenticate = { url, _ in
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "x:/r?code=c&state=\(state)")!
        }
        let verified = try await client.signIn(.dropbox, authenticate: back)
        XCTAssertEqual(verified.email, "brad@example.com")
        XCTAssertEqual(stub.calls.map(\.method), ["POST"])
        XCTAssertEqual(stub.calls.first?.headers["authorization"], "Bearer a1")
        stub.accountAnswer = .init(body: Data(#"{"email":"brad@example.com","email_verified":false}"#.utf8))
        let unverified = try await client.signIn(.dropbox, authenticate: back)
        XCTAssertNil(unverified.email, "an unverified email is not shown, as on the web")
        stub.accountAnswer = .init(status: 500)
        let failed = try await client.signIn(.dropbox, authenticate: back)
        XCTAssertNil(failed.email)
        XCTAssertEqual(failed.account, "dbid:XYZ", "the sign-in still works without an email")
        let drive = try await client.signIn(.googleDrive, authenticate: back)
        XCTAssertEqual(drive.email, "g@example.com")
        XCTAssertTrue(stub.aboutFields.contains("emailAddress"), stub.aboutFields)
    }
}
