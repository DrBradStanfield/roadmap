import Foundation

/// The delete an erase owes Apple Health (US-72 AC10, AC16): the erase's Health delete, the one
/// owed pay at a time, and the drain both wait on. Split from AppleHealthSync.swift as a pure move;
/// its state stays in the main type.
extension AppleHealthSync {
    /// "Delete all my data" (US-25 AC16, US-72 AC10), once the record's erase has landed:
    /// disconnects Apple Health, waits for a running pass to stop (`drained`), then deletes the
    /// samples this app wrote: by the sync ids owed, so each id leaves only when its own sample
    /// went (edge 2), then by source, for any it never listed. `wasConnected`: Health
    /// was connected as the erase began (a pass that saw the erase first may have disconnected
    /// it already); a delete still owed (`HealthSyncMemory.owed`) is made either way. False when
    /// Health refused the delete or left an id (a kind whose write access is off), for the erase
    /// to say so; those ids stay owed (`deleteOwed`). Neither: nothing to delete.
    /// One drain deadline for the whole erase (lead H34), so the Health delete starts within
    /// `drainBound`, never after a second drain.
    func erased(wasConnected: Bool) async -> Bool {
        if let source = store.recordSource { memory.eraseSeen = EraseSeen(epoch: store.myData?.eraseEpoch ?? 0, source: source) }
        disconnect()
        guard client.isAvailable, wasConnected || !memory.owed.ids.isEmpty || memory.owedUnreadable else { return true }
        let deadline = ContinuousClock.now + Self.drainBound
        await drained(by: deadline)
        do {
            let paid = await deleteOwed(erasing: deadline)
            let asked = try await client.deleteOwnSamples()
            // An unreadable owed value goes only once every kind the app writes was asked (AC16 F1).
            guard memory.owedUnreadable else { return paid }
            guard asked.isSuperset(of: HealthDeletion.kinds) else { return false }
            memory.forgetUnreadableOwed()
            return paid
        } catch {
            return false
        }
    }

    /// A delete is owed while `HealthSyncMemory.owed` is not empty: the list is the only pending
    /// state (US-72 AC10), connected again or not. The samples go by their sync ids, once a
    /// running pass has stopped (`drained`); an id leaves the list only when its own delete
    /// succeeded (`pay`). Tried when an erase disconnects, on Connect, then once per return to
    /// the foreground and once per unlock, never in a loop: a delete Health keeps refusing
    /// (write access turned off) waits for the next of those.
    /// One pay at a time (lead H32): a caller that comes while one runs awaits that same pay
    /// (`paying`), never starts a second on the same owed ids. So each caller's refresh starts only
    /// once no pay is in flight, and no slow delete can take a sample a refresh wrote again after
    /// the pay before it. True when nothing is left owed.
    /// `erasing`: an erase just owed new ids, and its drain deadline. A pay already in flight may
    /// have read the owed list before them (lead H33): the erase waits it out, then pays its own,
    /// joining only a pay claimed after it. Its drain shares the erase's deadline (lead H34).
    @discardableResult
    func deleteOwed(erasing deadline: ContinuousClock.Instant? = nil) async -> Bool {
        if let paying {
            let paid = await paying.value
            guard deadline != nil else { return paid }
            if let next = self.paying { return await next.value }
        }
        guard client.isAvailable, !memory.owed.ids.isEmpty else { return true }
        let claim = Task {
            defer { paying = nil }
            await drained(by: deadline ?? .now + Self.drainBound)
            return await pay(memory.owed.ids)
        }
        paying = claim
        return await claim.value
    }

    /// Deletes `owed` by sync id. The ids Health deleted leave the list, each unless a newer
    /// version was saved meanwhile (Codex C-R1); true when none was left.
    /// An id not found is gone when Health was asked about its kind (lead H29); one whose kind is
    /// not known, only when Health was asked about every kind. A delete Health refused deleted none,
    /// and counts as a failed pay too (AC16).
    private func pay(_ owed: [String: Int64]) async -> Bool {
        let done = try? await client.deleteSamples(syncIds: Array(owed.keys))
        let settled = done.map { done in
            owed.filter { id, _ in
                done.deleted.contains(id) || memory.kind(id).map(done.asked.contains) ?? done.asked.isSuperset(of: HealthDeletion.kinds)
            }
        } ?? [:]
        memory.paid(settled)
        owedFooter = memory.owed.showsFooter
        return settled.count == owed.count
    }

    /// How long an erase's Health delete waits for a running pass. The record's erase has
    /// already landed: only the Health delete waits, and never on a hung HealthKit call.
    static let drainBound: Duration = .seconds(2)

    /// Waits for a running pass to end (`waiting`), or `deadline`, whichever comes first.
    /// The erase moved the generation, so the pass stops at its next check, once its HealthKit
    /// call returns. A call that hangs past the bound is left running: a sample it saves later
    /// is owed (`writeTyped`), and the next foreground or unlock deletes it (`deleteOwed`).
    /// The deadline is its own task, so a cancelled caller still waits for it, never spins.
    func drained(by deadline: ContinuousClock.Instant) async {
        guard running, deadline > .now else { return }
        let id = UUID()
        let timer = Task { [weak self] in
            try? await Task.sleep(until: deadline, clock: .continuous)
            self?.waiting.removeValue(forKey: id)?.resume()
        }
        await withCheckedContinuation { waiting[id] = $0 }
        timer.cancel()
    }
}
