import XCTest
@testable import HealthRoadmap

/// US-25 AC11: the web APIs ios/engine/shim.ts builds over the Swift natives
/// (EngineNatives), run in the app's own JavaScriptCore: fetch over URLSession,
/// timers on the main queue, abort, and UTF-8. Node runs the same shim against
/// a fake native in ios/engine/shim.test.ts.
@MainActor
final class ShimTests: XCTestCase {
    private let port = TokenPort()

    /// The engine on a stubbed session. Requests go to an allowed Dropbox call with the
    /// sentinel, as the adapters send them (EngineHTTP, US-25 AC18).
    private func engine() throws -> HealthEngine {
        let engine = try HealthEngine(session: StubHTTP.session())
        engine.blocking { [port] in $0.attach(port, phone: PhoneFiles(record: nil, pending: nil)) }
        return engine
    }

    func testFetchSendsTheRequestAndReadsTheAnswer() async throws {
        var seen: StubHTTP.Request?
        StubHTTP.handler = { request in
            seen = request
            return .init(status: 201, headers: ["Dropbox-API-Result": #"{"rev":"r1"}"#], body: Data("ok µmol ✓".utf8))
        }
        let engine = try engine()
        let answer = try await engine.settleScript("""
            fetch('https://content.dropboxapi.com/2/files/upload', {
              method: 'POST', headers: { Authorization: 'Bearer native-token:dropbox' }, body: '{"value":"é"}',
            }).then(async (res) => [res.ok, res.status, res.headers.get('dropbox-api-result'), await res.text()].join('|'))
            """)
        XCTAssertEqual(answer, #"true|201|{"rev":"r1"}|ok µmol ✓"#)
        XCTAssertEqual(seen?.method, "POST")
        XCTAssertEqual(seen?.headers["authorization"], "Bearer real-token")
        XCTAssertEqual(seen.map { String(decoding: $0.body, as: UTF8.self) }, #"{"value":"é"}"#)
    }

    func testABlobBodyIsSentWhole() async throws {
        var body = ""
        StubHTTP.handler = { request in
            body = String(decoding: request.body, as: UTF8.self)
            return .init()
        }
        let engine = try engine()
        _ = try await engine.settleScript("fetch('https://content.dropboxapi.com/2/files/upload', { method: 'POST', headers: { Authorization: 'Bearer native-token:dropbox' }, body: new Blob(['--b\\r\\n', 'é', new Uint8Array([33])]) }).then(r => r.status)")
        XCTAssertEqual(body, "--b\r\né!")
    }

    func testANetworkFailureIsATypeError() async throws {
        StubHTTP.handler = { _ in .init(offline: true) }
        let engine = try engine()
        let answer = try await engine.settleScript("fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: 'Bearer native-token:dropbox' } }).then(() => 'ok', (e) => String(e instanceof TypeError))")
        XCTAssertEqual(answer, "true")
    }

    func testAnAbortCancelsTheRequest() async throws {
        StubHTTP.handler = { _ in .init(hang: true) }
        StubHTTP.stopped = 0
        let engine = try engine()
        _ = try await engine.settleScript("""
            globalThis.c = new AbortController();
            globalThis.p = fetch('https://content.dropboxapi.com/2/files/download', { method: 'POST', headers: { Authorization: 'Bearer native-token:dropbox' }, signal: c.signal }).then(() => 'ok', (e) => e.name); 0
            """)
        try await Task.sleep(for: .milliseconds(50))
        _ = try await engine.settleScript("c.abort()")
        let answer = try await engine.settleScript("p")
        XCTAssertEqual(answer, "AbortError")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(StubHTTP.stopped, 1, "the URLSession task was cancelled")
    }

    func testAbortSignalTimeoutFiresOnTheNativeTimer() async throws {
        let engine = try engine()
        let answer = try await engine.settleScript("""
            new Promise((done) => { const s = AbortSignal.timeout(10); s.addEventListener('abort', () => done(s.reason.name)); })
            """)
        XCTAssertEqual(answer, "TimeoutError")
    }

    func testTimersRunInOrderAndClearTimeoutStopsOne() async throws {
        let engine = try engine()
        let answer = try await engine.settleScript("""
            new Promise((done) => {
              const seen = [];
              setTimeout(() => seen.push('b'), 30);
              setTimeout((x) => seen.push(x), 5, 'a');
              clearTimeout(setTimeout(() => seen.push('never'), 10));
              setTimeout(() => done(seen.join(',')), 80);
            })
            """)
        XCTAssertEqual(answer, "a,b")
    }

    func testTextCodingRoundTripsUTF8() throws {
        let engine = try engine()
        XCTAssertEqual(try engine.blocking { try $0.evaluate("Array.from(new TextEncoder().encode('é')).join(',')").toString() }, "195,169")
        XCTAssertEqual(try engine.blocking { try $0.evaluate("new TextDecoder().decode(new TextEncoder().encode('µmol/L ✓'))").toString() }, "µmol/L ✓")
    }
}
