import Foundation

/// One `send` effect of the shared upload (design PR 14, US-52 AC7e): a file's pages POSTed to the
/// streaming lab route, its answer handed back unread, for the engine to read (`uploadStepJson`).
/// It decides nothing: no retry, no limit, no reading of the answer beyond its framing.
struct LabReadSender: Sendable {
    static let path = "/api/app/v1/lab-read"

    /// What the request asks for, as the effect's `flags` say (health-core requestFlags).
    struct Flags: Decodable, Sendable {
        let ownDates: Bool
        let undatedPrev: Bool
        let refusedRows: Bool
    }

    /// How the request ended, as the engine's events take it.
    enum Outcome: Sendable, Equatable {
        /// 200: the stream's final line exactly as received, nil when it ended with none (`streamEnded`).
        case ended(line: String?)
        /// A refusal before any stream, any status but 200: `sendFailed`.
        case refused(status: Int, body: String, contentType: String?)
        /// No lab-read answer, as the phone saw it: `sendFailed` with `local` (US-52 AC7e).
        case local(Local)
    }

    /// What the phone saw instead of a lab-read answer (upload-doors.ts LOCAL).
    enum Local: Sendable, Equatable {
        /// This device cannot prove the app.
        case cannotAttest
        /// The proof failed at App Attest's `stage`, with `code`, each a short word.
        case attestFailed(stage: String, code: String)
        /// The App Attest registration was refused, with the words today's iPhone shows.
        case refused(status: Int, message: String)
        /// An answer the app could not read.
        case badAnswer
        /// How the request failed on the way.
        case timeout, dropped, unreachable

        var wire: [String: Any] {
            switch self {
            case .cannotAttest: ["kind": "cannotAttest"]
            case .attestFailed(let stage, let code): ["kind": "attestFailed", "stage": stage, "code": code]
            case .refused(let status, let message): ["kind": "refused", "status": status, "message": String(message.prefix(2000))]
            case .badAnswer: ["kind": "badAnswer"]
            case .timeout: ["kind": "timeout"]
            case .dropped: ["kind": "dropped"]
            case .unreachable: ["kind": "unreachable"]
            }
        }

        /// A request that failed on the way, by its URLError, as AppAttestClient.words tells them apart.
        static func of(_ error: URLError) -> Local {
            switch error.code {
            case .timedOut: .timeout
            case .networkConnectionLost: .dropped
            default: .unreachable
            }
        }
    }

    var attest: AppAttestClient = .shared
    /// From the send's start until its headers arrive: waiting behind other sends for the App
    /// Attest lock and uploading the body. Generous, so a send queued behind four slow uploads
    /// is never cut off for waiting.
    var openDeadline: Duration = .seconds(600)
    /// From the headers to the stream's end: the server's read has 90 s after them. Keep-alive
    /// lines reset URLSession's idle timer, so only this ends a read that never finishes.
    var readDeadline: Duration = .seconds(120)

    /// The request body: the pages, the unit system, and each flag only when true, as the
    /// server's schema takes them (`labImportRequestSchema`: literal true or absent).
    static func body(pages: [LabFileReader.Page], unitSystem: String, flags: Flags) throws -> Data {
        struct Body: Encodable {
            let pages: [LabFileReader.Page]
            let unitSystem: String
            let ownDates: Bool?
            let undatedPrev: Bool?
            let refusedRows: Bool?
        }
        let on = { (flag: Bool) in flag ? true : nil }
        return try JSONEncoder().encode(Body(pages: pages, unitSystem: unitSystem, ownDates: on(flags.ownDates),
                                             undatedPrev: on(flags.undatedPrev), refusedRows: on(flags.refusedRows)))
    }

    /// Sends `body` and answers how it ended, once. Throws only CancellationError: an abort
    /// cancels the request itself, and nothing is answered for it.
    func send(_ body: Data) async throws -> Outcome {
        let attest = attest
        let opened: AppAttestClient.Opened?
        do {
            opened = try await Self.within(openDeadline) { try await attest.open(Self.path, body: body) }
        } catch {
            return try Self.local(error)
        }
        switch opened {
        case nil: return .local(.timeout)
        case .refused(let http, let text)?: return Self.refused(http, text)
        case .open(let bytes, let http)? where http.statusCode != 200:
            // Only 200 is accepted; another 2xx is the server's failure, read by the engine.
            return Self.refused(http, (try? await AppAttestClient.errorText(bytes)) ?? Data())
        case .open(let bytes, _)?:
            do {
                // Past the read deadline (nil), too long; else the stream's end.
                let line: String?? = try await Self.within(readDeadline) { try await Self.finalLine(bytes) }
                return line.map { .ended(line: $0) } ?? .local(.timeout)
            } catch {
                return try Self.local(error)
            }
        }
    }

    /// What a thrown request means for the engine. Throws CancellationError: an abort answers nothing.
    private static func local(_ error: Error) throws -> Outcome {
        try Task.checkCancellation()
        switch error {
        case is CancellationError: throw CancellationError()
        case AppAttestClient.Failure.notSupported: return .local(.cannotAttest)
        case AppAttestClient.Failure.device(let stage, let code): return .local(Self.attestFailed(stage, code))
        // The registration's refusal (its words, or the app's when it gave none) or its challenge's.
        case AppAttestClient.Failure.server(let status, let message) where (100...599).contains(status): return .local(.refused(status: status, message: message))
        case AppAttestClient.Failure.badResponse: return .local(.badAnswer)
        case let url as URLError: return .local(.of(url))
        default: return .local(.unreachable)
        }
    }

    /// An App Attest step and code as the engine takes them: letters, digits, dash and underscore,
    /// at most 24 each (health-core ATTEST_PART). A code from outside DeviceCheck reads "<domain>
    /// <code>": the code is kept whole and the domain shortened to fit beside it.
    static func attestFailed(_ stage: String, _ code: String) -> Local {
        let parts = code.split(separator: " ")
        guard parts.count > 1, let number = parts.last else { return .attestFailed(stage: word(stage), code: word(code)) }
        let tail = word(String(number))
        let room = max(0, 24 - tail.count - 1)
        let domain = word(parts.dropLast().joined(separator: " ")).prefix(room)
        return .attestFailed(stage: word(stage), code: domain.isEmpty ? tail : "\(domain)_\(tail)")
    }

    /// Letters, digits, dash and underscore, at most 24; anything else, a domain's dots or a space, becomes "_".
    static func word(_ text: String) -> String {
        let kept = text.unicodeScalars.map { $0.isASCII && (CharacterSet.alphanumerics.contains($0) || $0 == "-" || $0 == "_") ? Character($0) : "_" }
        return kept.isEmpty ? "_" : String(kept.prefix(24))
    }

    private static func refused(_ http: HTTPURLResponse, _ text: Data) -> Outcome {
        .refused(status: http.statusCode, body: String(decoding: text, as: UTF8.self), contentType: http.value(forHTTPHeaderField: "Content-Type"))
    }

    /// `work`'s answer, or nil once `limit` passes (`work` is then cancelled, its request with it).
    private static func within<T: Sendable>(_ limit: Duration, _ work: @escaping @Sendable () async throws -> T) async throws -> T? {
        try await withThrowingTaskGroup(of: T?.self) { group in
            group.addTask { try await work() }
            group.addTask { try await Task.sleep(for: limit); return nil }
            defer { group.cancelAll() }
            return try await group.next() ?? nil
        }
    }

    /// The stream's last line, skipping blank keep-alive lines and the `{"accepted":true}` line;
    /// nil when there is none. Lines end at byte 0x0A only (one trailing 0x0D dropped) and
    /// are read as UTF-8: JSON keeps U+2028, U+2029 and U+0085 unescaped, and they are never line
    /// ends. A stream cut short answers its whole last line when it had one, else throws its error.
    static func finalLine<Bytes: AsyncSequence>(_ bytes: Bytes) async throws -> String? where Bytes.Element == UInt8 {
        let accepted = Array(#"{"accepted":true}"#.utf8)
        var last: [UInt8]?
        var line: [UInt8] = []
        func end() {
            if line.last == 0x0D { line.removeLast() }
            if line.contains(where: { $0 != 0x20 && $0 != 0x09 }), line != accepted { last = line }
            line = []
        }
        do {
            for try await byte in bytes {
                if byte == 0x0A { end() } else { line.append(byte) }
            }
            if !line.isEmpty { end() }
        } catch {
            try Task.checkCancellation()
            guard last != nil else { throw error }
        }
        return last.map { String(decoding: $0, as: UTF8.self) }
    }
}
