import SwiftUI

/// A message bubble. Answers render the server's Markdown (bold, lists, links).
struct ChatBubble: View {
    let line: ChatLine

    var body: some View {
        VStack(alignment: line.role == .user ? .trailing : .leading, spacing: 6) {
            Text(markdown)
                .padding(10)
                .background(line.role == .user ? Color.accentColor.opacity(0.15) : Color(.secondarySystemBackground), in: .rect(cornerRadius: 12))
                .textSelection(.enabled)
            if !line.sources.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Sources").font(.caption.bold())
                    ForEach(line.sources, id: \.self) { Text($0).font(.caption) }
                }
                .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, alignment: line.role == .user ? .trailing : .leading)
    }

    private var markdown: AttributedString {
        (try? AttributedString(markdown: line.text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(line.text)
    }
}
