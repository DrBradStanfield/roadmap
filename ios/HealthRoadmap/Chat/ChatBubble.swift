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

/// The answer in flight, under the conversation (US-52 AC6g): its words and a spinner, a still
/// hourglass with Reduce Motion on. The web twin is widget-src/src/components/ChatPendingReply.tsx.
struct ChatPendingLine: View {
    let words: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 8) {
            if reduceMotion {
                // Not "ellipsis": the words end in one, and it reads as the More button (design review).
                Image(systemName: "hourglass")
            } else {
                ProgressView().controlSize(.small)
            }
            Text(words)
        }
        .foregroundStyle(.secondary)
        .font(.footnote)
        .accessibilityElement(children: .combine)
    }
}
