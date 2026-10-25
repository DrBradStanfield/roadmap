import SwiftUI

/// Chat with Dr Brad's assistant (US-52 AC5/AC6), native SwiftUI. The consent screen
/// comes first; then each question streams its answer, with the status lines and the
/// articles it drew on. Conversations are saved on the phone by health-core's rule,
/// through the app's one `ChatHistoryStore` (the eraser's too, AppParts).
/// The web twin is widget-src/src/components/ChatSection.tsx.
struct ChatView: View {
    let engine: HealthEngine
    let store: RecordStore
    let history: ChatHistoryStore

    @State private var consented = AIConsent.chat.given
    @State private var conversationId = UUID().uuidString.lowercased()
    @State private var lines: [ChatLine] = []
    @State private var draft = ""
    @State private var status: String?
    @State private var sending = false
    @State private var error: String?
    @State private var showingHistory = false

    var body: some View {
        NavigationStack {
            Group {
                if consented {
                    conversation
                } else {
                    AIConsentView(consent: .chat) { consented = true }
                }
            }
            .navigationTitle("Chat")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { if consented { toolbar } }
            .sheet(isPresented: $showingHistory) {
                ChatHistoryList(history: history, open: open)
            }
        }
        // "Delete all my data" erased the history: the conversation on screen goes too,
        // and the next question starts a new one (US-25 AC13). The shared list was read
        // again by the eraser (DataEraser), and History reads it again as it opens.
        .onChange(of: store.erasures) {
            lines = []
            error = nil
            conversationId = UUID().uuidString.lowercased()
        }
    }

    // MARK: The conversation

    /// Questions to start from, for someone who does not know what to ask. A tap
    /// sends one as typed; nothing is sent until then.
    private static let starterQuestions = [
        "What should I talk to my doctor about first?",
        "Explain my cholesterol results",
        "Which screening tests are due for me?",
        "What does my blood pressure mean?",
    ]

    private var starters: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Self.starterQuestions, id: \.self) { question in
                Button {
                    draft = question
                    Task { await send() }
                } label: {
                    Label(question, systemImage: "sparkle")
                        .font(.subheadline)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(.tint.opacity(0.1), in: .capsule)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.tint)
                .disabled(sending)
            }
        }
        .padding(.top, 8)
    }

    private var conversation: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        if lines.isEmpty {
                            Text("Ask about your plan, a test result, or a guideline. The answer uses your saved values.")
                                .foregroundStyle(.secondary)
                                .padding(.top, 24)
                            starters
                        }
                        ForEach(lines) { ChatBubble(line: $0) }
                        if let status { Label(status, systemImage: "ellipsis").foregroundStyle(.secondary).font(.footnote) }
                        if let error { Text(error).foregroundStyle(.red).font(.footnote) }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding()
                }
                .onChange(of: lines) { proxy.scrollTo("end", anchor: .bottom) }
            }
            Divider()
            HStack(alignment: .bottom) {
                TextField("Ask a question", text: $draft, axis: .vertical)
                    .analyticsMasked()
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task { await send() }
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.title)
                }
                .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send")
            }
            .padding()
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        ToolbarItem(placement: .topBarLeading) {
            Button("History") { Task { await history.refresh() }; showingHistory = true }
                .disabled(sending) // a turn in flight keeps its own conversation
        }
        ToolbarItem(placement: .topBarTrailing) {
            Menu {
                Button("New chat", systemImage: "square.and.pencil") { startNew() }
                Button("Stop sharing", systemImage: "hand.raised", role: .destructive) {
                    AIConsent.chat.withdraw()
                    consented = false
                }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .disabled(sending)
        }
    }

    // MARK: Actions

    private func startNew() {
        history.leave()
        conversationId = UUID().uuidString.lowercased()
        lines = []
        error = nil
    }

    /// Shows a saved conversation once the engine has read it. An erase, a question sent,
    /// New chat or another conversation opened meanwhile wins: the screen keeps what it shows.
    private func open(_ id: String) {
        showingHistory = false
        let erasures = store.erasures
        let loading = history.open(id)
        Task {
            guard let messages = await loading.value, store.erasures == erasures, !sending else { return }
            conversationId = id
            lines = messages.map { ChatLine(role: $0.role == "user" ? .user : .assistant, text: $0.content) }
            error = nil
        }
    }

    private func send() async {
        let question = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !question.isEmpty, AIConsent.chat.given else { return }
        let earlier = lines.filter { !$0.failed }.map { ChatClient.Turn(role: $0.role == .user ? "user" : "assistant", content: $0.text) }
        let isNew = lines.isEmpty
        let conversation = conversationId
        // An erase while the answer streams empties `lines` and the history: from then on
        // this turn is dropped, never indexed into the new lines or saved (review R1).
        let erasures = store.erasures
        let askedAt = ChatHistoryStore.erasures
        draft = ""
        error = nil
        sending = true
        defer { sending = false; status = nil }
        lines.append(ChatLine(role: .user, text: question))
        let answerIndex = lines.count
        lines.append(ChatLine(role: .assistant, text: ""))

        do {
            let context = try await engine.chatContext(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId)
            let body = try ChatClient.body(message: question, conversationId: conversation, history: earlier, contextJSON: context)
            var finished = false
            for try await event in ChatClient().ask(body: body) {
                guard store.erasures == erasures else { return }
                switch event {
                case .status(let text): status = text
                case .text(let text): lines[answerIndex].text += text
                case .sources(let titles): lines[answerIndex].sources = titles
                case .done(let content, let isFallback, let failure):
                    if let failure { throw AppAttestClient.Failure.server(status: 500, message: failure) }
                    // The final reply replaces what streamed (US-15 AC16).
                    lines[answerIndex].text = content ?? lines[answerIndex].text
                    finished = true
                    await history.record(ChatExchange(conversationId: conversation, isNew: isNew, userText: question, assistantText: lines[answerIndex].text, isFallback: isFallback), askedAt: askedAt)
                case .other: break
                }
            }
            // A stream that ended with no `done` line was cut off: never history.
            guard store.erasures == erasures else { return }
            if !finished { throw AppAttestClient.Failure.server(status: 0, message: "The answer was cut off. Please ask again.") }
        } catch {
            guard store.erasures == erasures else { return }
            lines[answerIndex].failed = true
            if lines[answerIndex].text.isEmpty { lines[answerIndex].text = "No answer." }
            self.error = error.localizedDescription
        }
    }
}

/// One message on screen.
struct ChatLine: Identifiable, Equatable {
    enum Role { case user, assistant }
    let id = UUID()
    let role: Role
    var text: String
    var sources: [String] = []
    /// The answer did not finish: shown, but never sent back as history.
    var failed = false
}
