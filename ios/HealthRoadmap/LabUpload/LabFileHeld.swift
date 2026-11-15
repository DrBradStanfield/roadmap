import Foundation

extension LabFileReader {
    /// What one upload holds, by the upload state's file id (US-52 AC7f; health-core
    /// upload-flow.ts runs `list`, `hash`, `convert` and `forget` on it): a picked file's or ZIP's
    /// bytes, and a ZIP member by where it sits in its ZIP, inflated only while it is hashed or
    /// converted. A value: the runner keeps it and hands a copy to each read off its actor.
    struct Held: Sendable {
        private enum Item: Sendable {
            case bytes(name: String, Data)
            case member(zip: String, ZipReader.Entry)
        }
        private var items: [String: Item] = [:]

        /// Holds a picked file's or ZIP's bytes under `id`; `name` is how a read names it.
        mutating func hold(_ data: Data, as id: String, name: String) { items[id] = .bytes(name: name, data) }

        /// Drops what `ids` hold. A forgotten ZIP takes its members' bytes with it: they then read as unreadable.
        mutating func forget(_ ids: [String]) { for id in ids { items[id] = nil } }

        /// Every file member of a held ZIP, from its central directory alone, no member's bytes read and
        /// no rule applied: health-core's `listed` judges each. Member `n` is held as `<zip id>#<n>`.
        mutating func list(_ zip: String) throws -> [(id: String, entry: ZipReader.Entry)] {
            guard case .bytes(_, let data)? = items[zip] else { throw Failure.unreadable(zip) }
            return try ZipReader.entries(of: data).enumerated().map { index, entry in
                let id = "\(zip)#\(index)"
                items[id] = .member(zip: zip, entry)
                return (id, entry)
            }
        }

        /// One file's or member's 'sha256-<hex>', the web's sha256Blob format.
        func hash(_ id: String) throws -> String { contentHash(try data(id).bytes) }

        /// One file or member turned into its pages, as a picked file is (PDF text or JPEG pages).
        func convert(_ id: String, rules: Rules) throws -> Document {
            let (name, bytes, member) = try data(id)
            var read = try document(from: bytes, name: name, rules: rules)
            read.zipMember = member
            return read
        }

        /// The bytes `id` holds, a member's inflated now (at most a file's cap), with its name and,
        /// for a member, its ZIP and path. A member is named `<zip name>/<path>`.
        private func data(_ id: String) throws -> (name: String, bytes: Data, member: ZipMember?) {
            switch items[id] {
            case .bytes(let name, let data)?: return (name, data, nil)
            case .member(let zip, let entry)?:
                guard case .bytes(let zipName, let archive)? = items[zip] else { throw Failure.unreadable(id) }
                return ("\(zipName)/\(entry.name)", try ZipReader.data(of: entry, in: archive, maxBytes: maxFileBytes),
                        ZipMember(zip: zipName, path: entry.name))
            case nil: throw Failure.unreadable(id)
            }
        }
    }
}
