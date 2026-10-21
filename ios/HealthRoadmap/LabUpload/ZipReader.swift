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
    static func members(of zip: Data, maxMemberBytes: Int, keep: (String) -> Bool) throws -> [Member] {
        let bytes = [UInt8](zip)
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
        var out: [Member] = []
        for _ in 0..<count {
            guard at + 46 <= bytes.count, u32(bytes, at) == 0x0201_4b50 else { throw Failure.notAZip }
            let flags = u16(bytes, at + 8)
            let method = u16(bytes, at + 10)
            let compressed = Int(u32(bytes, at + 20))
            let size = Int(u32(bytes, at + 24))
            let nameLength = Int(u16(bytes, at + 28))
            let extraLength = Int(u16(bytes, at + 30))
            let commentLength = Int(u16(bytes, at + 32))
            let local = Int(u32(bytes, at + 42))
            guard at + 46 + nameLength <= bytes.count else { throw Failure.notAZip }
            let name = String(decoding: bytes[(at + 46)..<(at + 46 + nameLength)], as: UTF8.self)
            at += 46 + nameLength + extraLength + commentLength
            if name.hasSuffix("/") || !keep(name) { continue }
            if flags & 0x1 != 0 || compressed == 0xFFFF_FFFF || size == 0xFFFF_FFFF { throw Failure.unsupported }
            guard size <= maxMemberBytes else { throw Failure.tooLarge }
            guard local + 30 <= bytes.count, u32(bytes, local) == 0x0403_4b50 else { throw Failure.notAZip }
            let start = local + 30 + Int(u16(bytes, local + 26)) + Int(u16(bytes, local + 28))
            guard start + compressed <= bytes.count else { throw Failure.notAZip }
            let raw = Data(bytes[start..<(start + compressed)])
            switch method {
            case 0: out.append(Member(name: name, data: raw))
            case 8: out.append(Member(name: name, data: try inflate(raw, size: size)))
            default: throw Failure.unsupported
            }
        }
        return out
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
