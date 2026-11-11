import Foundation
import Observation
import UIKit

/// US-56's state: whether to show the Turn On row or the cards, and the cards' latest
/// readings. The cards' last readings are kept in one file on this iPhone, so they draw in
/// the first frame at launch (AC2, AC15; Brad 2026-10-27): never a record row, UserDefaults
/// or a page's days. HealthKit is read off the main thread; only the results land here.
/// Nothing is logged. One per app, in the environment (HealthRoadmapApp).
@MainActor
@Observable
final class LiveHealth {
    /// Health exists on this device. False on an iPad without Health: no card shows (AC13).
    let available: Bool
    /// Whether the sheet is due, access granted, or the cards read (AC4, AC5, AC5d); changed
    /// only through `LiveAccess.transition`.
    private(set) var access: LiveAccess = .unknown
    /// Each metric's latest reading; a metric with none is left out (AC6). Kept while the views
    /// read it; lead M6 removes it once they switch on `access`.
    var cards: [LiveMetric: LiveCard] { access.cards }
    /// Counts returns to the app and unlocks: an open page reads again on each (Codex R1).
    private(set) var wakes = 0
    /// A metric page is on screen, for Clarity's fixed screen name "Apple Health metric" (usage signal).
    var pagesOpen = 0
    /// The connection generation a read may start under, nil while an erase has Apple Health
    /// disconnected (US-72 AC10, AppleHealthSync's one rule). AppleHealthSync sets it.
    @ObservationIgnored var connection: @MainActor () -> Int? = { 0 }

    @ObservationIgnored let store: any LiveHealthStore
    @ObservationIgnored let now: @Sendable () -> Date
    /// One calendar for the days, nights and labels, following the phone's zone (adversary R2).
    @ObservationIgnored let calendar: Calendar
    /// When the running read began; nil when none runs.
    @ObservationIgnored private var started: ContinuousClock.Instant?
    /// The refresh asked for during the running one, with the ticket it was asked under (Codex C-R2).
    @ObservationIgnored private var queued: Ticket?
    @ObservationIgnored private var lastWake: ContinuousClock.Instant?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    /// The cards' last readings (AC2); nil keeps none.
    @ObservationIgnored private let kept: URL?
    /// Bumped by `forget()`: a read begun before it lands nowhere (Codex R1, adversary R4).
    @ObservationIgnored private var generation = 0
    /// Each page's history, kept beside the cards (AC7a, Brad 2026-11-03); read and written off
    /// the main thread.
    @ObservationIgnored let history: LiveHistory
    /// Counts each metric's history removals: an open page clears what it shows and reads again,
    /// and a read it began before is dropped (Codex R2).
    private(set) var removals: [LiveMetric: Int] = [:]

    init(store: any LiveHealthStore, now: @escaping @Sendable () -> Date = { .now }, calendar: Calendar = .autoupdatingCurrent, kept: URL? = nil) {
        self.store = store
        self.now = now
        self.calendar = calendar
        self.kept = kept
        history = LiveHistory(folder: kept?.deletingLastPathComponent())
        // Heart rate is no longer shown, so no longer read or kept: its history goes once (US-73).
        if kept != nil { Task { [history] in await history.forgetDropped() } }
        available = store.isAvailable
        guard available else { return }
        // Read here, so the first frame has the cards; the first read updates them (AC15).
        // A file that is missing, damaged or another version is no file.
        if let kept, let data = try? Data(contentsOf: kept), let file = try? JSONDecoder().decode(KeptCards.self, from: data),
           file.version == KeptCards.current {
            // A metric no longer shown (heart rate, US-73) is left out, and the file kept without it.
            let shown = file.shown
            if shown.count < file.cards.count { keep(shown) }
            access = LiveAccess.launch(shown)
        }
        // A locked phone's read keeps what was drawn; the unlock reads again (AC13). A new day or
        // a new time zone reads again too, so "Today" and the days move (N5).
        observers = [UIApplication.protectedDataDidBecomeAvailableNotification, .NSCalendarDayChanged, .NSSystemTimeZoneDidChange].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.wake() }
            }
        }
    }

    /// Back in the app, or unlocked: the cards and an open page read again (AC2, AC13,
    /// Codex R1). An unlock and a return land together, so a second one within about 2 s
    /// is the same wake (E1).
    func wake() {
        guard available else { return }
        let clock = ContinuousClock.now
        if let lastWake, clock - lastWake < .seconds(2) { return }
        lastWake = clock
        wakes += 1
        Task { await refresh() }
    }

    /// Checks whether the sheet is still due, then reads the cards, each time My data shows
    /// (AC2). A refresh asked for during one runs once more after it, unless the running
    /// read began under about 2 s before: its answer is as fresh (E1). `force` always runs it
    /// once more (after Apple's sheet, N2). A cancelled read writes nothing (N1). The one asked
    /// for during it keeps its own ticket: it runs if that still holds, so a request from
    /// before an erase is dropped and one made after a reconnect is not (Codex C-R2).
    func refresh(force: Bool = false) async {
        guard available, let asked = ticket() else { return }
        if let started {
            if force || ContinuousClock.now - started >= .seconds(2) { queued = asked }
            return
        }
        started = .now
        defer {
            started = nil
            queued = nil
        }
        var next: Ticket? = asked
        while let begun = next {
            queued = nil
            await readOnce(begun)
            next = queued.flatMap { holds($0) ? $0 : nil }
        }
    }

    /// One refresh under `begun`; it stops, keeping nothing, once that no longer holds.
    private func readOnce(_ begun: Ticket) async {
        let store = reader(begun)
        // A check that fails keeps what was known, so the Turn On row never flashes (adversary R4).
        let due = try? await store.needsRequest()
        // Erased or disconnected meanwhile: this refresh keeps nothing (Codex R1).
        guard holds(begun) else { return }
        send(.checked(due))
        // Access reset: the sheet is due again, so the kept readings and histories go (AC2).
        if due == true {
            keep([:])
            await history.removeAll()
            removed(LiveMetric.allCases)
        }
        switch access {
        case .granted, .read: break
        case .unknown, .needsAccess: return
        }
        do {
            let (read, absent) = try await Self.readCardsNoting(store, now: now(), calendar: calendar)
            guard holds(begun) else { return }
            // Unchanged readings are not written, so nothing redraws (E5). An empty read always
            // removes the file, even one the launch could not read (adversary R3).
            if cards != read || read.isEmpty { keep(read) }
            // Drawn before the history awaits below, so an erase during them clears it.
            send(.cardsRead(read))
            // Health answered that it holds none of a metric (its access off in Settings, or
            // emptied): that metric's history goes. A read that failed removes nothing (adversary R3, R10).
            for metric in absent {
                await history.remove(metric)
                removed([metric])
            }
        } catch HealthStoreError.locked {
            // Locked: keep what the last read drew (AC13), and let the unlock's wake through (N2).
            lastWake = nil
            send(.readFailed)
        } catch {
            // Cancelled: keep what was drawn and mark nothing read (N1). `optional()` turns every
            // other error into no data, so only CancellationError reaches here.
            assert(error is CancellationError, "only locked or cancelled reach a refresh's catch")
            send(.readFailed)
        }
    }

    /// "Delete all my data" (AC2): the kept readings and histories go, and nothing shows until
    /// the next read.
    func forget() async {
        generation += 1
        keep([:])
        send(.forgot)
        await history.removeAll()
        removed(LiveMetric.allCases)
    }

    /// What a read began under: the connection generation and the `forget()`s so far.
    struct Ticket: Equatable {
        let connection: Int
        let forgets: Int
    }

    /// The ticket a read starts under now; nil while an erase has Apple Health disconnected.
    func ticket() -> Ticket? {
        connection().map { Ticket(connection: $0, forgets: generation) }
    }

    /// The read may go on and land: not cancelled, not forgotten, still on its connection.
    func holds(_ ticket: Ticket) -> Bool {
        !Task.isCancelled && self.ticket() == ticket
    }

    /// Health as one read sees it (the cards, a page): each call checks `ticket` before it
    /// starts and after it returns, and throws `CancellationError` once it no longer holds.
    func reader(_ ticket: Ticket) -> any LiveHealthStore {
        GatedLiveStore(base: store) { [weak self] in await self?.holds(ticket) ?? false }
    }

    /// The one way `access` changes; an unchanged state writes nothing, so nothing redraws (E5).
    private func send(_ event: LiveAccess.Event) {
        let next = LiveAccess.transition(access, event)
        if next != access { access = next }
    }

    private func removed(_ metrics: [LiveMetric]) {
        for metric in metrics { removals[metric, default: 0] += 1 }
    }

    /// Keeps the cards for the next launch; none removes the file (AC2). Atomic, readable
    /// after the first unlock (a launch reads it), in a folder backups skip.
    private func keep(_ read: [LiveMetric: LiveCard]) {
        guard let kept else { return }
        if read.isEmpty {
            try? FileManager.default.removeItem(at: kept)
        } else if let data = try? JSONEncoder().encode(KeptCards(cards: read)) {
            try? data.write(to: kept, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
    }

    /// The kept readings' file: its own folder in Application Support, made the record's way
    /// and left out of iCloud and computer backups, but apart from the record, so no sync,
    /// export or chat summary can reach it (AC2, Brad 2026-10-27).
    nonisolated static func keptFile(in base: URL = .applicationSupportDirectory) throws -> URL {
        try RecordStore.appFolder(in: base, named: "Apple Health").appending(path: "last-readings.json")
    }

    /// The kept file: the cards as drawn, and a version, nothing else.
    private struct KeptCards: Codable {
        static let current = 1
        var version = current
        /// By metric name, so a file holding one the app no longer shows still reads.
        let cards: [String: LiveCard]

        init(cards: [LiveMetric: LiveCard]) {
            self.cards = Dictionary(uniqueKeysWithValues: cards.map { ($0.key.rawValue, $0.value) })
        }

        /// The metrics the app shows.
        var shown: [LiveMetric: LiveCard] {
            Dictionary(uniqueKeysWithValues: cards.compactMap { key, card in LiveMetric(rawValue: key).map { ($0, card) } })
        }
    }

    /// The cards' readings, off the main thread, each metric on its own: its newest sample
    /// however old, then the 30 days ending on that sample's day for the value and trend. A
    /// fixed window back from today lost a VO2 max from six weeks ago (Codex R2). A trend of
    /// fewer than seven reads further back, for the last seven readings however old (AC14).
    @concurrent
    nonisolated static func readCards(_ store: any LiveHealthStore, now: Date, calendar: Calendar) async throws -> [LiveMetric: LiveCard] {
        try await readCardsNoting(store, now: now, calendar: calendar).cards
    }

    /// `readCards`, and the metrics Health answered that it holds none of (not a failed read).
    @concurrent
    nonisolated static func readCardsNoting(_ store: any LiveHealthStore, now: Date, calendar: Calendar) async throws -> (cards: [LiveMetric: LiveCard], absent: Set<LiveMetric>) {
        try await withThrowingTaskGroup(of: (LiveMetric, LiveCard?, Bool).self) { group in
            for metric in LiveMetric.allCases {
                group.addTask {
                    let (card, absent) = try await card(store, metric, now: now, calendar: calendar)
                    return (metric, card, absent)
                }
            }
            var cards: [LiveMetric: LiveCard] = [:]
            var absent: Set<LiveMetric> = []
            for try await (metric, card, none) in group {
                cards[metric] = card
                if none { absent.insert(metric) }
            }
            return (cards, absent)
        }
    }

    /// One metric's card, or nil; `absent` when Health answered that it holds none of it, not
    /// when the read failed.
    private nonisolated static func card(_ store: any LiveHealthStore, _ metric: LiveMetric, now: Date, calendar: Calendar) async throws -> (card: LiveCard?, absent: Bool) {
        guard let answer = try await optional({ try await store.latest(metric) }) else { return (nil, false) }
        guard let latest = answer else { return (nil, true) }
        return (try await card(store, metric, latest: latest, now: now, calendar: calendar), false)
    }

    /// The card from the metric's newest sample.
    private nonisolated static func card(_ store: any LiveHealthStore, _ metric: LiveMetric, latest: (value: Double?, date: Date), now: Date, calendar: Calendar) async throws -> LiveCard? {
        let newest = min(latest.date, now)
        if metric == .sleep {
            let today = calendar.startOfDay(for: now)
            let from = calendar.date(byAdding: .day, value: -30, to: newest) ?? newest
            let segments = try await optional { try await store.sleep(from: from, to: now) } ?? []
            let nights = LiveMaths.nights(segments, calendar: calendar)
            let card = LiveMaths.card(nights: nights, today: today, calendar: calendar)
            let held = nights.filter { $0.hasSleep && $0.day <= today }.map(\.day)
            if let card, !LiveMaths.readsBack(held, today: now, calendar: calendar) { return card }
            // The trend needs older nights (AC14), or the newest sample was a nap after 6 pm,
            // dated tomorrow, and the last real night is older than the 30 days (Codex R2,
            // 2026-10-26): look back as far as a sleep page does, and at least as far as the
            // first read. A read-back that fails or finds nothing more keeps the first card
            // (Codex R2, 2026-10-26).
            guard !segments.isEmpty else { return nil }
            let back = LiveHealth.pageStart(reaching: from, back: 200, now: now, calendar: calendar)
            let older = LiveMaths.nights(try await optional { try await store.sleep(from: back, to: now) } ?? [], calendar: calendar)
            guard older.filter({ $0.hasSleep && $0.day <= today }).count > held.count else { return card }
            return LiveMaths.card(nights: older, today: today, calendar: calendar) ?? card
        }
        let from = calendar.date(byAdding: .day, value: -29, to: calendar.startOfDay(for: newest)) ?? newest
        let days = try await days(store, metric, from: from, to: now)
        let card = LiveMaths.card(days: days, today: now, calendar: calendar)
        let held = days.filter { $0.value != nil }
        guard let card, LiveMaths.readsBack(held.map(\.start), today: now, calendar: calendar) else { return card }
        // The last seven, however old, may be further back (AC14). A read-back that fails or
        // finds nothing more keeps the first card (Codex R2, 2026-10-26).
        let back = calendar.date(byAdding: .day, value: -400, to: from) ?? from
        let older = try await self.days(store, metric, from: back, to: now)
        guard older.filter({ $0.value != nil }).count > held.count else { return card }
        return LiveMaths.card(days: older, today: now, calendar: calendar) ?? card
    }

    /// The first instant a page reads: `back` days before today, or the day of the card's
    /// reading when that is older, so a page always holds its card's reading (Codex R2).
    nonisolated static func pageStart(reaching reading: Date?, back: Int, now: Date, calendar: Calendar) -> Date {
        let start = calendar.date(byAdding: .day, value: -back, to: calendar.startOfDay(for: now)) ?? now
        return reading.map { min(start, calendar.startOfDay(for: $0)) } ?? start
    }

    /// What a page draws before its history is brought up to date (AC7a): the kept days, else
    /// (a first visit) 400 days read now.
    /// Under `ticket` (nil: one taken now); nothing while disconnected or once it no longer holds.
    func firstDays(_ metric: LiveMetric, reaching reading: Date?, under ticket: Ticket? = nil) async -> [LivePoint]? {
        guard let ticket = ticket ?? self.ticket() else { return nil }
        if let kept = await history.keptDays(metric) { return holds(ticket) ? kept : nil }
        return try? await Self.readDays(reader(ticket), metric, reaching: reading, now: now(), calendar: calendar)
    }

    /// A metric page's first visit (AC7, AC7a): 400 days to now, back further to the card's
    /// reading, drawn while `LiveHistory` reads the whole history. Read only once the page
    /// leaves D (E4).
    @concurrent
    nonisolated static func readDays(_ store: any LiveHealthStore, _ metric: LiveMetric, reaching reading: Date?, now: Date, calendar: Calendar) async throws -> [LivePoint] {
        try await days(store, metric, from: pageStart(reaching: reading, back: 400, now: now, calendar: calendar), to: now)
    }

    /// Sleep's page on its first visit (AC9, AC7a): the nights of the last 200 days, back further
    /// to the card's night (its sleep began the evening before the day it is dated), drawn while
    /// `LiveHistory` reads every night.
    @concurrent
    nonisolated static func readNights(_ store: any LiveHealthStore, reaching night: Date?, now: Date, calendar: Calendar) async throws -> [SleepNight] {
        let evening = night.flatMap { calendar.date(byAdding: .day, value: -1, to: $0) }
        let from = pageStart(reaching: evening, back: 200, now: now, calendar: calendar)
        let segments = try await optional { try await store.sleep(from: from, to: now) } ?? []
        return LiveMaths.nights(segments, calendar: calendar)
    }

    private nonisolated static func days(_ store: any LiveHealthStore, _ metric: LiveMetric, from: Date, to: Date) async throws -> [LivePoint] {
        try await optional { try await store.points(metric, from: from, to: to, every: .day) } ?? []
    }

    /// A read that failed for any reason but a locked phone or a cancelled task shows as no
    /// data; those throw, so a cancelled read is never kept as "read, empty" (N1).
    private nonisolated static func optional<T: Sendable>(_ read: @Sendable () async throws -> T) async throws -> T? {
        do {
            let value = try await read()
            try Task.checkCancellation()
            return value
        } catch HealthStoreError.locked {
            throw HealthStoreError.locked
        } catch {
            try Task.checkCancellation()
            if error is CancellationError { throw error }
            return nil
        }
    }
}
