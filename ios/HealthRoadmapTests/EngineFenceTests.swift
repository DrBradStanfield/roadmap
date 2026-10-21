import XCTest
@testable import HealthRoadmap

/// The requests a stub saw, shared with its handler (which runs off the main actor).
final class RequestLog: @unchecked Sendable {
    var requests: [StubHTTP.Request] = []
}

/// A CloudPort that hands out one fixed token and keeps nothing.
@MainActor
final class TokenPort: CloudPort {
    var token = "real-token"
    func accessToken(provider: String, force: Bool) async -> TokenAnswer { .token(token) }
    func phoneRead() throws -> String? { nil }
    func phoneWrite(_ text: String) throws {}
    func phoneRemove() {}
    func pending(_ op: String) -> Bool { false }
    func notify(_ event: String, _ payload: String, session: Int) {}
}

/// US-25 AC18: the fence around the engine's network (EngineHTTP). JavaScript gets a
/// sentinel, never a token; Swift sends only the allow-listed Dropbox and Drive calls,
/// swaps the real token in, and follows no redirect.
@MainActor
final class EngineFenceTests: XCTestCase {
    private var engine: HealthEngine!
    private let port = TokenPort()
    private let log = RequestLog()
    private var seen: [StubHTTP.Request] { log.requests }

    override func setUpWithError() throws {
        engine = try HealthEngine(session: StubHTTP.session())
        engine.natives.cloud = port
        let log = log
        StubHTTP.handler = { request in
            log.requests.append(request)
            return .init(status: 200, body: Data("ok".utf8))
        }
    }

    /// Runs one fetch; answers its status, or "refused" when it never left.
    private func fetch(_ url: String, method: String = "POST", headers: String = "{ Authorization: 'Bearer native-token:dropbox' }") async throws -> String {
        try await engine.settle(engine.evaluate("""
            fetch('\(url)', { method: '\(method)', headers: \(headers) }).then((r) => String(r.status), () => 'refused')
            """))
    }

    func testJavaScriptGetsASentinelNeverTheToken() async throws {
        let answer = try await engine.settle(engine.evaluate("""
            new Promise((done) => __native.accessToken('dropbox', false, (token) => done(token)))
            """))
        XCTAssertEqual(answer, "native-token:dropbox")
    }

    func testAnAllowedCallGoesOutWithTheRealToken() async throws {
        let answer = try await fetch("https://content.dropboxapi.com/2/files/download")
        XCTAssertEqual(answer, "200")
        XCTAssertEqual(seen.first?.headers["authorization"], "Bearer real-token")
        let drive = try await fetch("https://www.googleapis.com/upload/drive/v3/files/abc_123-X?uploadType=media", method: "PATCH",
                                    headers: "{ Authorization: 'Bearer native-token:google-drive' }")
        XCTAssertEqual(drive, "200")
    }

    func testAForeignTokenOnAnAllowedHostIsRefused() async throws {
        let answer = try await fetch("https://content.dropboxapi.com/2/files/upload", headers: "{ Authorization: 'Bearer someone-elses-token' }")
        XCTAssertEqual(answer, "refused")
        XCTAssertTrue(seen.isEmpty)
    }

    func testOneProvidersSentinelNeverReachesTheOther() async throws {
        let answer = try await fetch("https://www.googleapis.com/drive/v3/files", method: "GET")
        XCTAssertEqual(answer, "refused")
        XCTAssertTrue(seen.isEmpty)
    }

    func testDropboxSharingIsRefused() async throws {
        let answer = try await fetch("https://api.dropboxapi.com/2/sharing/create_shared_link_with_settings")
        XCTAssertEqual(answer, "refused")
        XCTAssertTrue(seen.isEmpty)
    }

    func testADrivePermissionsCallIsRefused() async throws {
        let answer = try await fetch("https://www.googleapis.com/drive/v3/files/abc/permissions",
                                     headers: "{ Authorization: 'Bearer native-token:google-drive' }")
        XCTAssertEqual(answer, "refused")
        XCTAssertTrue(seen.isEmpty)
    }

    func testOffListPathsHostsAndSchemesAreRefused() async throws {
        for url in ["https://api.dropboxapi.com/2/files/delete_v2", "https://api.dropboxapi.com/2/users/get_current_account",
                    "https://evil.example/2/files/upload", "http://content.dropboxapi.com/2/files/upload",
                    "https://content.dropboxapi.com:8443/2/files/upload", "https://drstanfield.com/api/app/v1/chat"] {
            let answer = try await fetch(url)
            XCTAssertEqual(answer, "refused", url)
        }
        XCTAssertTrue(seen.isEmpty)
    }

    func testACookieOrNoAuthorizationIsRefused() async throws {
        let cookie = try await fetch("https://content.dropboxapi.com/2/files/download",
                                     headers: "{ Authorization: 'Bearer native-token:dropbox', Cookie: 'a=b' }")
        XCTAssertEqual(cookie, "refused")
        let bare = try await fetch("https://content.dropboxapi.com/2/files/download", headers: "{}")
        XCTAssertEqual(bare, "refused")
        XCTAssertTrue(seen.isEmpty)
    }

    func testARedirectToAForeignHostIsNotFollowed() async throws {
        let log = log
        StubHTTP.handler = { request in
            log.requests.append(request)
            return .init(status: 302, headers: ["Location": "https://evil.example/steal"])
        }
        let answer = try await fetch("https://content.dropboxapi.com/2/files/download")
        XCTAssertNotEqual(answer, "200")
        XCTAssertEqual(seen.map { $0.url.host() }, ["content.dropboxapi.com"], "the foreign host was never asked")
    }

    func testTheEnginesOwnSessionKeepsNothing() {
        let configuration = EngineHTTP.configuration()
        XCTAssertNil(configuration.httpCookieStorage)
        XCTAssertFalse(configuration.httpShouldSetCookies)
        XCTAssertNil(configuration.urlCache)
        XCTAssertNil(configuration.urlCredentialStorage)
        XCTAssertEqual(configuration.httpAdditionalHeaders?["User-Agent"] as? String, "HealthRoadmap")
        XCTAssertTrue(EngineHTTP.shared.delegate is NoRedirects)
    }
}
