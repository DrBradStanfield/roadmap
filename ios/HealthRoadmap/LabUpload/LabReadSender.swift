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
        /// A real refusal before any stream, or no answer at all (nil status): `sendFailed`.
        case refused(status: Int?, body: String?, contentType: String?)
    }
    /// No answer at all: the network failure, which Try again mends.
    static let noAnswer = Outcome.refused(status: nil, body: nil, contentType: nil)

    var attest: AppAttestClient = .shared
    /// The whole request's limit, stream included: keep-alive lines reset URLSession's idle
    /// timer, so only this ends a read that never finishes.
    var deadline: Duration = .seconds(150)

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

    /// Sends `body` and answers how it ended. Throws only CancellationError: an abort cancels the
    /// request itself, and nothing is answered for it.
    func send(_ body: Data) async throws -> Outcome {
        let attest = attest
        let outcome = try await withThrowingTaskGroup(of: Outcome.self) { group in
            group.addTask { try await Self.request(body, attest: attest) }
            group.addTask { try await Task.sleep(for: deadline); return Self.noAnswer }
            defer { group.cancelAll() }
            return try await group.next() ?? Self.noAnswer
        }
        try Task.checkCancellation()
        return outcome
    }

    private static func request(_ body: Data, attest: AppAttestClient) async throws -> Outcome {
        do {
            switch try await attest.open(path, body: body) {
            case .refused(let http, let text):
                return .refused(status: http.statusCode, body: String(decoding: text, as: UTF8.self),
                                contentType: http.value(forHTTPHeaderField: "Content-Type"))
            case .open(let bytes, _):
                return .ended(line: try await finalLine(bytes.lines))
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            try Task.checkCancellation()
            // No answer, or one cut short: the network failure, which Try again mends.
            return noAnswer
        }
    }

    /// The stream's last line, skipping blank keep-alive lines and the `{"accepted":true}` line;
    /// nil when there is none. A stream cut short answers what it had: a whole last line, or nil.
    static func finalLine<Lines: AsyncSequence>(_ lines: Lines) async throws -> String? where Lines.Element == String {
        var last: String?
        do {
            for try await line in lines {
                let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed.isEmpty || trimmed == #"{"accepted":true}"# { continue }
                last = line
            }
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            try Task.checkCancellation()
        }
        return last
    }
}
