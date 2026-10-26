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
    /// Apple's sheet would still show for the five types: My data shows the Turn On row
    /// (AC4, AC5). Nil until the first check.
    private(set) var needsAccess: Bool?
    /// Each metric's latest reading; a metric with none is left out (AC6).
    private(set) var cards: [LiveMetric: LiveCard] = [:]
    /// The cards have been read at least once since access.
    private(set) var hasRead = false
    /// Counts returns to the app and unlocks: an open page reads again on each (Codex R1).
    private(set) var wakes = 0
    /// A metric page is on screen, for Clarity's fixed screen name "Apple Health metric" (usage signal).
    var pagesOpen = 0

    @ObservationIgnored let store: any LiveHealthStore
    @ObservationIgnored let now: @Sendable () -> Date
    /// One calendar for the days, nights and labels, following the phone's zone (adversary R2).
    @ObservationIgnored let calendar: Calendar
    /// When the running read began; nil when none runs.
    @ObservationIgnored private var started: ContinuousClock.Instant?
    @ObservationIgnored private var again = false
    @ObservationIgnored private var lastWake: ContinuousClock.Instant?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    /// The cards' last readings (AC2); nil keeps none.
    @ObservationIgnored private let kept: URL?
    /// Bumped by `forget()`: a read begun before it lands nowhere (Codex R1, adversary R4).
    @ObservationIgnored private var generation = 0

    init(store: any LiveHealthStore, now: @escaping @Sendable () -> Date = { .now }, calendar: Calendar = .autoupdatingCurrent, kept: URL? = nil) {
        self.store = store
        self.now = now
        self.calendar = calendar
        self.kept = kept
        available = store.isAvailable
        guard available else { return }
        // Read here, so the first frame has the cards; the first read updates them (AC15).
        // A file that is missing, damaged or another version is no file.
        if let kept, let data = try? Data(contentsOf: kept), let file = try? JSONDecoder().decode(KeptCards.self, from: data),
           file.version == KeptCards.current, !file.cards.isEmpty {
            cards = file.cards
            needsAccess = false
            hasRead = true
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
    /// once more (after Apple's sheet, N2). A cancelled read writes nothing (N1).
    func refresh(force: Bool = false) async {
        guard available else { return }
        if let started {
            if force || ContinuousClock.now - started >= .seconds(2) { again = true }
            return
        }
        started = .now
        defer { started = nil }
        let begun = generation
        repeat {
            again = false
            // A check that fails keeps what was known, so the Turn On row never flashes (adversary R4).
            let due = (try? await store.needsRequest()) ?? needsAccess
            // Erased meanwhile: this refresh, and any asked for during it, keep nothing (Codex R1).
            guard !Task.isCancelled, begun == generation else { return }
            if needsAccess != due { needsAccess = due }
            // Access reset: the sheet is due again, so the kept readings go (AC2).
            if due == true { keep([:]) }
            guard due == false else { continue }
            do {
                let read = try await Self.readCards(store, now: now(), calendar: calendar)
                guard !Task.isCancelled, begun == generation else { return }
                // Unchanged readings are not written, so nothing redraws (E5). An empty read always
                // removes the file, even one the launch could not read (adversary R3).
                if cards != read || read.isEmpty { keep(read) }
                if !hasRead { hasRead = true }
            } catch HealthStoreError.locked {
                // Locked: keep what the last read drew (AC13), and let the unlock's wake through (N2).
                lastWake = nil
            } catch {
                // Cancelled: keep what was drawn and mark nothing read (N1).
                return
            }
        } while again
    }

    /// "Delete all my data" (AC2): the kept readings go, and nothing shows until the next read.
    func forget() {
        generation += 1
        keep([:])
        if hasRead { hasRead = false }
    }

    /// Draws the cards and keeps them for the next launch; none removes the file (AC2).
    /// Atomic, readable after the first unlock (a launch reads it), in a folder backups skip.
    private func keep(_ read: [LiveMetric: LiveCard]) {
        if cards != read { cards = read }
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
        let cards: [LiveMetric: LiveCard]
    }

    /// The cards' readings, off the main thread, each metric on its own: its newest sample
    /// however old, then the 30 days ending on that sample's day for the value and trend. A
    /// fixed window back from today lost a VO2 max from six weeks ago (Codex R2). A trend of
    /// fewer than seven reads further back, for the last seven readings however old (AC14).
    @concurrent
    nonisolated static func readCards(_ store: any LiveHealthStore, now: Date, calendar: Calendar) async throws -> [LiveMetric: LiveCard] {
        try await withThrowingTaskGroup(of: (LiveMetric, LiveCard?).self) { group in
            for metric in LiveMetric.allCases {
                group.addTask { (metric, try await card(store, metric, now: now, calendar: calendar)) }
            }
            var cards: [LiveMetric: LiveCard] = [:]
            for try await (metric, card) in group { cards[metric] = card }
            return cards
        }
    }

    /// One metric's card, or nil when Health holds none of it.
    private nonisolated static func card(_ store: any LiveHealthStore, _ metric: LiveMetric, now: Date, calendar: Calendar) async throws -> LiveCard? {
        guard let latest = try await optional({ try await store.latest(metric) }) ?? nil else { return nil }
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
        // Heart rate's card is its newest sample; its trend is the days' averages.
        let sample = metric.aggregation == .range ? latest.value.map { (value: $0, date: latest.date) } : nil
        let card = LiveMaths.card(days: days, latest: sample, today: now, calendar: calendar)
        let held = days.filter { $0.value != nil }
        guard let card, LiveMaths.readsBack(held.map(\.start), today: now, calendar: calendar) else { return card }
        // The last seven, however old, may be further back (AC14). A read-back that fails or
        // finds nothing more keeps the first card: heart rate's would otherwise lose its
        // trend, since its newest sample makes a card from no days (Codex R2, 2026-10-26).
        let back = calendar.date(byAdding: .day, value: -400, to: from) ?? from
        let older = try await self.days(store, metric, from: back, to: now)
        guard older.filter({ $0.value != nil }).count > held.count else { return card }
        return LiveMaths.card(days: older, latest: sample, today: now, calendar: calendar) ?? card
    }

    /// The first instant a page reads: `back` days before today, or the day of the card's
    /// reading when that is older, so a page always holds its card's reading (Codex R2).
    nonisolated static func pageStart(reaching reading: Date?, back: Int, now: Date, calendar: Calendar) -> Date {
        let start = calendar.date(byAdding: .day, value: -back, to: calendar.startOfDay(for: now)) ?? now
        return reading.map { min(start, calendar.startOfDay(for: $0)) } ?? start
    }

    /// A metric page's days (AC7): 400 days to now, back further to the card's reading.
    /// Read only once the page leaves D (E4).
    @concurrent
    nonisolated static func readDays(_ store: any LiveHealthStore, _ metric: LiveMetric, reaching reading: Date?, now: Date, calendar: Calendar) async throws -> [LivePoint] {
        try await days(store, metric, from: pageStart(reaching: reading, back: 400, now: now, calendar: calendar), to: now)
    }

    /// D's hours (AC7): the day holding `day`, up to now, read as the person moves to it.
    @concurrent
    nonisolated static func readHours(_ store: any LiveHealthStore, _ metric: LiveMetric, day: Date, now: Date, calendar: Calendar) async throws -> [LivePoint] {
        let start = calendar.startOfDay(for: day)
        let end = min(calendar.date(byAdding: .day, value: 1, to: start) ?? now, now)
        guard end > start else { return [] }
        return try await optional { try await store.points(metric, from: start, to: end, every: .hour) } ?? []
    }

    /// Sleep's page (AC9): the nights of the last 200 days, back further to the card's
    /// night (its sleep began the evening before the day it is dated).
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
