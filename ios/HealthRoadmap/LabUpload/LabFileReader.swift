import Foundation
import PDFKit
import UIKit

/// Turns a picked file into the pages the server reads (US-52 AC7), the way the
/// web does (widget-src/src/lib/pdf-extract.ts, image-resize.ts, zip-extract.ts):
/// a PDF page with text goes as text, a scanned page as a JPEG; a picture as a
/// JPEG; a ZIP's PDFs and pictures one file at a time. The web's limits hold
/// (packages/health-core/src/import-hints.ts: 20 pages, 100,000 characters a page).
enum LabFileReader {
    /// One page as the server's `labImportPageSchema` takes it.
    struct Page: Encodable, Equatable, Sendable {
        let type: String
        let content: String
        let mimeType: String?
    }

    /// The file as it was picked, kept in the person's cloud when one is connected
    /// (US-52 AC13d): the bytes the web archives, never the pages sent to the server.
    struct Original: Sendable {
        enum Source: Sendable {
            /// A ZIP member: already in memory.
            case bytes(Data)
            /// A file picked in Files, opened again under `scope`'s access when it is
            /// saved: bytes mapped from it would outlive the picker's access.
            case file(URL, scope: URL)
        }
        let source: Source
        let mimeType: String
        /// The fingerprint of the bytes the review read: their size, and their
        /// 'sha256-<hex>', the web's sha256Blob format, which is the row's `contentHash`.
        let size: Int
        let contentHash: String

        init(_ data: Data, mimeType: String) {
            source = .bytes(data)
            self.mimeType = mimeType
            size = data.count
            contentHash = LabFileReader.contentHash(data)
        }

        private init(source: Source, of read: Original) {
            self.source = source
            mimeType = read.mimeType
            size = read.size
            contentHash = read.contentHash
        }

        /// The same original, kept as the picked file rather than its bytes.
        func file(_ url: URL, scope: URL) -> Original { Original(source: .file(url, scope: scope), of: self) }

        /// The bytes the review read, or nil when the file has changed (its size, then
        /// its hash), gone, or cannot be read: the row is then saved without it.
        func verifiedData() -> Data? {
            switch source {
            case .bytes(let data): return data
            case .file(let url, let scope):
                let scoped = scope.startAccessingSecurityScopedResource()
                defer { if scoped { scope.stopAccessingSecurityScopedResource() } }
                guard (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) == size,
                      let data = try? LabFileReader.coordinatedData(url), LabFileReader.contentHash(data) == contentHash
                else { return nil }
                return data
            }
        }
    }

    /// Bytes' 'sha256-<hex>', lowercase: the web's sha256Blob (archive-payloads.ts), a row's `contentHash`.
    static func contentHash(_ data: Data) -> String { "sha256-" + ManifestCheck.sha256(data) }

    /// A ZIP member's ZIP and path, which the engine names by the web's rule (`HealthEngine.named`).
    struct ZipMember: Sendable {
        let zip: String
        let path: String
    }

    /// One file, ready to send.
    struct Document: Sendable {
        var name: String
        let pages: [Page]
        /// More pages than the website reads, or a page cut short: the review says so.
        let truncated: Bool
        /// Nil for a photo or a scan, which were never a file.
        var original: Original? = nil
        var zipMember: ZipMember? = nil
    }

    enum Failure: LocalizedError {
        case unreadable(String), unsupported(String), tooLarge(String), folderTooLarge, folderEmpty, folderTooBig, empty
        var errorDescription: String? {
            switch self {
            case .unreadable(let name): "\(name) could not be opened."
            case .unsupported(let name): "\(name) is not a PDF, JPEG, PNG or ZIP."
            case .tooLarge(let name): "\(name) is larger than the website's limit (10 MB a file, 20 MB a ZIP of up to 200 files)."
            case .folderTooLarge: "This folder holds more than 200 MB of reports. Pick a smaller folder, or the reports one at a time."
            case .folderEmpty: "This folder holds no reports the app can read: no PDF, JPEG or PNG."
            case .folderTooBig: "This folder holds more than 5,000 files. Pick a smaller folder."
            case .empty: "There was nothing in this file the app can read."
            }
        }
    }

    /// The web's limits (IMPORT_LIMITS): pages per PDF, characters per text page, MB per file.
    static let maxPages = 20
    static let maxTextChars = 100_000
    static let maxFileBytes = 10 * 1024 * 1024
    /// A page with fewer characters than this is a scan (pdf-extract.ts TEXT_THRESHOLD).
    static let textThreshold = 50

    /// The report files in a folder and the folders inside it, with their listed sizes (nil
    /// when not given), walked under a file coordinator so a File Provider lists the folder
    /// onto the phone first (re-check N1). The walk stops at `maxFolderEntries`.
    static func listed(_ folder: URL) throws -> [(url: URL, size: Int?)] {
        let keys: [URLResourceKey] = [.isRegularFileKey, .fileSizeKey]
        var refused: NSError?
        var walked: Result<[(url: URL, size: Int?)], Error> = .failure(Failure.unreadable(folder.lastPathComponent))
        NSFileCoordinator().coordinate(readingItemAt: folder, options: [], error: &refused) { folder in
            walked = Result {
                let walk = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: keys, options: [.skipsHiddenFiles, .skipsPackageDescendants])
                var found: [(url: URL, size: Int?)] = []
                var entries = 0
                while let next = walk?.nextObject() {
                    entries += 1
                    guard entries <= maxFolderEntries else { throw Failure.folderTooBig }
                    guard let file = next as? URL, isReport(file.path),
                          let values = try? file.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
                    found.append((file, values.fileSize))
                }
                return found
            }
        }
        if refused != nil { throw Failure.unreadable(folder.lastPathComponent) }
        return try walked.get()
    }

    /// A file's listed size, before any read; 0 when the system does not say.
    static func size(of url: URL) -> Int {
        (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
    }

    /// A file's bytes, read through a file coordinator so a File Provider (Dropbox, Google
    /// Drive) or iCloud placeholder downloads first (adversary R4), read whole inside it.
    static func coordinatedData(_ url: URL) throws -> Data {
        var refused: NSError?
        var read: Result<Data, Error> = .failure(Failure.unreadable(url.lastPathComponent))
        NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &refused) { url in
            read = Result { try Data(contentsOf: url) }
        }
        guard refused == nil, let data = try? read.get() else { throw Failure.unreadable(url.lastPathComponent) }
        return data
    }

    /// A report file by its name: a PDF or picture, not hidden.
    static func isReport(_ path: String) -> Bool {
        lastComponent(path).first != "." && ["pdf", "jpg", "jpeg", "png"].contains(pathExtension(path))
    }

    /// The web's file cap for a ZIP or folder.
    static let maxFolderFiles = 200
    /// The most entries a picked folder's walk looks at, files and folders alike.
    static let maxFolderEntries = 5_000
    /// The most a ZIP's members, or a folder's reports, may hold in all.
    static let maxFolderBytes = 200 * 1024 * 1024

    /// One file's pages, as picked or as a ZIP member (`Held.convert`).
    static func document(from data: Data, name: String, rules: Rules) throws -> Document {
        switch rules.file(name, data.count) {
        case .tooLarge: throw Failure.tooLarge(name)
        case .keep: break
        default: throw Failure.unsupported(name)
        }
        let ext = pathExtension(name)
        var read: Document
        switch ext {
        case "pdf": read = try pdf(data, name: name)
        case "jpg", "jpeg", "png", "heic":
            guard let image = UIImage(data: data) else { throw Failure.unreadable(name) }
            // A JPEG already within the page size (a photo the app resized) goes as it is: no second encode.
            let fits = data.starts(with: [0xFF, 0xD8, 0xFF]) && max(image.size.width, image.size.height) * image.scale <= 2000
            guard let page = fits ? Page(type: "image", content: data.base64EncodedString(), mimeType: "image/jpeg") : jpegPage(image)
            else { throw Failure.unreadable(name) }
            read = Document(name: name, pages: [page], truncated: false)
        default: throw Failure.unsupported(name)
        }
        read.original = Original(data, mimeType: mimeTypes[ext] ?? "")
        return read
    }

    /// The type a browser gives a picked file of each kind, kept with the original.
    static let mimeTypes = ["pdf": "application/pdf", "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "heic": "image/heic"]

    private static func pdf(_ data: Data, name: String) throws -> Document {
        guard let pdf = PDFDocument(data: data), pdf.pageCount > 0 else { throw Failure.unreadable(name) }
        let count = min(pdf.pageCount, maxPages)
        var pages: [Page] = []
        var cut = false
        for index in 0..<count {
            guard let page = pdf.page(at: index) else { continue }
            let text = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            if text.count > textThreshold {
                let label = "[Page \(index + 1)/\(pdf.pageCount)]\n"
                // The server counts UTF-16 units, as JavaScript does.
                let limit = maxTextChars - label.utf16.count
                var kept = String(text.prefix(limit))
                while kept.utf16.count > limit { kept.removeLast() }
                cut = cut || kept.count < text.count
                pages.append(Page(type: "text", content: label + kept, mimeType: nil))
            } else if let image = render(page), let jpeg = jpegPage(image) {
                pages.append(jpeg)
            }
        }
        guard !pages.isEmpty else { throw Failure.empty }
        return Document(name: name, pages: pages, truncated: cut || pdf.pageCount > count)
    }

    /// A scanned page at 1.5x, as the web renders it.
    private static func render(_ page: PDFPage) -> UIImage? {
        let bounds = page.bounds(for: .mediaBox)
        guard bounds.width > 0, bounds.height > 0 else { return nil }
        return page.thumbnail(of: CGSize(width: bounds.width * 1.5, height: bounds.height * 1.5), for: .mediaBox)
    }

    /// A JPEG at quality 0.8, the long side at most 2,000 points, as base64.
    static func jpegPage(_ image: UIImage) -> Page? {
        jpeg(image).map { Page(type: "image", content: $0.base64EncodedString(), mimeType: "image/jpeg") }
    }

    /// The picture as a JPEG at quality 0.8, the long side at most 2,000 points.
    static func jpeg(_ image: UIImage) -> Data? {
        let longest = max(image.size.width, image.size.height)
        let scale = longest > 2000 ? 2000 / longest : 1
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        return UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
            .jpegData(compressionQuality: 0.8)
    }
}
