import Compression
import Foundation

/// Reads the files in a ZIP (US-52 AC7), as the web's zip-extract.ts does for a
/// downloaded results bundle. Only what a lab bundle uses: stored or deflated
/// members, no encryption, no ZIP64. Sizes are capped before anything inflates,
/// so a small file cannot expand into a huge one.
enum ZipReader {
    struct Member {
        let name: String
        let data: Data
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

    /// Every member whose name passes `keep`, each at most `maxMemberBytes` once inflated.
    static func members(of zip: Data, maxMemberBytes: Int, maxMembers: Int = 200, maxTotalBytes: Int = 100 * 1024 * 1024, keep: (String) -> Bool) throws -> [Member] {
        let bytes = [UInt8](zip)
        var out: [Member] = []
        var total = 0
        try walk(bytes) { entry in
            let (name, method, compressed, size, local) = (entry.name, entry.method, entry.compressed, entry.size, entry.local)
            if name.hasSuffix("/") || !keep(name) { return }
            if entry.flags & 0x1 != 0 || compressed == 0xFFFF_FFFF || size == 0xFFFF_FFFF { throw Failure.unsupported }
            // A stored member is its own bytes: one that declares a different size is lying.
            if method == 0, compressed != size { throw Failure.notAZip }
            // Per member, per archive and by count, checked before anything is copied; the
            // archive cap counts bytes kept, so entries that share one payload add up.
            guard size <= maxMemberBytes, total + size <= maxTotalBytes, out.count < maxMembers else { throw Failure.tooLarge }
            guard local + 30 <= bytes.count, u32(bytes, local) == 0x0403_4b50 else { throw Failure.notAZip }
            let start = local + 30 + Int(u16(bytes, local + 26)) + Int(u16(bytes, local + 28))
            guard start + compressed <= bytes.count else { throw Failure.notAZip }
            let raw = Data(bytes[start..<(start + compressed)])
            let data: Data
            switch method {
            case 0: data = raw
            case 8: data = try inflate(raw, size: size)
            default: throw Failure.unsupported
            }
            total += data.count
            out.append(Member(name: name, data: data))
        }
        return out
    }

    /// Each file member's path and declared size, nothing read: what a read asks the upload rules about.
    static func entries(of zip: Data) throws -> [(name: String, size: Int)] {
        var out: [(name: String, size: Int)] = []
        try walk([UInt8](zip)) { entry in if !entry.name.hasSuffix("/") { out.append((entry.name, entry.size)) } }
        return out
    }

    private struct Entry {
        let name: String
        let flags: UInt16, method: UInt16
        let compressed: Int, size: Int, local: Int
    }

    /// The central directory's entries in order, each handed to `visit` as soon as it is parsed.
    private static func walk(_ bytes: [UInt8], visit: (Entry) throws -> Void) throws {
        // The end of central directory record: the last "PK\u{5}\u{6}" within the final 64 KB + 22.
        guard bytes.count >= 22 else { throw Failure.notAZip }
        var end = -1
        var i = bytes.count - 22
        let floor = max(0, bytes.count - 22 - 65_535)
        while i >= floor {
            if bytes[i] == 0x50, bytes[i + 1] == 0x4b, bytes[i + 2] == 0x05, bytes[i + 3] == 0x06 { end = i; break }
            i -= 1
        }
        guard end >= 0 else { throw Failure.notAZip }
        let count = Int(u16(bytes, end + 10))
        var at = Int(u32(bytes, end + 16))
        for _ in 0..<count {
            guard at + 46 <= bytes.count, u32(bytes, at) == 0x0201_4b50 else { throw Failure.notAZip }
            let nameLength = Int(u16(bytes, at + 28))
            let extraLength = Int(u16(bytes, at + 30))
            let commentLength = Int(u16(bytes, at + 32))
            guard at + 46 + nameLength <= bytes.count else { throw Failure.notAZip }
            let entry = Entry(name: String(decoding: bytes[(at + 46)..<(at + 46 + nameLength)], as: UTF8.self),
                              flags: u16(bytes, at + 8), method: u16(bytes, at + 10),
                              compressed: Int(u32(bytes, at + 20)), size: Int(u32(bytes, at + 24)), local: Int(u32(bytes, at + 42)))
            at += 46 + nameLength + extraLength + commentLength
            try visit(entry)
        }
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

    private static func u16(_ b: [UInt8], _ i: Int) -> UInt16 { UInt16(b[i]) | UInt16(b[i + 1]) << 8 }
    private static func u32(_ b: [UInt8], _ i: Int) -> UInt32 {
        UInt32(b[i]) | UInt32(b[i + 1]) << 8 | UInt32(b[i + 2]) << 16 | UInt32(b[i + 3]) << 24
    }
}
