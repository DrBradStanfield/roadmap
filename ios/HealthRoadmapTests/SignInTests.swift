import XCTest
@testable import HealthRoadmap

/// US-25 AC8: the sign-in pieces. Tokens live in the Keychain, this device
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
            form = String(decoding: request.body, as: UTF8.self)
            return .init(body: Data(#"{"access_token":"a1","refresh_token":"r1","expires_in":14400}"#.utf8))
        }
        let client = OAuthClient(tokens: tokens, session: StubHTTP.session())
        try await client.signIn(.dropbox) { url, scheme in
            XCTAssertEqual(scheme, "db-xf96vqvjotm5xhx")
            let state = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!.first { $0.name == "state" }!.value!
            return URL(string: "db-xf96vqvjotm5xhx://2/token?code=the-code&state=\(state)")!
        }
        XCTAssertTrue(form.contains("grant_type=authorization_code"))
        XCTAssertTrue(form.contains("code=the-code"))
        XCTAssertTrue(form.contains("code_verifier="))
        XCTAssertTrue(form.contains("redirect_uri=db-xf96vqvjotm5xhx%3A%2F%2F2%2Ftoken"))
        XCTAssertFalse(form.contains("secret"))
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
}
