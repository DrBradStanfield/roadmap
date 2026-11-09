import Foundation

/// The documents My health lists (US-73 AC12): reading a listed document's original. Split out of
/// RecordStore.swift to keep it under the file-size ratchet (US-64 AC23).
extension RecordStore {
    /// A listed document's original (US-73 AC12), as the web's "View original file" reads it: from
    /// the cloud the record is in, by the document's id. On the phone alone there is no cloud to read.
    enum Original: Equatable {
        case file(Data)
        case noCloud
        case failed
    }

    func original(of id: String) async -> Original {
        guard cloudErase != nil else { return .noCloud }
        guard let data = try? await engine.documentOriginal(id: id), !data.isEmpty else { return .failed }
        return .file(data)
    }
}
