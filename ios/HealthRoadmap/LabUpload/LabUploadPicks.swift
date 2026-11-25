import UIKit

/// What each source hands the shared upload (design PR 15 follow-up, US-52 AC10, AC13c): picked
/// files as bytes, never read into pages here (the engine's effects convert them, `Held`). Files:
/// one file, a ZIP, or a folder's reports; Photos: one photo; Scan: the camera's pages as one PDF.
/// Off the main thread: a folder and a scan can be large (AC21).
extension LabFileReader {
    /// A file or folder picked in Files. A file the rules call too large by its listed size is
    /// never read: it goes by its size alone, and the engine refuses it in its words. A folder with
    /// no report, over its caps or with too many entries, and a file that will not read are refused
    /// in the reader's words (`Failure`), before anything is held.
    @concurrent
    static func picked(_ url: URL, ask: AskRules) async throws -> [UploadRunner.Picked] {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        if url.hasDirectoryPath { return try await picked(folder: url, ask: ask) }
        let name = url.lastPathComponent, listed = size(of: url)
        if await ask([UploadFile(name: name, bytes: listed)], []).file(name, listed) == .tooLarge { return [unread(name, listed)] }
        return [UploadRunner.Picked(name: name, data: try coordinatedData(url))]
    }

    /// A file too large to read, by its name and listed size: nothing read or held.
    private static func unread(_ name: String, _ bytes: Int) -> UploadRunner.Picked {
        UploadRunner.Picked(name: name, data: Data(), bytes: bytes)
    }

    /// The reports in a picked folder and the folders inside it: every PDF, JPEG and PNG, in name
    /// order, at most `maxFolderFiles`, each named `<folder>/<path inside>`. Every listed size is
    /// checked before anything is read: a file the rules call too large goes by its size alone, for
    /// the engine to refuse; the rest may hold `maxBytes` in all, checked again as they are read.
    /// The folder's reads are held in memory together, so `maxBytes` is the most they take.
    static func picked(folder: URL, maxBytes: Int = maxFolderBytes, ask: AskRules) async throws -> [UploadRunner.Picked] {
        let files = try listed(folder).sorted { $0.url.path.localizedStandardCompare($1.url.path) == .orderedAscending }.prefix(maxFolderFiles)
        guard !files.isEmpty else { throw Failure.folderEmpty }
        let named = { (url: URL) in "\(folder.lastPathComponent)/\(url.path.dropFirst(folder.path.count).trimmingCharacters(in: CharacterSet(charactersIn: "/")))" }
        // A size the system does not give is unknown: the reads below are checked instead.
        let sized = files.compactMap { file in file.size.map { UploadFile(name: named(file.url), bytes: $0) } }
        let rules = await ask(sized, [])
        let tooLarge = { (file: (url: URL, size: Int?)) in file.size.map { rules.file(named(file.url), $0) == .tooLarge } ?? false }
        guard files.filter({ !tooLarge($0) }).reduce(0, { $0 + ($1.size ?? 0) }) <= maxBytes else { throw Failure.folderTooLarge }
        var picked: [UploadRunner.Picked] = []
        var bytes = 0
        for file in files {
            try Task.checkCancellation()
            if tooLarge(file), let size = file.size { picked.append(unread(named(file.url), size)); continue }
            let data = try coordinatedData(file.url)
            bytes += data.count
            guard bytes <= maxBytes else { throw Failure.folderTooLarge }
            picked.append(UploadRunner.Picked(name: named(file.url), data: data))
        }
        return picked
    }

    /// A photo from the library, as a JPEG named by the app's word for it, resized as a picked
    /// picture's page is (`jpeg`: long side 2,000, quality 0.8), so a camera's file size is no limit.
    /// `working`: told where the resize runs, a test's (US-25 AC21); nil in the app.
    @concurrent
    static func picked(photo data: Data, working: (@Sendable () -> Void)? = nil) async throws -> UploadRunner.Picked {
        working?()
        guard let image = UIImage(data: data), let resized = jpeg(image) else { throw Failure.unreadable("The photo") }
        return UploadRunner.Picked(name: "Photo.jpg", data: resized, keepsOriginal: false, redrawn: true)
    }

    /// A photo as the library hands it over (`load`). A load that fails, an iCloud Photos original
    /// not on the phone while offline say, says the app's words for a photo that will not open,
    /// never the system's.
    @concurrent
    static func picked(photoLoad load: @Sendable () async throws -> Data?) async throws -> UploadRunner.Picked {
        guard let data = try? await load() else { throw Failure.unreadable("The photo") }
        return try await picked(photo: data)
    }

    /// The document camera's pages as one PDF, a page each, named by the app's word for a scan.
    /// Each page is the JPEG a picked picture is sent as (`jpeg`: long side 2,000, quality 0.8), and
    /// those JPEGs are the pages sent (`Picked.pages`): the convert never draws them again, so what
    /// is sent is what the size check saw. Past `maxPages` the PDF ends with one blank placeholder
    /// page, so it says the rest was cut without weighing on the size. A scan the engine's rules
    /// (`ask`) call too large is built again with its pages smaller, a step at a time (`scanSteps`),
    /// and the first that fits is used; if none does, the smallest goes, and the engine refuses it
    /// in its words. `working`: told where the PDF is built, a test's (US-25 AC21); nil in the app.
    @concurrent
    static func picked(scan images: [UIImage], ask: AskRules? = nil, working: (@Sendable () -> Void)? = nil) async throws -> UploadRunner.Picked {
        working?()
        let name = "Scanned report.pdf", kept = Array(images.prefix(maxPages)), cut = images.count > maxPages
        var scan = try scanPDF(kept, cut: cut, longSide: 2000, quality: 0.8)
        if let ask {
            for (longSide, quality) in scanSteps {
                guard await ask([UploadFile(name: name, bytes: scan.pdf.count)], []).file(name, scan.pdf.count) == .tooLarge else { break }
                try Task.checkCancellation()
                scan = try scanPDF(kept, cut: cut, longSide: longSide, quality: quality)
            }
        }
        let pages = scan.jpegs.map { Page(type: "image", content: $0.base64EncodedString(), mimeType: "image/jpeg") }
        return UploadRunner.Picked(name: name, data: scan.pdf, keepsOriginal: false, pages: Document(name: name, pages: pages, truncated: cut))
    }

    /// The smaller pages a long scan steps down to, after today's (long side 2,000, quality 0.8).
    static let scanSteps: [(longSide: CGFloat, quality: CGFloat)] = [(2000, 0.65), (2000, 0.5), (1600, 0.5)]

    /// The pages as one PDF, a JPEG page each, the long side at most `longSide` points, with a blank
    /// 1-point page after them when the scan was `cut`; and the JPEGs themselves.
    private static func scanPDF(_ images: [UIImage], cut: Bool, longSide: CGFloat, quality: CGFloat) throws -> (pdf: Data, jpegs: [Data]) {
        let jpegs = images.compactMap { jpeg($0, longSide: longSide, quality: quality) }
        let pages = jpegs.compactMap(UIImage.init(data:))
        guard let first = pages.first else { throw Failure.unreadable("Scanned report") }
        let pdf = UIGraphicsPDFRenderer(bounds: CGRect(origin: .zero, size: first.size)).pdfData { context in
            for page in pages {
                context.beginPage(withBounds: CGRect(origin: .zero, size: page.size), pageInfo: [:])
                page.draw(in: CGRect(origin: .zero, size: page.size))
            }
            if cut { context.beginPage(withBounds: CGRect(x: 0, y: 0, width: 1, height: 1), pageInfo: [:]) }
        }
        return (pdf, jpegs)
    }
}
