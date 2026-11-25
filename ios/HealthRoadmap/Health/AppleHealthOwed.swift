import Foundation

/// The delete an erase owes Apple Health (US-72 AC10, AC16): the erase's Health delete and the
/// one owed pay at a time (lead H41). AppleHealthSync owns the run, so each call hands over its
/// drain (`AppleHealthSync.drained`) and what refreshes the footer once a pay settles.
@MainActor
final class OwedPay {
    private let client: HealthStoreClient
    /// The sync's own memory: a struct over the same UserDefaults.
    private let memory: HealthSyncMemory
    /// The owed delete in flight, the one claim every caller awaits (`pay`).
    private var paying: Task<Bool, Never>?

    init(client: HealthStoreClient, memory: HealthSyncMemory) {
        self.client = client
        self.memory = memory
    }

    /// "Delete all my data" (US-25 AC16, US-72 AC10), from the erase's drain deadline on, once
    /// Apple Health is disconnected: waits for a running pass to stop (`drain`), then deletes the
    /// samples this app wrote: by the sync ids owed, so each id leaves only when its own sample
    /// went (edge 2), then by source, for any it never listed. False when Health refused the
    /// delete or left an id (a kind whose write access is off), for the erase to say so; those
    /// ids stay owed (`pay`). One drain deadline for the whole erase (lead H34), so the Health
    /// delete starts within `AppleHealthSync.drainBound`, never after a second drain.
    func deleteAll(deadline: ContinuousClock.Instant, drain: @escaping @MainActor (ContinuousClock.Instant) async -> Void,
                   settled: @escaping @MainActor () -> Void) async -> Bool {
        await drain(deadline)
        do {
            let paid = await pay(erasing: deadline, drain: drain, settled: settled)
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
    /// running pass has stopped (`drain`); an id leaves the list only when its own delete
    /// succeeded (`settle`). Tried when an erase disconnects, on Connect, then once per return to
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
    func pay(erasing deadline: ContinuousClock.Instant?, drain: @escaping @MainActor (ContinuousClock.Instant) async -> Void,
             settled: @escaping @MainActor () -> Void) async -> Bool {
        if let paying {
            let paid = await paying.value
            guard deadline != nil else { return paid }
            if let next = self.paying { return await next.value }
        }
        guard client.isAvailable, !memory.owed.ids.isEmpty else { return true }
        let claim = Task {
            defer { paying = nil }
            await drain(deadline ?? .now + AppleHealthSync.drainBound)
            return await settle(memory.owed.ids, settled: settled)
        }
        paying = claim
        return await claim.value
    }

    /// Deletes `owed` by sync id. The ids Health deleted leave the list, each unless a newer
    /// version was saved meanwhile (Codex C-R1); true when none was left.
    /// An id not found is gone when Health was asked about its kind (lead H29); one whose kind is
    /// not known, only when Health was asked about every kind. A delete Health refused deleted none,
    /// and counts as a failed pay too (AC16).
    private func settle(_ owed: [String: Int64], settled: @MainActor () -> Void) async -> Bool {
        let done = try? await client.deleteSamples(syncIds: Array(owed.keys))
        let paid = done.map { done in
            owed.filter { id, _ in
                done.deleted.contains(id) || memory.kind(id).map(done.asked.contains) ?? done.asked.isSuperset(of: HealthDeletion.kinds)
            }
        } ?? [:]
        memory.paid(paid)
        settled()
        return paid.count == owed.count
    }
}
