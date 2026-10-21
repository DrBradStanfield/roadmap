import Foundation

/// The fence around the engine's network (US-25 AC18, ios/architecture.md D3). Because
/// the engine can be updated over the air, Swift, not JavaScript, decides what it may
/// send: only the Dropbox and Google Drive calls health-core's dropbox-rest.ts and
/// drive-rest.ts make for the record, over https, with no redirect. JavaScript never
/// holds a token: it gets the sentinel `native-token:<provider>`, and Swift swaps in the
/// real token only on an allowed call for that provider. So no engine, however it was
/// changed, can send the record or a token anywhere new.
enum EngineHTTP {
    static let sentinelPrefix = "native-token:"

    struct Route: Equatable {
        let provider: String
        let method: String
        let host: String
        /// Path segments; "*" is one Drive file id.
        let path: [String]
        /// The query parameters this call may carry; Dropbox's carry none.
        var query: Set<String> = []
    }

    /// Every call the adapters make on the app's path, with the query parameters
    /// drive-rest.ts sends on each. Not here, because the app never makes them:
    /// Dropbox delete_v2, get_metadata and longpoll (documents and push are web-only),
    /// Drive DELETE and permissions. The upload branch's lab reads (files/list_folder,
    /// files/download, no query) are the first two Dropbox routes.
    static let routes: [Route] = [
        Route(provider: "dropbox", method: "POST", host: "content.dropboxapi.com", path: ["2", "files", "download"]),
        Route(provider: "dropbox", method: "POST", host: "content.dropboxapi.com", path: ["2", "files", "upload"]),
        Route(provider: "dropbox", method: "POST", host: "api.dropboxapi.com", path: ["2", "files", "list_folder"]),
        Route(provider: "dropbox", method: "POST", host: "api.dropboxapi.com", path: ["2", "files", "list_folder", "continue"]),
        Route(provider: "google-drive", method: "GET", host: "www.googleapis.com", path: ["drive", "v3", "files"],
              query: ["q", "spaces", "fields", "pageSize", "pageToken"]),
        Route(provider: "google-drive", method: "POST", host: "www.googleapis.com", path: ["drive", "v3", "files"], query: ["fields"]),
        Route(provider: "google-drive", method: "GET", host: "www.googleapis.com", path: ["drive", "v3", "files", "*"], query: ["fields", "alt"]),
        Route(provider: "google-drive", method: "POST", host: "www.googleapis.com", path: ["upload", "drive", "v3", "files"], query: ["uploadType", "fields"]),
        Route(provider: "google-drive", method: "PATCH", host: "www.googleapis.com", path: ["upload", "drive", "v3", "files", "*"], query: ["uploadType", "fields"]),
    ]

    /// The headers the adapters set (lowercase; the shim lowercases them), besides the sentinel.
    static let headers: Set<String> = ["content-type", "dropbox-api-arg", "accept", "content-length"]
    /// Credentials refused in a query whatever the route, in any case.
    static let credentialParameters: Set<String> = ["access_token", "authorization", "oauth_token", "key"]

    enum Refusal: Error, Equatable {
        /// Not an allowed method, host, path or query parameter.
        case notAllowed
        /// A header or query parameter that is not the adapters', or the wrong sentinel.
        case credentialHeader
    }

    /// The provider whose token this request may carry, and its headers without the
    /// sentinel; or why it is refused.
    static func check(method: String, url: URL, headers: [String: String]) -> Result<(provider: String, headers: [String: String]), Refusal> {
        guard url.scheme == "https", url.user == nil, url.password == nil, url.port == nil || url.port == 443,
              let host = url.host()?.lowercased()
        else { return .failure(.notAllowed) }
        let segments = url.path(percentEncoded: true).split(separator: "/", omittingEmptySubsequences: false).dropFirst().map(String.init)
        guard let route = routes.first(where: { $0.method == method.uppercased() && $0.host == host && matches($0.path, segments) }) else {
            return .failure(.notAllowed)
        }
        let names = (URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []).map(\.name)
        if names.contains(where: { credentialParameters.contains($0.lowercased()) }) { return .failure(.credentialHeader) }
        guard names.allSatisfy(route.query.contains), url.fragment == nil else { return .failure(.notAllowed) }
        var rest: [String: String] = [:]
        var authorization: String?
        for (name, value) in headers {
            let lower = name.lowercased()
            if lower == "authorization" {
                authorization = value
            } else if Self.headers.contains(lower) {
                rest[name] = value
            } else {
                return .failure(.credentialHeader)
            }
        }
        guard authorization == "Bearer \(sentinelPrefix)\(route.provider)" else { return .failure(.credentialHeader) }
        return .success((route.provider, rest))
    }

    private static func matches(_ pattern: [String], _ segments: [String]) -> Bool {
        guard pattern.count == segments.count else { return false }
        return zip(pattern, segments).allSatisfy { want, got in
            want == "*" ? !got.isEmpty && got.allSatisfy { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" } && got.allSatisfy(\.isASCII) : want == got
        }
    }

    /// The engine's own session: no cookies, no cache, a plain User-Agent, and no
    /// redirect followed. OAuthClient and chat keep their own sessions. One for the app:
    /// a session holds its delegate until invalidated, so engines share it.
    static let shared = session()

    static func session() -> URLSession {
        URLSession(configuration: configuration(), delegate: NoRedirects.shared, delegateQueue: nil)
    }

    static func configuration() -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.httpCookieAcceptPolicy = .never
        configuration.urlCache = nil
        configuration.urlCredentialStorage = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpAdditionalHeaders = ["User-Agent": "HealthRoadmap"]
        return configuration
    }
}

/// Refuses every redirect: the answer is the redirect itself, which the engine reads
/// as a failed call. Set on the session and on each task, so a test's session refuses too.
final class NoRedirects: NSObject, URLSessionTaskDelegate, Sendable {
    static let shared = NoRedirects()

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping @Sendable (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
