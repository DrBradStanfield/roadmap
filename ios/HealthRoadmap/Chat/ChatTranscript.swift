import Foundation

/// The conversation on screen, and what a failed or stopped answer leaves (US-52 AC6d).
/// A failed turn keeps its question, with Try again; it is never sent back as history,
/// and the next question replaces it. A stopped turn leaves the screen and hands its
/// question back for the composer.
struct ChatTranscript {
    var lines: [ChatLine]
    /// Why the last question has no answer, in plain words.
    private(set) var error: String?

    init(lines: [ChatLine] = []) {
        self.lines = lines
    }

    /// The earlier turns sent with a new question: finished ones only.
    var history: [ChatClient.Turn] {
        lines.filter { !$0.failed }.map { ChatClient.Turn(role: $0.role == .user ? "user" : "assistant", content: $0.text) }
    }

    /// The bubbles to draw: an answer shows once its first words arrive, never as an empty bubble.
    var shown: [ChatLine] { lines.filter { $0.role == .user || !$0.text.isEmpty } }

    /// The question whose answer failed, for Try again. Failed lines exist exactly while `error` is set.
    var retryQuestion: String? { lines.last { $0.role == .user && $0.failed }?.text }

    /// Starts a turn and returns its answer's index. A failed turn goes first.
    mutating func ask(_ question: String) -> Int {
        lines.removeAll(where: \.failed)
        error = nil
        finished = false
        lines.append(ChatLine(role: .user, text: question))
        lines.append(ChatLine(role: .assistant, text: ""))
        return lines.count - 1
    }

    /// The last answer is in (its `done` arrived) and goes to history: Stop is too late (review R3).
    private(set) var finished = false

    /// The answer is in: the final reply replaces what streamed (US-15 AC16). Returns the answer.
    mutating func finish(_ index: Int, content: String?) -> String {
        lines[index].text = content ?? lines[index].text
        finished = true
        return lines[index].text
    }

    /// The last turn failed: its question stays, an empty answer goes.
    mutating func fail(_ error: Error) {
        // An answer already finished (and saved to history) stays as it is.
        guard !finished else { return }
        guard let start = lines.lastIndex(where: { $0.role == .user }) else { return }
        if lines.last?.role == .assistant, lines.last?.text.isEmpty == true { lines.removeLast() }
        for index in start..<lines.count { lines[index].failed = true }
        self.error = Self.words(for: error)
    }

    /// The person stopped the last turn: it leaves the screen, and its question comes back.
    /// A finished turn stays, and nothing comes back.
    mutating func stop() -> String? {
        guard !finished, let start = lines.lastIndex(where: { $0.role == .user }) else { return nil }
        let question = lines[start].text
        lines.removeSubrange(start...)
        error = nil
        return question
    }

    /// What went wrong, in plain words: the server's own, or ours. Never a status code or an exception's text.
    static func words(for error: Error) -> String {
        switch error {
        case is AppAttestClient.Failure, is ChatClient.ContextRefused: error.localizedDescription
        case let url as URLError: AppAttestClient.words(for: url, subject: "The chat")
        default: "Something went wrong, so this question has no answer. Please try again."
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
