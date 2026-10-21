import XCTest
@testable import HealthRoadmap

/// US-25 AC8: the web APIs ios/engine/shim.ts builds over the Swift natives
/// (EngineNatives), run in the app's own JavaScriptCore: fetch over URLSession,
/// timers on the main queue, abort, and UTF-8. Node runs the same shim against
/// a fake native in ios/engine/shim.test.ts.
@MainActor
final class ShimTests: XCTestCase {
    private func engine() throws -> HealthEngine {
        try HealthEngine(session: StubHTTP.session())
    }

    func testFetchSendsTheRequestAndReadsTheAnswer() async throws {
        var seen: StubHTTP.Request?
        StubHTTP.handler = { request in
            seen = request
            return .init(status: 201, headers: ["Dropbox-API-Result": #"{"rev":"r1"}"#], body: Data("ok µmol ✓".utf8))
        }
        let engine = try engine()
        let answer = try await engine.settle(engine.evaluate("""
            fetch('https://content.dropboxapi.com/2/files/upload', {
              method: 'POST', headers: { Authorization: 'Bearer t' }, body: '{"value":"é"}',
            }).then(async (res) => [res.ok, res.status, res.headers.get('dropbox-api-result'), await res.text()].join('|'))
            """))
        XCTAssertEqual(answer, #"true|201|{"rev":"r1"}|ok µmol ✓"#)
        XCTAssertEqual(seen?.method, "POST")
        XCTAssertEqual(seen?.headers["authorization"], "Bearer t")
        XCTAssertEqual(seen.map { String(decoding: $0.body, as: UTF8.self) }, #"{"value":"é"}"#)
    }

    func testABlobBodyIsSentWhole() async throws {
        var body = ""
        StubHTTP.handler = { request in
            body = String(decoding: request.body, as: UTF8.self)
            return .init()
        }
        let engine = try engine()
        _ = try await engine.settle(engine.evaluate("fetch('https://x.test/u', { method: 'POST', body: new Blob(['--b\\r\\n', 'é', new Uint8Array([33])]) }).then(r => r.status)"))
        XCTAssertEqual(body, "--b\r\né!")
    }

    func testANetworkFailureIsATypeError() async throws {
        StubHTTP.handler = { _ in .init(offline: true) }
        let engine = try engine()
        let answer = try await engine.settle(engine.evaluate("fetch('https://x.test').then(() => 'ok', (e) => String(e instanceof TypeError))"))
        XCTAssertEqual(answer, "true")
    }

    func testAnAbortCancelsTheRequest() async throws {
        StubHTTP.handler = { _ in .init(hang: true) }
        StubHTTP.stopped = 0
        let engine = try engine()
        let pending = try engine.evaluate("""
            globalThis.c = new AbortController();
            fetch('https://x.test/slow', { signal: c.signal }).then(() => 'ok', (e) => e.name)
            """)
        try await Task.sleep(for: .milliseconds(50))
        _ = try engine.evaluate("c.abort()")
        let answer = try await engine.settle(pending)
        XCTAssertEqual(answer, "AbortError")
        try await Task.sleep(for: .milliseconds(50))
        XCTAssertEqual(StubHTTP.stopped, 1, "the URLSession task was cancelled")
    }

    func testAbortSignalTimeoutFiresOnTheNativeTimer() async throws {
        let engine = try engine()
        let answer = try await engine.settle(engine.evaluate("""
            new Promise((done) => { const s = AbortSignal.timeout(10); s.addEventListener('abort', () => done(s.reason.name)); })
            """))
        XCTAssertEqual(answer, "TimeoutError")
    }

    func testTimersRunInOrderAndClearTimeoutStopsOne() async throws {
        let engine = try engine()
        let answer = try await engine.settle(engine.evaluate("""
            new Promise((done) => {
              const seen = [];
              setTimeout(() => seen.push('b'), 30);
              setTimeout((x) => seen.push(x), 5, 'a');
              clearTimeout(setTimeout(() => seen.push('never'), 10));
              setTimeout(() => done(seen.join(',')), 80);
            })
            """))
        XCTAssertEqual(answer, "a,b")
    }

    func testTextCodingRoundTripsUTF8() throws {
        let engine = try engine()
        XCTAssertEqual(try engine.evaluate("Array.from(new TextEncoder().encode('é')).join(',')").toString(), "195,169")
        XCTAssertEqual(try engine.evaluate("new TextDecoder().decode(new TextEncoder().encode('µmol/L ✓'))").toString(), "µmol/L ✓")
    }
}
