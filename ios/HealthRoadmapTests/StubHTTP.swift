import Foundation
@testable import HealthRoadmap

/// A URLProtocol that answers every request from a test's handler, so the
/// engine's fetch (EngineNatives) and the OAuth client run against fakes.
/// One handler at a time: the tests that use it run one after another.
final class StubHTTP: URLProtocol {
    struct Answer {
        var status = 200
        var headers: [String: String] = [:]
        var body = Data()
        /// Never answer: the request hangs until it is cancelled.
        var hang = false
        /// Fail as a dead network does.
        var offline = false
        /// Answer after this many seconds (an open still in flight).
        var delay: TimeInterval = 0
    }

    /// The request as the handler sees it, body read from its stream.
    struct Request {
        let method: String
        let url: URL
        let headers: [String: String]
        let body: Data
    }

    nonisolated(unsafe) static var handler: (Request) -> Answer = { _ in Answer(status: 500) }
    nonisolated(unsafe) static var stopped = 0

    /// A session whose every request comes here.
    static func session(configuration: URLSessionConfiguration = .ephemeral) -> URLSession {
        configuration.protocolClasses = [StubHTTP.self]
        return URLSession(configuration: configuration)
    }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody ?? Data()
        if let stream = request.httpBodyStream {
            stream.open()
            var buffer = [UInt8](repeating: 0, count: 65_536)
            while stream.hasBytesAvailable {
                let read = stream.read(&buffer, maxLength: buffer.count)
                if read <= 0 { break }
                body.append(buffer, count: read)
            }
            stream.close()
        }
        var headers: [String: String] = [:]
        for (name, value) in request.allHTTPHeaderFields ?? [:] { headers[name.lowercased()] = value }
        let answer = Self.handler(Request(method: request.httpMethod ?? "GET", url: request.url!, headers: headers, body: body))
        if answer.hang { return }
        if answer.offline {
            client?.urlProtocol(self, didFailWithError: URLError(.notConnectedToInternet))
            return
        }
        let response = HTTPURLResponse(url: request.url!, statusCode: answer.status, httpVersion: "HTTP/1.1", headerFields: answer.headers)!
        // A 3xx with a Location is offered to the session as a redirect; a session that
        // follows it sends the new request back here, one that refuses gets the 3xx.
        if (300..<400).contains(answer.status), let location = answer.headers["Location"], let target = URL(string: location) {
            client?.urlProtocol(self, wasRedirectedTo: URLRequest(url: target), redirectResponse: response)
        }
        let deliver = { [self] in
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: answer.body)
            client?.urlProtocolDidFinishLoading(self)
        }
        if answer.delay > 0 {
            let later = MainQueueOnly(deliver)
            DispatchQueue.global().asyncAfter(deadline: .now() + answer.delay) { later.value() }
        } else {
            deliver()
        }
    }

    override func stopLoading() {
        Self.stopped += 1
    }
}
