import CryptoKit
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
            /// A ZIP member or a Dropbox download: already in memory.
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
            contentHash = Self.hash(data)
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
                      let data = try? Data(contentsOf: url), Self.hash(data) == contentHash
                else { return nil }
                return data
            }
        }

        private static func hash(_ data: Data) -> String {
            "sha256-" + SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        }
    }

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
        case unreadable(String), unsupported(String), tooLarge(String), folderTooLarge, folderEmpty, folderChanged, empty
        var errorDescription: String? {
            switch self {
            case .unreadable(let name): "\(name) could not be opened."
            case .unsupported(let name): "\(name) is not a PDF, JPEG, PNG or ZIP."
            case .tooLarge(let name): "\(name) is larger than the website's limit (10 MB a file, 20 MB a ZIP of up to 200 files)."
            case .folderTooLarge: "This folder holds more than 200 MB of reports. Pick a smaller folder, or the reports one at a time."
            case .folderEmpty: "This folder holds no reports the app can read: no PDF, JPEG, PNG or ZIP."
            case .folderChanged: "The folder changed while it was read. Try again."
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

    /// False when a file of this size is over the web's limit, so a cloud file
    /// is refused before it downloads: 20 MB for a ZIP (IMPORT_LIMITS.zipMb), 10 MB otherwise.
    static func fits(name: String, bytes: Int) -> Bool {
        bytes <= ((name as NSString).pathExtension.lowercased() == "zip" ? 20 * 1024 * 1024 : maxFileBytes)
    }

    /// The documents in one picked file: one, or one per report inside a ZIP. A ZIP
    /// member is named `zip/path` here; `HealthEngine.named` gives it the web's name.
    static func documents(from data: Data, name: String) throws -> [Document] {
        let ext = (name as NSString).pathExtension.lowercased()
        if ext == "zip" {
            // The web's ZIP limits: 20 MB as downloaded, 200 files (the folder's file cap).
            guard fits(name: name, bytes: data.count) else { throw Failure.tooLarge(name) }
            let members = try ZipReader.members(of: data, maxMemberBytes: maxFileBytes, maxMembers: maxFolderFiles, maxTotalBytes: maxFolderBytes) { member in
                !member.contains("__MACOSX") && isReport(member)
            }
            let documents = try members.map { member in
                var read = try document(from: member.data, name: "\(name)/\(member.name)")
                read.zipMember = ZipMember(zip: name, path: member.name)
                return read
            }
            guard !documents.isEmpty else { throw Failure.empty }
            return documents
        }
        return [try document(from: data, name: name)]
    }

    /// `documents(from:name:)` on the shared pool, never the caller's actor: a folder's PDFs
    /// are rendered and its ZIPs opened without holding the engine's queue (merge review R2).
    @concurrent
    static func decoded(_ data: Data, name: String) async throws -> [Document] {
        decodingWatch?()
        return try documents(from: data, name: name)
    }

    /// A file or folder picked in Files, read the same way: off the main thread too (AC21).
    @concurrent
    static func decoded(picked url: URL) async throws -> [Document] {
        decodingWatch?()
        return try url.hasDirectoryPath ? documents(inFolder: url) : documents(picked: url)
    }

    /// Called where a report is decoded, so a test can see which thread does it (US-25
    /// AC21, Codex re-check R1). Nil in the app; set only by a test, before it reads.
    nonisolated(unsafe) static var decodingWatch: (@Sendable () -> Void)?

    /// The reports in one file picked in Files: a ZIP's members keep their bytes; a single
    /// file's original is the file, opened again when it is saved.
    static func documents(picked url: URL) throws -> [Document] {
        try documents(from: Data(contentsOf: url), name: url.lastPathComponent).map { read in
            guard read.zipMember == nil, let original = read.original else { return read }
            var kept = read
            kept.original = original.file(url, scope: url)
            return kept
        }
    }

    /// The reports in a picked folder and the folders inside it (US-52 AC13c): every PDF,
    /// JPEG and PNG, as a ZIP's members are read, in name order, at most the ZIP's 200.
    static func documents(inFolder folder: URL) throws -> [Document] {
        let walk = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey], options: [.skipsHiddenFiles, .skipsPackageDescendants])
        let files = (walk?.allObjects as? [URL] ?? [])
            .filter { (try? $0.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true && isReport($0.path) }
            .sorted { $0.path.localizedStandardCompare($1.path) == .orderedAscending }
        guard !files.isEmpty else { throw Failure.empty }
        let base = folder.lastPathComponent
        return try files.prefix(maxFolderFiles).map { file in
            let inside = file.path.dropFirst(folder.path.count).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            var read = try document(from: Data(contentsOf: file), name: "\(base)/\(inside)")
            read.original = read.original?.file(file, scope: folder)
            return read
        }
    }

    /// A report file by its name: a PDF or picture, not hidden.
    private static func isReport(_ path: String) -> Bool {
        !(path as NSString).lastPathComponent.hasPrefix(".") && ["pdf", "jpg", "jpeg", "png"].contains((path as NSString).pathExtension.lowercased())
    }

    /// The web's file cap for a ZIP or folder.
    static let maxFolderFiles = 200
    /// The most a ZIP's members, or a Dropbox folder's files, may hold in all.
    static let maxFolderBytes = 200 * 1024 * 1024

    /// Pictures of one paper report, from the document camera: a JPEG page each, as the
    /// web sends a picked image (US-52 AC10). Its 20-page limit holds. A picture is resized,
    /// so a camera's file size is no limit. On the shared pool, never the main thread (AC21).
    @concurrent
    static func pictures(_ images: [UIImage], name: String) async throws -> Document {
        decodingWatch?()
        let pages = images.prefix(maxPages).compactMap(jpegPage)
        guard !pages.isEmpty else { throw Failure.unreadable(name) }
        return Document(name: name, pages: pages, truncated: images.count > maxPages)
    }

    /// A photo from the library, as its file's bytes: decoded and resized off the main thread too.
    @concurrent
    static func photo(_ data: Data) async throws -> Document {
        guard let image = UIImage(data: data) else { throw Failure.unreadable("The photo") }
        return try await pictures([image], name: "Photo")
    }

    private static func document(from data: Data, name: String) throws -> Document {
        guard fits(name: name, bytes: data.count) else { throw Failure.tooLarge(name) }
        let ext = (name as NSString).pathExtension.lowercased()
        var read: Document
        switch ext {
        case "pdf": read = try pdf(data, name: name)
        case "jpg", "jpeg", "png", "heic":
            guard let image = UIImage(data: data), let page = jpegPage(image) else { throw Failure.unreadable(name) }
            read = Document(name: name, pages: [page], truncated: false)
        default: throw Failure.unsupported(name)
        }
        read.original = Original(data, mimeType: mimeTypes[ext] ?? "")
        return read
    }

    /// The type a browser gives a picked file of each kind, kept with the original.
    private static let mimeTypes = ["pdf": "application/pdf", "jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "heic": "image/heic"]

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
        let longest = max(image.size.width, image.size.height)
        let scale = longest > 2000 ? 2000 / longest : 1
        let size = CGSize(width: image.size.width * scale, height: image.size.height * scale)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: size)) }
        guard let jpeg = resized.jpegData(compressionQuality: 0.8) else { return nil }
        return Page(type: "image", content: jpeg.base64EncodedString(), mimeType: "image/jpeg")
    }
}
