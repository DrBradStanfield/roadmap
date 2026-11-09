import Foundation

/// The documents My health lists (US-73 AC12): reading a listed document's original. Split out of
/// RecordStore.swift to keep it under the file-size ratchet (US-64 AC23).
extension RecordStore {
    /// A listed document's original (US-73 AC12), as the web's "View original file" reads it: from
    /// the cloud the record is in, by the document's id. On the phone alone there is no cloud to read.
    enum Original: Equatable {
        case file(Data)
        case noCloud
        case failed(Failure)
    }

    /// Why an original did not load (PR 972 review R6), from the engine's failure JSON.
    enum Failure: Equatable {
        /// The cloud refused the sign-in.
        case signIn
        /// No network, or the cloud did not answer.
        case unreachable
        /// The cloud record is still opening.
        case opening
        /// The record names no original for this document (deleted on another device, say).
        case missing
        /// This engine has no door for originals, or the cloud gave nothing.
        case unavailable
    }

    func original(of id: String) async -> Original {
        guard cloudErase != nil else { return .noCloud }
        do {
            guard let data = try await engine.documentOriginal(id: id), !data.isEmpty else { return .failed(.unavailable) }
            return .file(data)
        } catch {
            return .failed(Self.failure(error))
        }
    }

    /// The engine's rejection, read as `SyncProblem` reads a save's: the door's own kinds first.
    nonisolated static func failure(_ error: Error) -> Failure {
        if case HealthEngine.EngineError.callFailed(let message) = error,
           let object = (try? JSONSerialization.jsonObject(with: Data(message.utf8))) as? [String: Any] {
            switch object["kind"] as? String {
            case "not-open": return .opening
            case "no-original": return .missing
            default: break
            }
        }
        return SyncProblem(error).kind == .signIn ? .signIn : .unreachable
    }
}
