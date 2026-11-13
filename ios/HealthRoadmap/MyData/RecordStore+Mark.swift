import Foundation

/// Which record is on screen, as the chat (US-67) and Apple Health (US-72 AC10) see it.
extension RecordStore {
    /// The record something was read or made on: a chat question or banner (US-67 AC5), an
    /// Apple Health batch (US-72 AC10). The cloud erase it showed, its eraseEpoch and this
    /// phone's erase count. An erase, here or by sync, moves one of them, and what was made
    /// before it writes nothing (US-16 AC2a).
    struct Mark: Equatable, Sendable {
        let erase: String?
        let epoch: Int?
        let erasures: Int

        /// Whether `now` is the same record, never erased since. Connecting or disconnecting a
        /// cloud is not an erase: the cloud erase is compared only while both sides have one.
        func holds(at now: Mark) -> Bool {
            epoch == now.epoch && erasures == now.erasures && (erase == nil || now.erase == nil || erase == now.erase)
        }
    }

    var mark: Mark { Mark(erase: cloudErase, epoch: myData?.eraseEpoch, erasures: erasures) }

    /// `applyNow` for an Apple Health batch (US-72 AC10), on `mark`, the record it was read
    /// from. Nil when an erase since moved the mark, or the mark was taken on the other side
    /// (cloud or phone: lead H28), in its turn: nothing was saved and there is nothing to say;
    /// the import's next pass meets the erase or reads the record now shown. `Mark.holds` alone
    /// stays lenient across a connect or disconnect, for the chat (US-67).
    func applyNow(_ edit: RecordEdit, on mark: Mark) async -> ApplyResult? {
        await chain { () -> ApplyResult? in
            let now = self.mark
            guard mark.holds(at: now), (mark.erase == nil) == (now.erase == nil) else { return nil }
            return await self.applyInTurn(edit, as: self.screen)
        }.value
    }

    /// Whether `seen` is still the record shown: no erase taken in or made here, and sync not
    /// turned on or off, since it was taken. `applyInTurn`'s guard (US-25 AC11g).
    func shows(_ seen: Screen) -> Bool { seen.erase == cloudErase && seen.mark.holds(at: mark) }

    /// The pinned screen is still the record shown (true with no pin): an onboarding page asks
    /// after a refusal whether the record moved under it (US-54 AC5d). Read-only.
    var pinStillShown: Bool { pinned.map(shows) ?? true }

    /// Which record is shown, for Apple Health's erase gate (US-72 AC10): `Source.recordSource`.
    var recordSource: String? { source.recordSource }
}

extension RecordStore.Screen {
    /// The record a sheet was opened on, as a `Mark`: `applyInTurn` checks it with `Mark.holds`,
    /// so an erase of the phone's file, where both cloud erases are nil, refuses it (US-25 AC11g).
    var mark: RecordStore.Mark { RecordStore.Mark(erase: erase, epoch: epoch, erasures: erasures) }
}
