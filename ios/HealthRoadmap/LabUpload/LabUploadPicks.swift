import UIKit

/// What each source hands the shared upload (design PR 15 follow-up, US-52 AC10, AC13c): picked
/// files as bytes, never read into pages here (the engine's effects convert them, `Held`). Files:
/// one file, a ZIP, or a folder's reports; Photos: one photo; Scan: the camera's pages as one PDF.
/// Off the main thread: a folder and a scan can be large (AC21).
extension LabFileReader {
    /// A file or folder picked in Files. A file over the rules' size by its listed size, a folder
    /// with no report, over its caps or with too many entries, and a file that will not read are
    /// refused in the reader's words (`Failure`), before anything is held.
    @concurrent
    static func picked(_ url: URL, ask: AskRules) async throws -> [UploadRunner.Picked] {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if url.hasDirectoryPath { return try await picked(folder: url, ask: ask) }
        let name = url.lastPathComponent, listed = size(of: url)
        guard await ask([UploadFile(name: name, bytes: listed)], []).file(name, listed) != .tooLarge else { throw Failure.tooLarge(name) }
        return [UploadRunner.Picked(id: UUID().uuidString, name: name, data: try coordinatedData(url))]
    }

    /// The reports in a picked folder and the folders inside it: every PDF, JPEG and PNG, in name
    /// order, at most `maxFolderFiles`, each named `<folder>/<path inside>`. Every listed size is
    /// checked before anything is read; the reads are checked against `maxBytes` as they go.
    static func picked(folder: URL, maxBytes: Int = maxFolderBytes, ask: AskRules) async throws -> [UploadRunner.Picked] {
        let files = try listed(folder).sorted { $0.url.path.localizedStandardCompare($1.url.path) == .orderedAscending }.prefix(maxFolderFiles)
        guard !files.isEmpty else { throw Failure.folderEmpty }
        // A size the system does not give is unknown: the reads below are checked instead.
        let sized = files.compactMap { file in file.size.map { UploadFile(name: file.url.lastPathComponent, bytes: $0) } }
        let rules = await ask(sized, [])
        if let big = files.first(where: { file in file.size.map { rules.file(file.url.lastPathComponent, $0) == .tooLarge } ?? false }) {
            throw Failure.tooLarge(big.url.lastPathComponent)
        }
        guard files.reduce(0, { $0 + ($1.size ?? 0) }) <= maxBytes else { throw Failure.folderTooLarge }
        var picked: [UploadRunner.Picked] = []
        var bytes = 0
        for file in files {
            try Task.checkCancellation()
            let data = try coordinatedData(file.url)
            bytes += data.count
            guard bytes <= maxBytes else { throw Failure.folderTooLarge }
            let inside = file.url.path.dropFirst(folder.path.count).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
            picked.append(UploadRunner.Picked(id: UUID().uuidString, name: "\(folder.lastPathComponent)/\(inside)", data: data))
        }
        return picked
    }

    /// A photo from the library, as a JPEG named by the app's word for it.
    @concurrent
    static func picked(photo data: Data) async throws -> UploadRunner.Picked {
        guard let jpeg = UIImage(data: data)?.jpegData(compressionQuality: 0.9) else { throw Failure.unreadable("The photo") }
        return UploadRunner.Picked(id: UUID().uuidString, name: "Photo.jpg", data: jpeg)
    }

    /// The document camera's pages as one PDF, a page each, named by the app's word for a scan.
    /// Each page is the JPEG a picked picture is sent as (`jpegPage`: long side 2,000, quality 0.8),
    /// so a camera's file size is no limit; at most `maxPages`, as before.
    @concurrent
    static func picked(scan images: [UIImage]) async throws -> UploadRunner.Picked {
        let pages = images.prefix(maxPages).compactMap { jpegPage($0).flatMap { Data(base64Encoded: $0.content) }.flatMap(UIImage.init(data:)) }
        guard let first = pages.first else { throw Failure.unreadable("Scanned report") }
        let data = UIGraphicsPDFRenderer(bounds: CGRect(origin: .zero, size: first.size)).pdfData { context in
            for page in pages {
                context.beginPage(withBounds: CGRect(origin: .zero, size: page.size), pageInfo: [:])
                page.draw(in: CGRect(origin: .zero, size: page.size))
            }
        }
        return UploadRunner.Picked(id: UUID().uuidString, name: "Scanned report.pdf", data: data)
    }
}
