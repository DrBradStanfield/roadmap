import QuickLook
import SwiftUI
import UniformTypeIdentifiers

/// A letter's or scan result's row at the foot of My health (US-73 AC12): its title, then its day,
/// and under Documents its kind, as the web's row shows its badge (HealthRecordsSection).
struct DocumentRow: View {
    let document: MyData.Document
    let showsType: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(document.title)
            Text(showsType ? "\(document.typeLabel) · \(document.dayText)" : document.dayText)
                .font(.subheadline)
                .foregroundStyle(.secondary)
        }
        .padding(.vertical, 2)
    }
}

/// One document's page (US-73 AC12; the web's DocumentLightbox, US-14): its kind, day and file
/// name, the text read from it, and its original from the cloud when the cloud holds one. The
/// text is the extraction's markdown, drawn as SwiftUI text: no web view, nothing runs.
struct DocumentPage: View {
    let store: RecordStore
    let document: MyData.Document
    @State private var opening = false
    /// The original, written to a temporary file for Quick Look; removed when the preview closes.
    @State private var preview: URL?
    @State private var problem: String?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 6) {
                    Text(document.title).font(.title2.bold())
                    Text(document.dayText).foregroundStyle(.secondary)
                    if let file = document.sourceFileName {
                        Text(file).font(.footnote).foregroundStyle(.secondary)
                    }
                    // Up here, not under the letter: at large text the letter runs several screens (design review).
                    if document.original != nil {
                        Button(action: openOriginal) {
                            HStack(spacing: 8) {
                                Label("View original file", systemImage: "doc.viewfinder")
                                if opening { ProgressView() }
                            }
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(opening)
                        .padding(.top, 6)
                    }
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets(top: 8, leading: 4, bottom: 0, trailing: 4))
            }
            if !document.content.isEmpty {
                Section { DocumentText(markdown: document.content, title: document.title).padding(.vertical, 6) }
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, 0, for: .scrollContent)
        .navigationTitle(document.typeLabel)
        .navigationBarTitleDisplayMode(.inline)
        // An alert, not a footer: a footer under the letter sat behind the tab bar (design review).
        .messageAlert("Original not opened", $problem)
        .quickLookPreview($preview)
        .onChange(of: preview) { old, _ in Self.remove(old) }
        .onDisappear { Self.remove(preview) }
    }

    private func openOriginal() {
        guard let original = document.original else { return }
        guard Self.previewable(original) else {
            problem = "This kind of file cannot be shown on the iPhone. Open it from your cloud storage."
            return
        }
        problem = nil
        opening = true
        Task {
            defer { opening = false }
            switch await store.original(of: document.id) {
            case .file(let data):
                do { preview = try Self.write(data, named: original.name) } catch { problem = Self.couldNotLoad }
            case .noCloud: problem = "The original is kept in your cloud storage. Connect it in Sync to open it here."
            case .failed: problem = Self.couldNotLoad
            }
        }
    }

    /// The web's words for an original that would not load (DocumentLightbox).
    static let couldNotLoad = "Could not load the original file from your cloud storage."

    /// A passive kind Quick Look draws without running anything: a PDF, a photo or plain text.
    /// Never an SVG or a web page, which can carry script (the web's rule, US-14 AC3).
    static func previewable(_ original: MyData.Document.Original) -> Bool {
        let named = UTType(filenameExtension: (original.name as NSString).pathExtension)
        guard let type = named ?? UTType(mimeType: original.mimeType), !type.conforms(to: .svg), !type.conforms(to: .html) else { return false }
        return type.conforms(to: .pdf) || type.conforms(to: .image) || type.conforms(to: .plainText)
    }

    /// The bytes in a folder of their own under the app's temporary directory, under the file's own
    /// name (Quick Look reads the kind from it), protected while the phone is locked.
    static func write(_ data: Data, named name: String) throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "originals/\(UUID().uuidString)", directoryHint: .isDirectory)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let file = (name as NSString).lastPathComponent
        let url = folder.appending(path: file.isEmpty ? "document" : file)
        try data.write(to: url, options: [.atomic, .completeFileProtection])
        return url
    }

    /// A health document never stays on the phone longer than its preview.
    private static func remove(_ url: URL?) {
        guard let url else { return }
        try? FileManager.default.removeItem(at: url.deletingLastPathComponent())
    }
}

/// A document's markdown as the web's renderer reads it (widget-src/src/lib/markdown.ts): headings,
/// lists, tables and paragraphs, with bold and italic inside. Links are drawn as plain text: the
/// words come from an uploaded file, so nothing in them opens anything.
struct DocumentText: View {
    let markdown: String
    /// The page's title: a first heading that only repeats it is not drawn again.
    var title: String? = nil

    enum Block: Equatable {
        case heading(level: Int, text: String)
        case bullet(String)
        case numbered(String, String)
        /// The first row is the header.
        case table([[String]])
        case paragraph(String)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(Self.blocks(markdown, title: title).enumerated()), id: \.offset) { _, block in
                switch block {
                case .heading(let level, let text):
                    Text(Self.inline(text)).font(level <= 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())
                        .accessibilityAddTraits(.isHeader)
                case .bullet(let text):
                    HStack(alignment: .firstTextBaseline, spacing: 8) { Text("•"); Text(Self.inline(text)) }
                case .numbered(let number, let text):
                    HStack(alignment: .firstTextBaseline, spacing: 8) { Text(number).monospacedDigit(); Text(Self.inline(text)) }
                case .table(let rows):
                    // Columns when they fit; else one block per row, so no value is ever cut off (design review).
                    ViewThatFits(in: .horizontal) {
                        Grid(alignment: .leading, horizontalSpacing: 16, verticalSpacing: 6) {
                            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                                GridRow {
                                    ForEach(Array(row.enumerated()), id: \.offset) { _, cell in
                                        Text(Self.inline(cell)).fontWeight(index == 0 ? .semibold : nil).fixedSize()
                                    }
                                }
                                if index == 0 { Divider() }
                            }
                        }
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(Self.stacked(rows).enumerated()), id: \.offset) { _, row in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(Self.inline(row.name)).fontWeight(.semibold)
                                    Text(Self.inline(row.rest)).foregroundStyle(.secondary)
                                }
                                // Wraps in full: ViewThatFits otherwise cut the last line to "Ran…".
                                .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                    .font(.subheadline)
                case .paragraph(let text):
                    Text(Self.inline(text))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textSelection(.enabled)
    }

    /// A table as stacked rows for a narrow screen: each body row's first cell, then its other
    /// cells, each after its header ("Result 2.4 mmol/L · Range <3.0").
    static func stacked(_ rows: [[String]]) -> [(name: String, rest: String)] {
        guard let header = rows.first else { return [] }
        return rows.dropFirst().map { row in
            let rest = row.dropFirst().enumerated().map { index, cell in
                let label = index + 1 < header.count ? header[index + 1] : ""
                return label.isEmpty ? cell : "\(label) \(cell)"
            }
            return (row.first ?? "", rest.joined(separator: " · "))
        }
    }

    /// The markdown's blocks, line by line as the web's renderer splits them; a first heading
    /// that only repeats `title` is left out.
    static func blocks(_ markdown: String, title: String?) -> [Block] {
        let all = blocks(markdown)
        if let title, case .heading(_, let text) = all.first,
           text.trimmingCharacters(in: .whitespaces).caseInsensitiveCompare(title.trimmingCharacters(in: .whitespaces)) == .orderedSame {
            return Array(all.dropFirst())
        }
        return all
    }

    static func blocks(_ markdown: String) -> [Block] {
        var blocks: [Block] = []
        var paragraph: [String] = []
        var table: [[String]] = []
        func flush() {
            if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
            if !table.isEmpty { blocks.append(.table(table)); table = [] }
        }
        for raw in markdown.components(separatedBy: .newlines) {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.count > 1, line.hasPrefix("|"), line.hasSuffix("|") {
                if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))); paragraph = [] }
                // A separator row (|---|:--:|) draws nothing.
                if line.allSatisfy({ "|-: ".contains($0) }) { continue }
                table.append(line.dropFirst().dropLast().split(separator: "|", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) })
                continue
            }
            if !table.isEmpty { blocks.append(.table(table)); table = [] }
            if line.isEmpty { flush(); continue }
            if let match = line.firstMatch(of: /^(#{1,6})\s+(.+)$/) {
                flush()
                blocks.append(.heading(level: match.1.count, text: String(match.2)))
            } else if let match = line.firstMatch(of: /^[-*+]\s+(.+)$/) {
                flush()
                blocks.append(.bullet(String(match.1)))
            } else if let match = line.firstMatch(of: /^(\d+[.)])\s+(.+)$/) {
                flush()
                blocks.append(.numbered(String(match.1), String(match.2)))
            } else {
                paragraph.append(line)
            }
        }
        flush()
        return blocks
    }

    /// Bold, italic and code inside a line; a link keeps its words and loses its target.
    static func inline(_ text: String) -> AttributedString {
        var string = (try? AttributedString(markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(text)
        for run in string.runs where run.link != nil { string[run.range].link = nil }
        return string
    }
}
