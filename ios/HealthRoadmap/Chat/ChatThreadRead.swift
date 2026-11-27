import Foundation

/// The read of a saved conversation opened from History (US-52 AC17, root fix R29). One state:
/// `ready` (nothing being read; the conversation on screen is the one a question goes to),
/// `loading` a conversation, or its read `failed`. Changed only through `transition`. Each read
/// names the attempt it began under, so a late answer from an older one changes nothing.
/// The web twin is the thread load in packages/health-core/src/chat-turn.ts (US-15 AC7a).
enum ChatThreadRead: Equatable {
    case ready(attempt: Int)
    case loading(id: String, attempt: Int)
    case failed(id: String, attempt: Int)

    enum Event: Equatable {
        /// A tap in History, or Try again.
        case open(id: String)
        /// The engine read the conversation begun under `attempt`.
        case loaded(attempt: Int)
        /// The file is there but the conversation begun under `attempt` could not be read.
        case unreadable(attempt: Int)
        /// New chat, or an erase: the screen moves on, and a read under way is dropped.
        case leave
    }

    var attempt: Int {
        switch self {
        case .ready(let attempt), .loading(_, let attempt), .failed(_, let attempt): attempt
        }
    }

    /// A question may go only when no read is under way or failed: never sent without that conversation's turns.
    var canAsk: Bool { if case .ready = self { true } else { false } }

    static func transition(_ state: Self, _ event: Event) -> Self {
        switch (state, event) {
        case (_, .open(let id)): .loading(id: id, attempt: state.attempt + 1)
        case (_, .leave): .ready(attempt: state.attempt + 1)
        case (.loading(_, let attempt), .loaded(let answered)) where answered == attempt: .ready(attempt: attempt)
        case (.loading(let id, let attempt), .unreadable(let answered)) where answered == attempt: .failed(id: id, attempt: attempt)
        case (_, .loaded), (_, .unreadable): state
        }
    }
}
