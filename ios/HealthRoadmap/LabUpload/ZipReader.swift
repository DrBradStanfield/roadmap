import Compression
import Foundation

/// Reads the files in a ZIP (US-52 AC7), as the web's zip-extract.ts does for a
/// downloaded results bundle. Only what a lab bundle uses: stored or deflated
/// members, no encryption, no ZIP64. Sizes are capped before anything inflates,
/// so a small file cannot expand into a huge one. Members are listed from the
/// central directory alone and each is inflated only when asked for (AC7f).
enum ZipReader {
    /// A member as the central directory lists it: where its bytes sit, none of them read.
    struct Entry: Sendable {
        let name: String
        let flags: UInt16, method: UInt16
        let compressed: Int, size: Int, local: Int
    }

    enum Failure: LocalizedError {
        case notAZip, unsupported, tooLarge
        var errorDescription: String? {
            switch self {
            case .notAZip: "This ZIP could not be read."
            case .unsupported: "This ZIP uses a format the app cannot open. Unzip it in Files, then pick the reports."
            case .tooLarge: "A file inside this ZIP is too large."
            }
        }
    }

    /// Every file member, folders skipped, from the central directory alone: no member's bytes
    /// are read. What a read asks the upload rules about, and what health-core's `listed` takes.
    static func entries(of zip: Data) throws -> [Entry] {
        try walk(zip).filter { !$0.name.hasSuffix("/") }
    }

    /// Refuses, before anything is copied, what the reader cannot take among the members it will
    /// read: encryption, ZIP64, a stored member whose sizes differ, and the caps (each member once
    /// inflated, members, and bytes in all).
    static func check(_ members: [Entry], maxMemberBytes: Int, maxMembers: Int = 200, maxTotalBytes: Int = 100 * 1024 * 1024) throws {
        var total = 0
        for (count, entry) in members.enumerated() {
            if entry.flags & 0x1 != 0 || entry.compressed == 0xFFFF_FFFF || entry.size == 0xFFFF_FFFF { throw Failure.unsupported }
            // A stored member is its own bytes: one that declares a different size is lying.
            if entry.method == 0, entry.compressed != entry.size { throw Failure.notAZip }
            // The archive cap counts bytes kept, so entries that share one payload add up.
            guard entry.size <= maxMemberBytes, total + entry.size <= maxTotalBytes, count < maxMembers else { throw Failure.tooLarge }
            total += entry.size
        }
    }

    /// One member's bytes, copied or inflated now, to exactly its listed size, at most `maxBytes`:
    /// checked first, so a member read on its own is refused as it would be in a whole-ZIP read.
    static func data(of entry: Entry, in zip: Data, maxBytes: Int) throws -> Data {
        try check([entry], maxMemberBytes: maxBytes, maxTotalBytes: maxBytes)
        guard entry.local + 30 <= zip.count, u32(zip, entry.local) == 0x0403_4b50 else { throw Failure.notAZip }
        let start = entry.local + 30 + Int(u16(zip, entry.local + 26)) + Int(u16(zip, entry.local + 28))
        guard start + entry.compressed <= zip.count else { throw Failure.notAZip }
        let raw = zip[(zip.startIndex + start)..<(zip.startIndex + start + entry.compressed)]
        switch entry.method {
        case 0: return Data(raw)
        case 8: return try inflate(raw, size: entry.size)
        default: throw Failure.unsupported
        }
    }

    /// The central directory's entries in order.
    private static func walk(_ bytes: Data) throws -> [Entry] {
        // The end of central directory record: the last "PK\u{5}\u{6}" within the final 64 KB + 22.
        guard bytes.count >= 22 else { throw Failure.notAZip }
        var end = -1
        var i = bytes.count - 22
        let floor = max(0, bytes.count - 22 - 65_535)
        while i >= floor {
            if u32(bytes, i) == 0x0605_4b50 { end = i; break }
            i -= 1
        }
        guard end >= 0 else { throw Failure.notAZip }
        let count = Int(u16(bytes, end + 10))
        var at = Int(u32(bytes, end + 16))
        var entries: [Entry] = []
        for _ in 0..<count {
            guard at + 46 <= bytes.count, u32(bytes, at) == 0x0201_4b50 else { throw Failure.notAZip }
            let nameLength = Int(u16(bytes, at + 28))
            let extraLength = Int(u16(bytes, at + 30))
            let commentLength = Int(u16(bytes, at + 32))
            guard at + 46 + nameLength <= bytes.count else { throw Failure.notAZip }
            let entry = Entry(name: String(decoding: bytes[(bytes.startIndex + at + 46)..<(bytes.startIndex + at + 46 + nameLength)], as: UTF8.self),
                              flags: u16(bytes, at + 8), method: u16(bytes, at + 10),
                              compressed: Int(u32(bytes, at + 20)), size: Int(u32(bytes, at + 24)), local: Int(u32(bytes, at + 42)))
            at += 46 + nameLength + extraLength + commentLength
            entries.append(entry)
        }
        return entries
    }

    /// Raw DEFLATE (Apple's `COMPRESSION_ZLIB` is raw, as ZIP stores it), to exactly `size` bytes.
    private static func inflate(_ data: Data, size: Int) throws -> Data {
        if size == 0 { return Data() }
        var output = Data(count: size)
        let written = output.withUnsafeMutableBytes { out in
            data.withUnsafeBytes { input in
                compression_decode_buffer(
                    out.bindMemory(to: UInt8.self).baseAddress!, size,
                    input.bindMemory(to: UInt8.self).baseAddress!, data.count,
                    nil, COMPRESSION_ZLIB)
            }
        }
        guard written == size else { throw Failure.notAZip }
        return output
    }

    /// Little-endian reads at an offset from the archive's first byte (a `Data` slice starts elsewhere).
    private static func u16(_ b: Data, _ i: Int) -> UInt16 { UInt16(b[b.startIndex + i]) | UInt16(b[b.startIndex + i + 1]) << 8 }
    private static func u32(_ b: Data, _ i: Int) -> UInt32 { UInt32(u16(b, i)) | UInt32(u16(b, i + 2)) << 16 }
}
