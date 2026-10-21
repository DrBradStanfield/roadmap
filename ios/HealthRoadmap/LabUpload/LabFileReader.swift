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

    /// One file, ready to send.
    struct Document: Sendable {
        let name: String
        let pages: [Page]
        /// More pages than the website reads, or a page cut short: the review says so.
        let truncated: Bool
    }

    enum Failure: LocalizedError {
        case unreadable(String), unsupported(String), tooLarge(String), empty
        var errorDescription: String? {
            switch self {
            case .unreadable(let name): "\(name) could not be opened."
            case .unsupported(let name): "\(name) is not a PDF, JPEG, PNG or ZIP."
            case .tooLarge(let name): "\(name) is larger than the website's limit (10 MB a file, 20 MB a ZIP of up to 200 files)."
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

    /// The documents in one picked file: one, or one per report inside a ZIP.
    static func documents(from data: Data, name: String) throws -> [Document] {
        let ext = (name as NSString).pathExtension.lowercased()
        if ext == "zip" {
            // The web's ZIP limits: 20 MB as downloaded, 200 files (the folder's file cap).
            guard fits(name: name, bytes: data.count) else { throw Failure.tooLarge(name) }
            let members = try ZipReader.members(of: data, maxMemberBytes: maxFileBytes, maxMembers: 200, maxTotalBytes: 200 * 1024 * 1024) { member in
                let leaf = (member as NSString).lastPathComponent
                return !leaf.hasPrefix(".") && !member.contains("__MACOSX") && ["pdf", "jpg", "jpeg", "png"].contains((member as NSString).pathExtension.lowercased())
            }
            let documents = try members.map { try document(from: $0.data, name: "\(name)/\($0.name)") }
            guard !documents.isEmpty else { throw Failure.empty }
            return documents
        }
        return [try document(from: data, name: name)]
    }

    /// Pictures of one paper report, from the photo library or the document
    /// camera: a JPEG page each, as the web sends a picked image (US-52 AC10).
    /// Its 20-page limit holds. A photo is resized, so a camera's file size is no limit.
    static func pictures(_ images: [UIImage], name: String) throws -> Document {
        let pages = images.prefix(maxPages).compactMap(jpegPage)
        guard !pages.isEmpty else { throw Failure.unreadable(name) }
        return Document(name: name, pages: pages, truncated: images.count > maxPages)
    }

    private static func document(from data: Data, name: String) throws -> Document {
        guard fits(name: name, bytes: data.count) else { throw Failure.tooLarge(name) }
        switch (name as NSString).pathExtension.lowercased() {
        case "pdf": return try pdf(data, name: name)
        case "jpg", "jpeg", "png", "heic":
            guard let image = UIImage(data: data), let page = jpegPage(image) else { throw Failure.unreadable(name) }
            return Document(name: name, pages: [page], truncated: false)
        default: throw Failure.unsupported(name)
        }
    }

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
