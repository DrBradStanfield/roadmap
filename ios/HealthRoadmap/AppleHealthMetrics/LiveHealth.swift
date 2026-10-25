import Foundation
import Observation
import UIKit

/// US-56's state: whether to show the access card or the cards, and the cards' latest
/// readings. Held in memory while the app is open and nowhere else (AC2): no record row,
/// no file, no UserDefaults. HealthKit is read off the main thread; only the results land
/// here. Nothing is logged. One per app, in the environment (HealthRoadmapApp).
@MainActor
@Observable
final class LiveHealth {
    /// Health exists on this device. False on an iPad without Health: no card shows (AC13).
    let available: Bool
    /// Apple's sheet would still show for the five types: My data shows the access card
    /// (AC4, AC5). Nil until the first check.
    private(set) var needsAccess: Bool?
    /// Each metric's latest reading; a metric with none is left out (AC6).
    private(set) var cards: [LiveMetric: LiveCard] = [:]
    /// The cards have been read at least once since access.
    private(set) var hasRead = false
    /// A metric page is on screen, for Clarity's fixed screen name "Apple Health metric" (usage signal).
    var pagesOpen = 0

    @ObservationIgnored let store: any LiveHealthStore
    @ObservationIgnored let now: @Sendable () -> Date
    @ObservationIgnored let calendar: Calendar
    @ObservationIgnored private var reading = false
    @ObservationIgnored private var again = false
    @ObservationIgnored private var unlock: NSObjectProtocol?

    init(store: any LiveHealthStore, now: @escaping @Sendable () -> Date = { .now }, calendar: Calendar = .current) {
        self.store = store
        self.now = now
        self.calendar = calendar
        available = store.isAvailable
        guard available else { return }
        // A locked phone's read keeps what was drawn; the unlock reads again (AC13).
        unlock = NotificationCenter.default.addObserver(forName: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { _ = Task { await self?.refresh() } }
        }
    }

    /// The access card's button (AC5): Apple's sheet for the five types, then the cards.
    func requestAccess() async {
        guard available else { return }
        try? await store.requestAccess()
        await refresh()
    }

    /// Checks whether the sheet is still due, then reads the cards, each time My data shows
    /// (AC2). A refresh asked for during one runs once more after it.
    func refresh() async {
        guard available else { return }
        if reading { again = true; return }
        reading = true
        defer { reading = false }
        repeat {
            again = false
            let due = await store.needsRequest()
            needsAccess = due
            guard !due else { continue }
            do {
                cards = try await Self.readCards(store, now: now(), calendar: calendar)
                hasRead = true
            } catch {
                // Locked: keep what the last read drew (AC13).
            }
        } while again
    }

    /// The cards' readings, off the main thread, each metric on its own: its newest sample
    /// however old, then the 30 days (sleep: the fortnight) ending on that sample's day for
    /// the value and trend. A fixed window back from today lost a VO2 max from six weeks
    /// ago (Codex R2).
    @concurrent
    nonisolated static func readCards(_ store: any LiveHealthStore, now: Date, calendar: Calendar) async throws -> [LiveMetric: LiveCard] {
        async let heart = card(store, .heartRate, now: now, calendar: calendar)
        async let resting = card(store, .restingHeartRate, now: now, calendar: calendar)
        async let sleep = card(store, .sleep, now: now, calendar: calendar)
        async let vo2 = card(store, .vo2Max, now: now, calendar: calendar)
        async let steps = card(store, .steps, now: now, calendar: calendar)
        let read = try await [LiveMetric.heartRate: heart, .restingHeartRate: resting, .sleep: sleep, .vo2Max: vo2, .steps: steps]
        return read.compactMapValues { $0 }
    }

    /// One metric's card, or nil when Health holds none of it.
    private nonisolated static func card(_ store: any LiveHealthStore, _ metric: LiveMetric, now: Date, calendar: Calendar) async throws -> LiveCard? {
        guard let latest = try await optional({ try await store.latest(metric) }) ?? nil else { return nil }
        let newest = min(latest.date, now)
        if metric == .sleep {
            let from = calendar.date(byAdding: .day, value: -15, to: newest) ?? newest
            let segments = try await optional { try await store.sleep(from: from, to: now) } ?? []
            return LiveMaths.card(nights: LiveMaths.nights(segments, calendar: calendar))
        }
        let from = calendar.date(byAdding: .day, value: -29, to: calendar.startOfDay(for: newest)) ?? newest
        let days = try await days(store, metric, from: from, to: now)
        // Heart rate's card is its newest sample; its trend is the days' averages.
        return LiveMaths.card(days: days, latest: metric == .heartRate ? latest : nil)
    }

    /// A metric page's readings (AC7): a year and a bit by day, the last week by hour.
    @concurrent
    nonisolated static func readPage(_ store: any LiveHealthStore, _ metric: LiveMetric, now: Date, calendar: Calendar) async throws -> (days: [LivePoint], hours: [LivePoint]) {
        let yearAgo = calendar.date(byAdding: .day, value: -400, to: calendar.startOfDay(for: now)) ?? now
        let weekAgo = calendar.date(byAdding: .day, value: -7, to: calendar.startOfDay(for: now)) ?? now
        async let days = days(store, metric, from: yearAgo, to: now)
        async let hours = optional { try await store.points(metric, from: weekAgo, to: now, every: .hour) }
        return try await (days, hours ?? [])
    }

    /// Sleep's page (AC9): the nights of the last six months and a bit.
    @concurrent
    nonisolated static func readNights(_ store: any LiveHealthStore, now: Date, calendar: Calendar) async throws -> [SleepNight] {
        let from = calendar.date(byAdding: .day, value: -200, to: now) ?? now
        let segments = try await optional { try await store.sleep(from: from, to: now) } ?? []
        return LiveMaths.nights(segments, calendar: calendar)
    }

    private nonisolated static func days(_ store: any LiveHealthStore, _ metric: LiveMetric, from: Date, to: Date) async throws -> [LivePoint] {
        try await optional { try await store.points(metric, from: from, to: to, every: .day) } ?? []
    }

    /// A read that failed for any reason but a locked phone shows as no data; locked throws.
    private nonisolated static func optional<T: Sendable>(_ read: @Sendable () async throws -> T) async throws -> T? {
        do {
            return try await read()
        } catch LiveHealthError.locked {
            throw LiveHealthError.locked
        } catch {
            return nil
        }
    }
}
