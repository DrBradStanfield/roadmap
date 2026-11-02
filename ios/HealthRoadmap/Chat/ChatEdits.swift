import SwiftUI

/// What the chat's edits show and do (US-67), as the web's chat does (US-16, F11): a
/// medication change saves at once with Undo; values, height and sex wait in a banner
/// with Save and Not now. The engine reads, converts and writes every edit; this keeps
/// only the banners, their lines and the opaque edits behind their buttons.
@MainActor
@Observable
final class ChatEdits {
    /// The medication change written from a reply, with its Undo.
    struct Saved: Equatable {
        let lines: [ChatEditsPreview.Line]
        let undo: OpaqueJSON
        let mark: RecordStore.ChatMark
    }

    /// The values waiting for Save.
    struct Review: Equatable {
        let id = UUID()
        let lines: [ChatEditsPreview.Line]
        /// Why it cannot be saved: the engine's words, or a refused Save's. Then there is no Save.
        var refusal: String?
        let edits: OpaqueJSON
        let today: String
        /// The preview's `seen`, passed back on Save.
        let seen: OpaqueJSON?
        let mark: RecordStore.ChatMark
    }

    private(set) var saved: Saved?
    private(set) var review: Review?
    /// Why a medication change or its Undo was not saved.
    private(set) var problem: String?
    /// A Save or Undo is landing: the buttons wait.
    private(set) var busy = false
    /// Sends a Clarity event (D9): fixed words only.
    @ObservationIgnored var send: @MainActor (Analytics.Event) -> Void = { _ in }

    private let store: RecordStore
    /// Moves on every drop, so an answer landing after an erase shows nothing.
    @ObservationIgnored private var generation = 0

    init(store: RecordStore) {
        self.store = store
    }

    /// A reply's edits (`edits`, as the server sent them), for the question asked on `asked`.
    /// Dropped when the record was erased since (AC5). A new banner replaces an unanswered one.
    func take(_ edits: OpaqueJSON, asked: RecordStore.ChatMark, today: String = DayText.iso(.now)) async {
        let generation = generation
        let taken: RecordStore.ChatEditsTaken
        switch await store.takeChatEdits(edits, today: today, asked: asked) {
        case .taken(let answer): taken = answer
        // The reply's words may say it saved: the screen says it did not (US-67 AC3, AC5).
        case .moved: return show(Self.moved)
        case .unreadable: return show("These changes could not be shown, so nothing was saved.")
        }
        // Erased while the turn returned: whatever it wrote went with the erase.
        guard taken.mark.holds(at: store.chatMark) else { return show(Self.moved) }
        var shown = false
        // A medication change that was written always gets its Undo, even if the
        // conversation moved on meanwhile: the two are never split.
        if let medications = taken.preview.medications, let result = taken.medications {
            switch result {
            case .saved:
                saved = Saved(lines: medications.lines, undo: medications.undo, mark: taken.mark)
                problem = nil
                if taken.changed { send(.chatEditSaved) }
            case .refused(let message, _):
                saved = nil
                problem = message
            }
            shown = true
        }
        if let preview = taken.preview.review, generation == self.generation {
            review = Review(lines: preview.lines, refusal: preview.refusal, edits: edits, today: today, seen: preview.seen, mark: taken.mark)
            shown = true
        }
        if shown { send(.chatEditProposed) }
    }

    /// Save: the engine checks the edits again against the record now and writes them all, or
    /// none and says why.
    func save() async {
        guard let asked = review, asked.refusal == nil, !busy else { return }
        busy = true
        defer { busy = false }
        let (result, changed) = await store.applyChatEdit(.chatEdits(part: .review, edits: asked.edits, today: asked.today, seen: asked.seen), on: asked.mark)
        // Dropped, or replaced by a newer reply's banner, meanwhile: that one stays.
        guard review?.id == asked.id else { return }
        switch result {
        case .saved:
            review = nil
            if changed { send(.chatEditSaved) }
        case .refused(let message, _):
            review?.refusal = message
        }
    }

    static let moved = "Not saved: your record changed since you asked."

    private func show(_ words: String) {
        saved = nil
        problem = words
    }

    /// The record on screen moved (ChatView): a banner made before an erase goes, here or by
    /// sync (US-67 AC5). Connecting or disconnecting a cloud is not an erase.
    func follow(_ now: RecordStore.ChatMark) {
        if let saved, !saved.mark.holds(at: now) { self.saved = nil }
        if let review, !review.mark.holds(at: now) { self.review = nil }
    }

    /// Not now: the banner goes, and nothing is written.
    func notNow() {
        review = nil
    }

    /// Undo: the engine's own edit puts the medications back.
    func undo() async {
        guard let change = saved, !busy else { return }
        busy = true
        defer { busy = false }
        let (result, _) = await store.applyChatEdit(.engineEdit(change.undo), on: change.mark)
        guard saved == change else { return }
        saved = nil
        if case .refused(let message, _) = result { problem = message }
    }

    /// The medication banner, closed.
    func close() {
        saved = nil
        problem = nil
    }

    /// An erase, here or by sync (AC5): the banners and the Undo go.
    func drop() {
        generation += 1
        saved = nil
        review = nil
        problem = nil
    }
}

/// The chat's edit banners, under the answer that made them (US-67 AC3). Masked with the
/// rest of the window (D9): the lines can hold health values.
struct ChatEditBanners: View {
    let edits: ChatEdits

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if edits.saved != nil || edits.problem != nil { medications }
            if let review = edits.review { reviewBanner(review) }
        }
    }

    private var medications: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let saved = edits.saved {
                Label("Medication updated from chat", systemImage: "checkmark.circle.fill")
                    .font(.subheadline.weight(.semibold))
                lines(saved.lines)
            }
            if let problem = edits.problem {
                Text(problem).font(.footnote).foregroundStyle(.red)
            }
            HStack {
                if edits.saved != nil {
                    Button("Undo", systemImage: "arrow.uturn.backward") { Task { await edits.undo() } }
                        .buttonStyle(.bordered)
                        .disabled(edits.busy)
                        .accessibilityHint("Puts your medications back as they were")
                }
                Spacer()
                Button("Close", systemImage: "xmark") { edits.close() }
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .disabled(edits.busy)
            }
        }
        .bannerCard()
        .accessibilityElement(children: .contain)
    }

    private func reviewBanner(_ review: ChatEdits.Review) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Label("Save to your record?", systemImage: "square.and.arrow.down")
                .font(.subheadline.weight(.semibold))
            lines(review.lines)
            if let refusal = review.refusal {
                Text(refusal).font(.footnote).foregroundStyle(.red)
            }
            if review.refusal == nil {
                Button("Save") { Task { await edits.save() } }
                    .buttonStyle(.accent)
                    .disabled(edits.busy)
                Button("Not now") { edits.notNow() }
                    .frame(maxWidth: .infinity)
                    .disabled(edits.busy)
            } else {
                Button("Close") { edits.notNow() }
                    .frame(maxWidth: .infinity)
            }
        }
        .bannerCard()
        .accessibilityElement(children: .contain)
    }

    /// Each change on its own line, with the value it replaces under it.
    private func lines(_ lines: [ChatEditsPreview.Line]) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in
                VStack(alignment: .leading, spacing: 1) {
                    Text(line.text)
                    if let replaces = line.replaces {
                        Text("Replaces \(replaces)").font(.caption).foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .font(.subheadline)
    }
}

private extension View {
    func bannerCard() -> some View {
        padding(12)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color(.secondarySystemBackground), in: .rect(cornerRadius: 12))
    }
}
