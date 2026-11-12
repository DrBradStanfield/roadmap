import Foundation

/// A chat reply's edits and its banners' Save and Undo (US-67).
/// Split out of RecordStore.swift.
extension RecordStore {
    // MARK: Chat edits (US-67); the record's mark is RecordStore+Mark.swift

    /// A chat reply's edits, taken in one turn: the engine's preview against the record now,
    /// and its medication part written at once, as the web's is (US-67 AC3).
    struct ChatEditsTaken: Sendable {
        let preview: ChatEditsPreview
        /// What writing the medication part did; nil when the reply has none.
        let medications: ApplyResult?
        /// The medication part changed the record.
        let changed: Bool
        /// The record the banners were made on.
        let mark: Mark
    }

    /// What became of a reply's edits: nothing is written or shown when the record was
    /// erased since the question was asked (`moved`) or the engine could not read them.
    enum ChatEditsOutcome: Sendable {
        case taken(ChatEditsTaken)
        case moved
        case unreadable
    }

    func takeChatEdits(_ edits: OpaqueJSON, today: String, asked: Mark) async -> ChatEditsOutcome {
        let outcome = await chain { () -> ChatEditsOutcome in
            guard asked.holds(at: self.mark) else { return .moved }
            guard let preview = try? await self.engine.chatEdits(recordJSON: self.recordJSON, edits: edits, now: .now, deviceId: self.deviceId, today: today, units: self.unitChoices.json)
            else { return .unreadable }
            // No medication part, or one the engine refused: nothing is written now. A part with
            // no Undo is still written (US-67 N3).
            guard let meds = preview.medications, meds.refusal == nil else {
                return .taken(ChatEditsTaken(preview: preview, medications: nil, changed: false, mark: self.mark))
            }
            let before = self.recordJSON
            let result = await self.applyInTurn(.chatEdits(part: .medications, edits: edits, today: today), as: self.screen)
            return .taken(ChatEditsTaken(preview: preview, medications: result, changed: self.recordJSON != before, mark: self.mark))
        }.value
        if case .taken(let taken) = outcome, taken.changed { ownSaves += 1 }
        return outcome
    }

    /// A chat banner's Save or Undo, refused when the record was erased since the banner was
    /// made (`mark`): on the phone an erase leaves `cloudErase` nil, so `applyInTurn`'s check
    /// alone cannot see it. `changed`: the record moved.
    func applyChatEdit(_ edit: RecordEdit, on mark: Mark) async -> (result: ApplyResult, changed: Bool) {
        let answer = await chain { () -> (ApplyResult, Bool) in
            guard mark.holds(at: self.mark) else {
                return (.refused(message: "Your data was deleted since the chat suggested this, so it was not saved.", existingId: nil), false)
            }
            let before = self.recordJSON
            return (await self.applyInTurn(edit, as: self.screen), self.recordJSON != before)
        }.value
        if answer.1 { ownSaves += 1 }
        return answer
    }
}
