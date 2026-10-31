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
    @State private var transcript = ChatTranscript()
    @State private var draft = ""
    @State private var status: String?
    /// The turn in flight, for Stop (US-52 AC6d).
    @State private var turn: Task<Void, Never>?
    @State private var showingHistory = false
    /// The question box. Sending, dragging or tapping the conversation lowers the keyboard,
    /// so the tab bar under it is back (US-52 AC6c).
    @FocusState private var asking: Bool

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
            transcript = ChatTranscript()
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
                    ask(question)
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
                        if transcript.lines.isEmpty {
                            Text("Ask about your plan, a test result, or a guideline. The answer uses your saved values.")
                                .foregroundStyle(.secondary)
                                .padding(.top, 24)
                            starters
                        }
                        ForEach(transcript.shown) { ChatBubble(line: $0) }
                        if let status { Label(status, systemImage: "ellipsis").foregroundStyle(.secondary).font(.footnote) }
                        if let error = transcript.error {
                            Text(error).foregroundStyle(.red).font(.footnote)
                            #if DEBUG
                                // ChatDemoFilmUITests: a failed or cut-off answer is never filmed as finished.
                                .accessibilityIdentifier("chat.error")
                            #endif
                            // The failed question, sent again with one tap (US-52 AC6d).
                            if let question = transcript.retryQuestion {
                                Button("Try again", systemImage: "arrow.clockwise") { ask(question) }
                                    .font(.footnote)
                                    .buttonStyle(.bordered)
                            }
                        }
                        Color.clear.frame(height: 1).id("end")
                    }
                    .padding()
                }
                .scrollDismissesKeyboard(.interactively)
                // Alongside, never instead of, the starters' and bubbles' own taps.
                .simultaneousGesture(TapGesture().onEnded { asking = false })
                .onChange(of: transcript.lines) { proxy.scrollTo("end", anchor: .bottom) }
            }
            Divider()
            HStack(alignment: .bottom) {
                TextField("Ask a question", text: $draft, axis: .vertical)
                    .analyticsMasked()
                    .lineLimit(1...5)
                    .textFieldStyle(.roundedBorder)
                    .focused($asking)
                if sending && !transcript.finished {
                    // Stop cancels the turn at once; the question comes back to the box (US-52 AC6d).
                    Button(action: stop) {
                        Image(systemName: "stop.circle.fill").font(.title)
                    }
                    .accessibilityLabel("Stop")
                } else {
                    Button {
                        let question = draft
                        draft = ""
                        ask(question)
                    } label: {
                        Image(systemName: "arrow.up.circle.fill").font(.title)
                    }
                    .disabled(sending || draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    .accessibilityLabel("Send")
                }
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
        transcript = ChatTranscript()
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
            transcript = ChatTranscript(lines: messages.map { ChatLine(role: $0.role == "user" ? .user : .assistant, text: $0.content) })
        }
    }

    private var sending: Bool { turn != nil }

    private func ask(_ question: String) {
        let question = question.trimmingCharacters(in: .whitespacesAndNewlines)
        // One turn at a time: a double tap sends once, and Stop always cancels the turn on screen.
        guard turn == nil, !question.isEmpty, AIConsent.chat.given else { return }
        turn = Task { await send(question) }
    }

    /// Cancels the turn in flight. The screen moves on now, not when the request unwinds:
    /// the cancelled turn changes nothing more (its guards check `Task.isCancelled`).
    /// Once the answer is in, it is too late: the turn ends as answered (review R3).
    private func stop() {
        guard !transcript.finished else { return }
        turn?.cancel()
        turn = nil
        status = nil
        if let question = transcript.stop(), draft.isEmpty { draft = question }
    }

    private func send(_ question: String) async {
        // A failed turn is never history (US-52 AC6d), so a retried first question is still new.
        let earlier = transcript.history
        let isNew = earlier.isEmpty
        let conversation = conversationId
        // An erase while the answer streams empties `lines` and the history: from then on
        // this turn is dropped, never indexed into the new lines or saved (review R1).
        let erasures = store.erasures
        let askedAt = ChatHistoryStore.erasures
        // A stopped or erased turn changes nothing more on screen.
        func live() -> Bool { store.erasures == erasures && !Task.isCancelled }
        asking = false
        // A stopped turn leaves these to Stop, and to the turn that may follow it.
        defer { if !Task.isCancelled { turn = nil; status = nil } }
        let answerIndex = transcript.ask(question)

        do {
            let context = try await engine.chatContext(recordJSON: store.recordJSON, now: .now, deviceId: store.deviceId)
            // Stopped or erased while the context was built: nothing is sent (review R5).
            guard live() else { return }
            let body = try ChatClient.body(message: question, conversationId: conversation, history: earlier, contextJSON: context)
            var finished = false
            for try await event in ChatClient().ask(body: body) {
                guard live() else { return }
                switch event {
                case .status(let text): status = text
                case .text(let text): transcript.lines[answerIndex].text += text
                case .sources(let titles): transcript.lines[answerIndex].sources = titles
                case .done(let content, let isFallback, let failure):
                    if let failure { throw AppAttestClient.Failure.server(status: 500, message: failure) }
                    // The answer is in: Stop goes, and it is saved (review R3).
                    let answer = transcript.finish(answerIndex, content: content)
                    finished = true
                    status = nil
                    await history.record(ChatExchange(conversationId: conversation, isNew: isNew, userText: question, assistantText: answer, isFallback: isFallback), askedAt: askedAt)
                case .other: break
                }
            }
            // A stream that ended with no `done` line was cut off: never history.
            guard live() else { return }
            if !finished { throw AppAttestClient.Failure.server(status: 0, message: "The answer was cut off. Please try again.") }
        } catch {
            guard live() else { return }
            transcript.fail(error)
        }
    }
}

