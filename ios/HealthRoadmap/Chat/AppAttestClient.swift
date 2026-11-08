import CryptoKit
import DeviceCheck
import Foundation
import Security

/// Sends the app's requests to Brad's server, each proved with Apple App Attest
/// (US-52 AC1, ios/architecture.md D8). The key is made and attested once; its id
/// lives in the Keychain (this device only). Every request carries an assertion
/// over its method, path and body hash.
///
/// One instance for the app (`shared`): the key's counter rises with each
/// assertion, so signing and sending are serialised until the response headers
/// arrive (the server checks the counter before any slow work).
actor AppAttestClient {
    static let shared = AppAttestClient()

    enum Failure: LocalizedError {
        case notSupported
        case server(status: Int, message: String)
        case badResponse
        /// An App Attest call on the phone failed: which one (`key`, `attest`, `assert`) and
        /// its error code, so a report says where it broke without the error's own text (US-52 AC1c).
        case device(stage: String, code: String)

        var errorDescription: String? {
            switch self {
            case .notSupported: "Chat and lab upload need a device that can prove the app is genuine (Apple App Attest). This device cannot."
            case .device(let stage, let code): "This iPhone could not prove the app is genuine, so nothing was sent. Please try again. (App Attest \(stage) \(code))"
            case .server(_, let message): message
            case .badResponse: "The server's answer could not be read."
            }
        }
    }

    /// A request that failed on the way, in plain words, never URLSession's ("The request
    /// timed out.", US-52 AC6d, AC7a). `subject` is what was asked: "The chat".
    static func words(for error: URLError, subject: String) -> String {
        switch error.code {
        case .timedOut: "\(subject) took too long to answer. Please try again."
        case .networkConnectionLost: "The connection dropped before the answer finished. Please try again."
        default: "\(subject) could not be reached. Check your connection, then try again."
        }
    }

    private let session: URLSession
    private let service: any AttestService
    private var busy = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    init(session: URLSession = URLSession(configuration: .ephemeral), service: any AttestService = AppleAttest()) {
        self.session = session
        self.service = service
    }

    /// POSTs `body` to `path` and returns the open response once its headers have
    /// arrived. A 401 for a lost key or a stale counter is retried once, with a new
    /// key or a fresh assertion. Any other non-2xx status throws with the server's words, or
    /// plain ones when it gave none (a gateway's HTML page; US-52 AC6d).
    func post(_ path: String, body: Data) async throws -> (URLSession.AsyncBytes, HTTPURLResponse) {
        await acquire()
        defer { release() }
        for attempt in 0..<2 {
            var request = URLRequest(url: ServerConfig.baseURL.appending(path: path))
            request.httpMethod = "POST"
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.timeoutInterval = 120
            try await sign(&request, path: path, body: body)
            let (bytes, response) = try await session.bytes(for: request)
            guard let http = response as? HTTPURLResponse else { throw Failure.badResponse }
            if (200..<300).contains(http.statusCode) { return (bytes, http) }
            let answer = try await Self.errorAnswer(bytes)
            if http.statusCode == 401, attempt == 0, ["unknown_key", "stale_counter"].contains(answer.reason) {
                if answer.reason == "unknown_key" { Keychain.delete() }
                continue
            }
            throw Failure.server(status: http.statusCode, message: answer.error ?? "The server could not answer just now. Please try again later.")
        }
        throw Failure.badResponse
    }

    // MARK: Signing

    private func sign(_ request: inout URLRequest, path: String, body: Data) async throws {
        #if DEBUG && targetEnvironment(simulator)
        // The simulator has no App Attest. A local server with the bypass on
        // accepts this header; production refuses it (US-52 AC3). A test's
        // stand-in service takes the device path below.
        if service is AppleAttest {
            request.setValue(Self.simulatorId(), forHTTPHeaderField: "X-App-Attest-Dev")
            return
        }
        #endif
        guard service.isSupported else { throw Failure.notSupported }
        let (keyId, assertion) = try await assertion(Data(SHA256.hash(data: Self.clientData(path: path, body: body))))
        request.setValue(keyId, forHTTPHeaderField: "X-App-Attest-Key")
        request.setValue(assertion.base64EncodedString(), forHTTPHeaderField: "X-App-Attest-Assertion")
    }

    /// An assertion from the stored key or, when there is none or it cannot sign, from a
    /// new key, once (US-52 AC1c). The Keychain id outlives a delete and reinstall but the
    /// key does not, and iOS reports that with more than one error code, not only
    /// `invalidKey`: so any failure of the stored key makes a new one.
    private func assertion(_ clientDataHash: Data) async throws -> (String, Data) {
        if let stored = Keychain.read() {
            do { return (stored, try await service.generateAssertion(stored, clientDataHash: clientDataHash)) } catch {
                try Task.checkCancellation()
                Keychain.delete()
            }
        }
        let keyId = try await registerKey()
        return (keyId, try await device("assert") { try await service.generateAssertion(keyId, clientDataHash: clientDataHash) })
    }

    /// One App Attest call; its failure becomes `.device`, named by stage and code (US-52 AC1c).
    private func device<T: Sendable>(_ stage: String, _ call: () async throws -> T) async throws -> T {
        do { return try await call() } catch {
            try Task.checkCancellation()
            let error = error as NSError
            throw Failure.device(stage: stage, code: error.domain == DCErrorDomain ? "\(error.code)" : "\(error.domain) \(error.code)")
        }
    }

    /// What the app signs for one request (D8): method, path, and the hex SHA-256 of the raw body.
    static func clientData(path: String, body: Data) -> Data {
        let bodyHash = SHA256.hash(data: body).map { String(format: "%02x", $0) }.joined()
        return Data("POST\n\(path)\n\(bodyHash)".utf8)
    }

    /// A new key, attested and registered with the server, then stored.
    private func registerKey() async throws -> String {
        let keyId = try await device("key") { try await service.generateKey() }
        let challenge = try await challenge()
        let attestation = try await device("attest") { try await service.attestKey(keyId, clientDataHash: Data(SHA256.hash(data: Data(challenge.utf8)))) }
        let body = try JSONSerialization.data(withJSONObject: ["keyId": keyId, "attestation": attestation.base64EncodedString(), "challenge": challenge])
        var request = URLRequest(url: ServerConfig.baseURL.appending(path: "/api/app/v1/attest/register"))
        request.httpMethod = "POST"
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let answer = try? JSONDecoder().decode(ErrorAnswer.self, from: data)
            throw Failure.server(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: answer?.error ?? "The app could not be registered with the server.")
        }
        Keychain.save(keyId)
        return keyId
    }

    private func challenge() async throws -> String {
        var request = URLRequest(url: ServerConfig.baseURL.appending(path: "/api/app/v1/attest/challenge"))
        request.httpMethod = "POST"
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let challenge = object["challenge"] as? String
        else { throw Failure.server(status: (response as? HTTPURLResponse)?.statusCode ?? 0, message: "Chat is not available right now. Please try again later.") }
        return challenge
    }

    #if DEBUG && targetEnvironment(simulator)
    private static func simulatorId() -> String {
        let key = "simulatorAttestId"
        if let id = UserDefaults.standard.string(forKey: key) { return id }
        let id = "sim-" + UUID().uuidString.prefix(8).lowercased()
        UserDefaults.standard.set(id, forKey: key)
        return id
    }
    #endif

    // MARK: Errors

    struct ErrorAnswer: Decodable {
        let error: String?
        let reason: String?
    }

    private static func errorAnswer(_ bytes: URLSession.AsyncBytes) async throws -> ErrorAnswer {
        var data = Data()
        for try await byte in bytes {
            data.append(byte)
            if data.count > 16_384 { break }
        }
        return (try? JSONDecoder().decode(ErrorAnswer.self, from: data)) ?? ErrorAnswer(error: nil, reason: nil)
    }

    // MARK: The lock (actors are re-entrant across awaits, so this is explicit)

    private func acquire() async {
        if !busy { busy = true; return }
        await withCheckedContinuation { waiters.append($0) }
    }

    private func release() {
        if waiters.isEmpty { busy = false } else { waiters.removeFirst().resume() }
    }
}

/// The parts of `DCAppAttestService` the client uses, so a test can stand in for it (US-52 AC1c).
protocol AttestService: Sendable {
    var isSupported: Bool { get }
    func generateKey() async throws -> String
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data
}

/// Apple's App Attest.
struct AppleAttest: AttestService {
    var isSupported: Bool { DCAppAttestService.shared.isSupported }
    func generateKey() async throws -> String { try await DCAppAttestService.shared.generateKey() }
    func attestKey(_ keyId: String, clientDataHash: Data) async throws -> Data { try await DCAppAttestService.shared.attestKey(keyId, clientDataHash: clientDataHash) }
    func generateAssertion(_ keyId: String, clientDataHash: Data) async throws -> Data { try await DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: clientDataHash) }
}

/// The App Attest key id in the Keychain: this device only, readable after first unlock.
/// Not private: the reinstall test plants a stale id (US-52 AC1c).
enum Keychain {
    private static var query: [String: Any] { [
        kSecClass as String: kSecClassGenericPassword,
        kSecAttrService as String: "com.drstanfield.healthroadmap.appattest",
        kSecAttrAccount as String: "keyId",
    ] }

    static func read() -> String? {
        var item: CFTypeRef?
        var search = query
        search[kSecReturnData as String] = true
        guard SecItemCopyMatching(search as CFDictionary, &item) == errSecSuccess, let data = item as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    static func save(_ keyId: String) {
        delete()
        var item = query
        item[kSecValueData as String] = Data(keyId.utf8)
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    static func delete() {
        SecItemDelete(query as CFDictionary)
    }
}
