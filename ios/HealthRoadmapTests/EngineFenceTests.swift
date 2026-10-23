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

    // Review R2: query parameters and headers are allow-listed per route.

    private let drive = "{ Authorization: 'Bearer native-token:google-drive' }"

    func testDropboxTakesNoQueryParameters() async throws {
        let answer = try await fetch("https://content.dropboxapi.com/2/files/download?arg=x")
        XCTAssertEqual(answer, "refused")
        let list = try await fetch("https://api.dropboxapi.com/2/files/list_folder?cursor=1")
        XCTAssertEqual(list, "refused")
        XCTAssertTrue(seen.isEmpty)
    }

    func testDriveTakesOnlyTheParametersItsAdapterSends() async throws {
        let list = try await fetch("https://www.googleapis.com/drive/v3/files?q=name%3D%27x%27&spaces=drive&fields=files(id)&pageSize=1", method: "GET", headers: drive)
        XCTAssertEqual(list, "200")
        let media = try await fetch("https://www.googleapis.com/drive/v3/files/abc?alt=media", method: "GET", headers: drive)
        XCTAssertEqual(media, "200")
        let upload = try await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,version", headers: drive)
        XCTAssertEqual(upload, "200")
        XCTAssertEqual(seen.count, 3)
        for url in ["https://www.googleapis.com/drive/v3/files?q=x&corpora=allDrives",
                    "https://www.googleapis.com/drive/v3/files/abc?alt=media&supportsAllDrives=true",
                    "https://www.googleapis.com/drive/v3/files/abc?uploadType=media"] {
            let answer = try await fetch(url, method: "GET", headers: drive)
            XCTAssertEqual(answer, "refused", url)
        }
        XCTAssertEqual(seen.count, 3)
    }

    func testACredentialInTheQueryIsRefusedInAnyCase() async throws {
        for name in ["access_token", "Authorization", "OAUTH_TOKEN", "key", "Key", "fields&access_token"] {
            let answer = try await fetch("https://www.googleapis.com/drive/v3/files/abc?\(name)=t", method: "GET", headers: drive)
            XCTAssertEqual(answer, "refused", name)
        }
        XCTAssertTrue(seen.isEmpty)
    }

    func testOnlyTheAdaptersHeadersPass() async throws {
        let known = try await fetch("https://content.dropboxapi.com/2/files/upload",
                                    headers: "{ Authorization: 'Bearer native-token:dropbox', 'Content-Type': 'application/octet-stream', 'Dropbox-API-Arg': '{}', Accept: '*/*' }")
        XCTAssertEqual(known, "200")
        for extra in ["'X-Forward-To': 'evil.example'", "Origin: 'https://evil.example'", "'Proxy-Authorization': 'x'"] {
            let answer = try await fetch("https://content.dropboxapi.com/2/files/upload", headers: "{ Authorization: 'Bearer native-token:dropbox', \(extra) }")
            XCTAssertEqual(answer, "refused", extra)
        }
        XCTAssertEqual(seen.count, 1)
    }

    func testTheUploadBranchesLabCallsPass() async throws {
        // labFolderJson, labFolderFilesJson (recursive: the same route, a body Swift does not read) and labFile: files/list_folder and files/download, no query.
        let list = try await fetch("https://api.dropboxapi.com/2/files/list_folder",
                                   headers: "{ Authorization: 'Bearer native-token:dropbox', 'Content-Type': 'application/json' }")
        XCTAssertEqual(list, "200")
        let download = try await fetch("https://content.dropboxapi.com/2/files/download",
                                       headers: "{ Authorization: 'Bearer native-token:dropbox', 'Dropbox-API-Arg': '{\"path\":\"/a.pdf\"}' }")
        XCTAssertEqual(download, "200")
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
