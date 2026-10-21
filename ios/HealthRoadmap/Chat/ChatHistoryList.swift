import SwiftUI

/// The saved conversations, newest first; swipe to delete (a tombstone, as on the web).
struct ChatHistoryList: View {
    let history: ChatHistoryStore
    let open: (String) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if history.conversations.isEmpty {
                    Text("No saved conversations yet.").foregroundStyle(.secondary)
                }
                ForEach(history.conversations) { conversation in
                    Button(conversation.title.isEmpty ? "Chat" : conversation.title) { open(conversation.id) }
                }
                .onDelete { offsets in
                    for index in offsets { history.delete(history.conversations[index].id) }
                }
            }
            .navigationTitle("History")
            .toolbar { Button("Done") { dismiss() } }
        }
    }
}
