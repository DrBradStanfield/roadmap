import Foundation
import os

extension LabFileReader {
    /// What one upload holds, by the upload state's file id (US-52 AC7f; health-core
    /// upload-flow.ts runs `list`, `hash`, `convert` and `forget` on it): a picked file's or ZIP's
    /// bytes, a listed ZIP's members by where each sits, inflated only while it is hashed or
    /// converted, and each converted file's pages for its send. Shared by the runner's reads: a
    /// lock guards the records, never an inflate or a convert.
    final class Held: Sendable {
        /// A listed ZIP's members, the rules it was listed with, and the bytes its members have
        /// inflated so far, each member counted once, held to the rules' total.
        private struct Listing {
            let entries: [ZipReader.Entry]
            let rules: Rules
            var counted: Set<Int> = []
            var inflated = 0
            /// Members forgotten by their own ids; once all are, the ZIP's record goes.
            var forgotten: Set<Int> = []
        }
        /// `listing` lives in the ZIP's own record, so holding the id again or forgetting it drops it.
        private struct Item {
            let name: String
            let data: Data
            var listing: Listing?
        }
        /// Files and ZIPs by id; pages by the id converted, a file's or a member's.
        private struct Records {
            var items: [String: Item] = [:]
            var pages: [String: [Page]] = [:]
        }
        private let records = OSAllocatedUnfairLock(initialState: Records())

        /// Holds a picked file's or ZIP's bytes under `id`, replacing what it held; `name` is how a read names it.
        func hold(_ data: Data, as id: String, name: String) { records.withLock { $0.items[id] = Item(name: name, data: data) } }

        /// Drops what `ids` hold, pages included. A forgotten ZIP takes its members with it. A member
        /// forgotten by its own id (upload-flow.ts forgets members, never their ZIP once listed) reads
        /// as unreadable, its siblings stay, and the ZIP's bytes go with its last member. An id never
        /// held is ignored.
        func forget(_ ids: [String]) {
            records.withLock { records in
                for id in ids {
                    records.pages[id] = nil
                    if records.items.removeValue(forKey: id) != nil {
                        for page in records.pages.keys where Self.member(page)?.zip == id { records.pages[page] = nil }
                        continue
                    }
                    guard case let (zip, index)? = Self.member(id), let listing = records.items[zip]?.listing,
                          listing.entries.indices.contains(index) else { continue }
                    records.items[zip]?.listing?.forgotten.insert(index)
                    if listing.forgotten.union([index]).count == listing.entries.count { records.items[zip] = nil }
                }
            }
        }

        /// A member id's ZIP id and index: `<zip id>#<n>`.
        private static func member(_ id: String) -> (zip: String, index: Int)? {
            guard let mark = id.lastIndex(of: "#"), let index = Int(id[id.index(after: mark)...]) else { return nil }
            return (String(id[..<mark]), index)
        }

        /// The bytes held in all, files, ZIPs and converted pages: what a `forget` releases.
        var heldBytes: Int {
            records.withLock { records in
                records.items.values.reduce(0) { $0 + $1.data.count }
                    + records.pages.values.reduce(0) { $0 + $1.reduce(0) { $0 + $1.content.utf8.count } }
            }
        }

        /// The pages `convert` kept for `id`, until it is forgotten.
        func pages(_ id: String) -> [Page]? { records.withLock { $0.pages[id] } }

        /// Every file member of a held ZIP, from its central directory alone, no member's bytes read:
        /// health-core's `listed` judges each. The ZIP's size, and the members `rules` keep, are checked
        /// first as a whole-ZIP read checks them (`ZipReader.check`); a refusal refuses the ZIP. Member
        /// `n` is `<zip id>#<n>`, readable until the ZIP is held again or forgotten.
        func list(_ zip: String, rules: Rules) throws -> [(id: String, entry: ZipReader.Entry)] {
            let entries = try records.withLock { records in
                guard let held = records.items[zip] else { throw Failure.unreadable(zip) }
                guard rules.file(held.name, held.data.count) != .tooLarge else { throw Failure.tooLarge(held.name) }
                let entries = try ZipReader.entries(of: held.data)
                try ZipReader.check(entries.filter { rules.member($0.name) == .keep },
                                    maxMemberBytes: rules.maxMemberBytes, maxMembers: rules.maxMembers, maxTotalBytes: rules.maxTotalBytes)
                records.items[zip]?.listing = Listing(entries: entries, rules: rules)
                return entries
            }
            return entries.enumerated().map { ("\(zip)#\($0)", $1) }
        }

        /// One file's or member's 'sha256-<hex>', the web's sha256Blob format.
        func hash(_ id: String) throws -> String { contentHash(try read(id).bytes) }

        /// One file or member turned into its pages, as a picked file is (PDF text or JPEG pages);
        /// its pages are kept under `id` for its send until it is forgotten.
        func convert(_ id: String, rules: Rules) throws -> Document {
            let (name, bytes, member) = try read(id)
            var document = try document(from: bytes, name: name, rules: rules)
            document.zipMember = member
            let pages = document.pages
            records.withLock { $0.pages[id] = pages }
            return document
        }

        /// The bytes `id` holds, a member's inflated now, with its name (`<zip name>/<path>` for a
        /// member) and, for a member, its ZIP and path. A member is checked against its listing's
        /// caps, and refused once its ZIP's members would inflate more than the listing's total.
        private func read(_ id: String) throws -> (name: String, bytes: Data, member: ZipMember?) {
            enum Found { case file(String, Data), member(zip: String, Data, ZipReader.Entry, maxBytes: Int) }
            let found: Found = try records.withLock { records in
                if let item = records.items[id] { return .file(item.name, item.data) }
                guard case let (zipId, index)? = Self.member(id), let zip = records.items[zipId], let listing = zip.listing,
                      listing.entries.indices.contains(index), !listing.forgotten.contains(index)
                else { throw Failure.unreadable(id) }
                let entry = listing.entries[index], rules = listing.rules
                // Refused here as well as in `data(of:)`, so a member over its cap never counts against the total.
                try ZipReader.check([entry], maxMemberBytes: rules.maxMemberBytes, maxTotalBytes: rules.maxMemberBytes)
                if !listing.counted.contains(index) {
                    guard listing.inflated + entry.size <= rules.maxTotalBytes else { throw ZipReader.Failure.tooLarge }
                    records.items[zipId]?.listing?.counted.insert(index)
                    records.items[zipId]?.listing?.inflated += entry.size
                }
                return .member(zip: zip.name, zip.data, entry, maxBytes: rules.maxMemberBytes)
            }
            switch found {
            case .file(let name, let data): return (name, data, nil)
            case .member(let zip, let data, let entry, let maxBytes):
                return ("\(zip)/\(entry.name)", try ZipReader.data(of: entry, in: data, maxBytes: maxBytes), ZipMember(zip: zip, path: entry.name))
            }
        }
    }
}
