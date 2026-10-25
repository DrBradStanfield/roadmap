import HealthKit
import Observation
import UIKit
import XCTest
@testable import HealthRoadmap

/// US-56 on a fake store: the app asks for exactly its five types and draws each one
/// (AC10), shows the access card until Apple's sheet is done (AC4, AC5), keeps nothing
/// (AC1, AC2), keeps the cards through a locked phone (AC13), and shows nothing without
/// Health (AC13).
@MainActor
final class LiveHealthTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_792_900_000) // 2026-10-25
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }

    func testItAsksToReadExactlyTheFiveTypes_AC10() {
        let expected: Set<HKObjectType> = [
            HKQuantityType(.heartRate), HKQuantityType(.restingHeartRate), HKCategoryType(.sleepAnalysis),
            HKQuantityType(.vo2Max), HKQuantityType(.stepCount),
        ]
        XCTAssertEqual(LiveHealthKitStore.readTypes, expected, "no HRV, nothing else")
        XCTAssertFalse(LiveHealthKitStore.readTypes.contains(HKQuantityType(.heartRateVariabilitySDNN)))
    }

    func testTheAccessCardShowsUntilTheSheetIsDone_AC4() async {
        let store = FakeLiveStore(due: true)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(live.needsAccess, true)
        XCTAssertTrue(live.cards.isEmpty)
        XCTAssertEqual(store.reads, 0, "nothing is read before access")
        await live.requestAccess()
        XCTAssertEqual(store.requests, 1, "the card's button runs the request")
        XCTAssertEqual(live.needsAccess, false)
        XCTAssertTrue(live.hasRead)
    }

    func testEveryTypeAskedForIsDrawn_AC10_AC6() async {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(Set(live.cards.keys), Set(LiveMetric.allCases))
        XCTAssertEqual(live.cards[.steps]?.value, 9000)
        XCTAssertEqual(live.cards[.heartRate]?.value, 64, "the newest sample")
        XCTAssertEqual(live.cards[.sleep]?.value, 7 * 3600)
    }

    func testAMetricWithNoDataIsLeftOut_AC6() async {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        store.empty = [.vo2Max, .sleep]
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertNil(live.cards[.vo2Max])
        XCTAssertNil(live.cards[.sleep])
        XCTAssertNotNil(live.cards[.steps])
    }

    /// Codex R2: a card starts from the metric's newest reading, however old; it is not
    /// lost because it falls outside the trend's 30 days or sleep's fortnight.
    func testAnOldReadingStillGetsItsCard_R2() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let day = 86_400.0
        let today = utc.startOfDay(for: now)
        store.set(.vo2Max, days: [LivePoint(start: today.addingTimeInterval(-45 * day), value: 41.2)])
        store.set(.steps, days: [LivePoint(start: today.addingTimeInterval(-90 * day), value: 4321)])
        store.set(.restingHeartRate, days: [LivePoint(start: today.addingTimeInterval(-200 * day), value: 61),
                                            LivePoint(start: today.addingTimeInterval(-201 * day), value: 63)])
        let night = today.addingTimeInterval(-20 * day)
        store.set(.sleep, segments: [SleepSegment(stage: .core, start: night.addingTimeInterval(-3600), end: night.addingTimeInterval(6 * 3600), source: "watch")])
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(live.cards[.vo2Max]?.value, 41.2, "a VO2 max from six weeks ago")
        XCTAssertEqual(live.cards[.vo2Max]?.date, today.addingTimeInterval(-45 * day))
        XCTAssertEqual(live.cards[.steps]?.value, 4321, "steps from three months ago")
        XCTAssertEqual(live.cards[.restingHeartRate]?.value, 61)
        XCTAssertEqual(live.cards[.restingHeartRate]?.trend, [63, 61], "its trend ends on it")
        XCTAssertEqual(live.cards[.sleep]?.value, 7 * 3600, "a night from 20 days ago")
        XCTAssertEqual(live.cards[.sleep]?.date, night)
    }

    /// Adversary R3: a nap after 6 pm today is dated tomorrow; the card keeps last night.
    func testAFutureDatedNightIsLeftOutOfTheCard_R3() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let today = utc.startOfDay(for: now)
        let evening = today.addingTimeInterval(21 * 3600)
        store.set(.sleep, segments: [
            SleepSegment(stage: .core, start: today.addingTimeInterval(-3600), end: today.addingTimeInterval(6 * 3600), source: "watch"),
            SleepSegment(stage: .asleep, start: today.addingTimeInterval(18.5 * 3600), end: today.addingTimeInterval(19.5 * 3600), source: "watch"),
        ])
        let live = LiveHealth(store: store, now: { evening }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(live.cards[.sleep]?.date, today, "last night, not tomorrow's nap")
        XCTAssertEqual(live.cards[.sleep]?.value, 7 * 3600)
    }

    func testNothingIsKept_AC1_AC2() async {
        let before = Set(UserDefaults.standard.dictionaryRepresentation().keys)
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        _ = try? await LiveHealth.readDays(store, .steps, reaching: nil, now: now, calendar: utc)
        _ = try? await LiveHealth.readHours(store, .steps, day: now, now: now, calendar: utc)
        _ = try? await LiveHealth.readNights(store, reaching: nil, now: now, calendar: utc)
        XCTAssertEqual(Set(UserDefaults.standard.dictionaryRepresentation().keys), before, "no UserDefaults value")
    }

    func testALockedPhoneKeepsWhatWasDrawn_AC13() async {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        let drawn = live.cards
        store.locked = true
        await live.refresh()
        XCTAssertEqual(live.cards, drawn)
        store.locked = false
        store.empty = [.steps]
        await live.refresh()
        XCTAssertNil(live.cards[.steps], "read again once unlocked")
    }

    func testWithoutHealthNothingShows_AC13() async {
        let store = FakeLiveStore(due: true)
        store.available = false
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        await live.requestAccess()
        XCTAssertFalse(live.available)
        XCTAssertNil(live.needsAccess)
        XCTAssertEqual(store.requests, 0)
    }

    /// AC7, adversary R6: the page reads 400 days by day, and D one day by hour.
    func testThePageReads400DaysByDayAndOneDayByHour_AC7_R6() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let today = utc.startOfDay(for: now)
        let days = try await LiveHealth.readDays(store, .heartRate, reaching: nil, now: now, calendar: utc)
        XCTAssertFalse(days.isEmpty)
        XCTAssertEqual(store.queries.last?.start, today.addingTimeInterval(-400 * 86_400), "400 days back")
        XCTAssertEqual(store.queries.last?.end, now)
        XCTAssertEqual(store.queries.last?.component, .day)
        let yesterday = today.addingTimeInterval(-86_400 + 3600)
        _ = try await LiveHealth.readHours(store, .heartRate, day: yesterday, now: now, calendar: utc)
        XCTAssertEqual(store.queries.last?.start, today.addingTimeInterval(-86_400), "the day D shows")
        XCTAssertEqual(store.queries.last?.end, today)
        XCTAssertEqual(store.queries.last?.component, .hour)
        _ = try await LiveHealth.readHours(store, .heartRate, day: now, now: now, calendar: utc)
        XCTAssertEqual(store.queries.last?.end, now, "today, as it stands")
        _ = try await LiveHealth.readNights(store, reaching: nil, now: now, calendar: utc)
    }

    /// Codex R2, adversary R7: a card's reading older than the page's 400 days still shows on
    /// its page: the page reads back to it, and opens with it in view.
    func testAnOldReadingShowsOnItsPage_R2_R7() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let today = utc.startOfDay(for: now)
        let old = today.addingTimeInterval(-500 * 86_400)
        store.set(.vo2Max, days: [LivePoint(start: old, value: 39.5)])
        let night = today.addingTimeInterval(-300 * 86_400)
        store.set(.sleep, segments: [SleepSegment(stage: .core, start: night.addingTimeInterval(-3600), end: night.addingTimeInterval(6 * 3600), source: "watch")])
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        let card = try XCTUnwrap(live.cards[.vo2Max])
        XCTAssertEqual(card.date, old)
        let days = try await LiveHealth.readDays(store, .vo2Max, reaching: card.date, now: now, calendar: utc)
        XCTAssertEqual(days.map(\.value), [39.5], "the page holds the card's reading")
        for range in LiveRange.allCases where range != .day {
            let geometry = LiveChartGeometry(range: range, now: now, calendar: utc, first: days.first?.start)
            let points = LiveMaths.bucket(days, by: range.bucket, calendar: utc)
            XCTAssertFalse(geometry.inView(points, by: \.start, from: geometry.opening(showing: card.date)).isEmpty, "\(range.rawValue) opens on it")
        }
        let sleep = try XCTUnwrap(live.cards[.sleep])
        let nights = try await LiveHealth.readNights(store, reaching: sleep.date, now: now, calendar: utc)
        XCTAssertEqual(nights.map(\.day), [night], "the sleep page holds the card's night")
        XCTAssertEqual(LiveMaths.newestNight(nights, today: today)?.day, night, "and D opens on it")
    }

    /// Adversary R4: a status check that throws keeps what was known; the access card does not flash.
    func testAStatusCheckThatThrowsKeepsTheCards_R4() async {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(live.needsAccess, false)
        store.statusFails = true
        await live.refresh()
        XCTAssertEqual(live.needsAccess, false, "no access card")
        XCTAssertFalse(live.cards.isEmpty, "the cards stay")
        let fresh = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await fresh.refresh()
        XCTAssertNil(fresh.needsAccess, "unknown stays unknown: no access card")
    }

    /// Adversary R2: one calendar, following the phone's zone, for LiveHealth and the store's anchor.
    func testTheCalendarFollowsTheTimeZone_R2() {
        let live = LiveHealth(store: FakeLiveStore(due: false))
        let store = LiveHealthKitStore()
        XCTAssertEqual(live.calendar, .autoupdatingCurrent)
        XCTAssertEqual(store.calendar, .autoupdatingCurrent)
        let before = NSTimeZone.default
        defer { NSTimeZone.default = before }
        NSTimeZone.default = TimeZone(identifier: "America/Santiago")!
        XCTAssertEqual(live.calendar.timeZone.identifier, "America/Santiago", "travel moves the days")
        XCTAssertEqual(store.calendar.timeZone.identifier, "America/Santiago")
    }

    /// Codex R1, E1: a return to the app or an unlock wakes an open page to read again; two
    /// within about 2 s are one wake. A locked page read throws, so the page keeps what it shows.
    func testAWakeReadsAgainAndCollapsesRepeats_R1_E1() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        XCTAssertEqual(live.wakes, 0)
        NotificationCenter.default.post(name: UIApplication.protectedDataDidBecomeAvailableNotification, object: nil)
        for _ in 0..<100 where live.wakes == 0 { await Task.yield() }
        XCTAssertEqual(live.wakes, 1, "an unlock wakes the page")
        live.wake()
        XCTAssertEqual(live.wakes, 1, "a return straight after is the same wake")
        store.locked = true
        do {
            _ = try await LiveHealth.readDays(store, .steps, reaching: nil, now: now, calendar: utc)
            XCTFail("a locked read throws, so the page keeps what it shows")
        } catch HealthStoreError.locked {}
    }

    /// E5: a refresh that reads the same values writes nothing, so nothing redraws.
    func testAnUnchangedRefreshWritesNothing_E5() async {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        let changed = Changed()
        withObservationTracking { _ = (live.cards, live.needsAccess, live.hasRead) } onChange: { changed.fire() }
        await live.refresh()
        XCTAssertFalse(changed.fired, "no write, no redraw")
    }

    /// AC5b (Brad 2026-10-25): what each place shows. Before access, the access card in Vitals;
    /// with readings, the cards; after "Don't Allow" (iOS answers a refusal with no data), one
    /// calm Reconnect row in Vitals, never an error or a greyed "no data" line; nothing while unknown.
    func testWhatEachPlaceShows_AC5b() {
        let card = LiveCard(value: 60, date: now, trend: [])
        XCTAssertEqual(LiveCardsSection.shown(LiveMetric.vitals, needsAccess: true, hasRead: false, cards: [:]), .access)
        XCTAssertEqual(LiveCardsSection.shown(LiveMetric.fitness, needsAccess: true, hasRead: false, cards: [:]), .nothing, "the access card is said once, in Vitals")
        XCTAssertEqual(LiveCardsSection.shown(LiveMetric.vitals, needsAccess: nil, hasRead: false, cards: [:]), .nothing, "unknown: nothing flashes")
        XCTAssertEqual(LiveCardsSection.shown(LiveMetric.vitals, needsAccess: false, hasRead: false, cards: [:]), .nothing, "not read yet")
        XCTAssertEqual(LiveCardsSection.shown(LiveMetric.vitals, needsAccess: false, hasRead: true, cards: [:]), .reconnect, "declined or empty: Reconnect")
        XCTAssertEqual(LiveCardsSection.shown(LiveMetric.fitness, needsAccess: false, hasRead: true, cards: [:]), .nothing)
        XCTAssertEqual(LiveCardsSection.shown(LiveMetric.vitals, needsAccess: false, hasRead: true, cards: [.sleep: card, .steps: card]), .cards([.sleep]))
        XCTAssertEqual(LiveCardsSection.shown(LiveMetric.vitals, needsAccess: false, hasRead: true, cards: [.steps: card]), .cards([]), "Fitness carries the readings and the footer")
        XCTAssertEqual(LiveCardsSection.shown(LiveMetric.fitness, needsAccess: false, hasRead: true, cards: [.steps: card]), .cards([.steps]))
    }

    /// AC5b: Reconnect asks again while Apple's sheet would still show; once it has been
    /// answered, iOS will not show it again, so the button opens Settings instead.
    func testReconnectAsksAgainOrOpensSettings_AC5b() async {
        let store = FakeLiveStore(due: true)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        let asked = await live.reconnect()
        XCTAssertEqual(asked, .asked)
        XCTAssertEqual(store.requests, 1, "the sheet again")
        let settings = await live.reconnect()
        XCTAssertEqual(settings, .settings, "answered: Settings")
        XCTAssertEqual(store.requests, 1, "no second request")
    }

    /// N1: a page read cancelled mid-flight throws, so the page never keeps it as "read,
    /// empty"; the next read reads again.
    func testACancelledPageReadIsNotKeptAsEmpty_N1() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        store.delay = .seconds(10)
        let read = Task { [now, utc] in try await LiveHealth.readDays(store, .steps, reaching: nil, now: now, calendar: utc) }
        try await Task.sleep(for: .milliseconds(50))
        read.cancel()
        do {
            _ = try await read.value
            XCTFail("a cancelled read must not come back as an empty one")
        } catch is CancellationError {}
        store.delay = nil
        let again = try await LiveHealth.readDays(store, .steps, reaching: nil, now: now, calendar: utc)
        XCTAssertFalse(again.isEmpty, "the next task reads again")
    }

    /// N1: a refresh cancelled mid-flight keeps the cards and never shows the Reconnect row.
    func testACancelledRefreshKeepsTheCards_N1() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        let drawn = live.cards
        store.delay = .seconds(10)
        let refresh = Task { await live.refresh() }
        try await Task.sleep(for: .milliseconds(50))
        refresh.cancel()
        await refresh.value
        XCTAssertEqual(live.cards, drawn, "the cards stay")
        let fresh = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        let first = Task { await fresh.refresh() }
        try await Task.sleep(for: .milliseconds(50))
        first.cancel()
        await first.value
        XCTAssertFalse(fresh.hasRead, "nothing was read")
        XCTAssertEqual(LiveCardsSection.shown(LiveMetric.vitals, needsAccess: fresh.needsAccess, hasRead: fresh.hasRead, cards: fresh.cards), .nothing,
                       "no Reconnect row from a cancelled read")
    }

    /// N2: the sheet's answer always reads again, even within 2 s of a running read.
    func testTheSheetsAnswerAlwaysReadsAgain_N2() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        store.delay = .milliseconds(300)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        let running = Task { await live.refresh() }
        try await Task.sleep(for: .milliseconds(50))
        await live.requestAccess()
        store.delay = nil
        await running.value
        XCTAssertEqual(store.latestCalls, 2 * LiveMetric.allCases.count, "two reads, not one")
    }

    /// N2: a wake whose read found the phone locked does not swallow the unlock's wake.
    func testALockedWakeDoesNotCollapseTheUnlock_N2() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        store.locked = true
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        live.wake()
        XCTAssertEqual(live.wakes, 1)
        try await Task.sleep(for: .milliseconds(200))
        store.locked = false
        live.wake()
        XCTAssertEqual(live.wakes, 2, "the unlock reads again")
    }

    /// N5: a new day (or a new time zone) wakes the cards and pages, so "Today" moves.
    func testANewDayWakesTheCards_N5() async {
        let live = LiveHealth(store: FakeLiveStore(due: false), now: { [now] in now }, calendar: utc)
        NotificationCenter.default.post(name: .NSCalendarDayChanged, object: nil)
        for _ in 0..<100 where live.wakes == 0 { await Task.yield() }
        XCTAssertEqual(live.wakes, 1)
    }

    /// Codex R2 (2026-10-26): a nap after 6 pm today is dated tomorrow; with the last real
    /// night 20 days back, past the fortnight window, the card still shows that night.
    func testAnEveningNapAfterAGapKeepsTheOlderNightsCard_R2() async {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let today = utc.startOfDay(for: now)
        let night = today.addingTimeInterval(-20 * 86_400)
        store.set(.sleep, segments: [
            SleepSegment(stage: .core, start: night.addingTimeInterval(-3600), end: night.addingTimeInterval(6 * 3600), source: "watch"),
            SleepSegment(stage: .asleep, start: today.addingTimeInterval(18.5 * 3600), end: today.addingTimeInterval(19.5 * 3600), source: "watch"),
        ])
        let live = LiveHealth(store: store, now: { today.addingTimeInterval(21 * 3600) }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(live.cards[.sleep]?.date, night, "the night 20 days back, not nothing")
        XCTAssertEqual(live.cards[.sleep]?.value, 7 * 3600)
    }

    /// Codex R1 (2026-10-26): a page shown again (back through the tab bar) is a new read, so a
    /// retained page reads Health again and shows what changed while it was hidden (AC2).
    func testARevisitedPageReadsAgain_R1() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let first = ReadFor(wakes: 0, shows: 1)
        let before = try await LiveHealth.readHours(store, .steps, day: now, now: now, calendar: utc)
        let today = utc.startOfDay(for: now)
        store.set(.steps, days: [LivePoint(start: today, value: 12_345)])
        let again = ReadFor(wakes: 0, shows: 2)
        XCTAssertNotEqual(again, first, "the second showing is a new read, though no wake came")
        let after = try await LiveHealth.readDays(store, .steps, reaching: nil, now: now, calendar: utc)
        XCTAssertNotEqual(before.map(\.value), after.map(\.value))
        XCTAssertEqual(after.last?.value, 12_345, "the new total shows")
    }

    /// Adversary R6: HealthKit's sleep values map to Apple's stages, and each metric reads in its unit.
    func testTheStageMappingAndUnitTable_R6() {
        XCTAssertEqual(LiveHealthKitStore.stage(HKCategoryValueSleepAnalysis.inBed.rawValue), .inBed)
        XCTAssertEqual(LiveHealthKitStore.stage(HKCategoryValueSleepAnalysis.awake.rawValue), .awake)
        XCTAssertEqual(LiveHealthKitStore.stage(HKCategoryValueSleepAnalysis.asleepREM.rawValue), .rem)
        XCTAssertEqual(LiveHealthKitStore.stage(HKCategoryValueSleepAnalysis.asleepCore.rawValue), .core)
        XCTAssertEqual(LiveHealthKitStore.stage(HKCategoryValueSleepAnalysis.asleepDeep.rawValue), .deep)
        XCTAssertEqual(LiveHealthKitStore.stage(HKCategoryValueSleepAnalysis.asleepUnspecified.rawValue), .asleep)
        XCTAssertNil(LiveHealthKitStore.stage(99), "an unknown value is left out")
        XCTAssertEqual(LiveHealthKitStore.unit(.heartRate), HKUnit.count().unitDivided(by: .minute()))
        XCTAssertEqual(LiveHealthKitStore.unit(.restingHeartRate), HKUnit(from: "count/min"))
        XCTAssertEqual(LiveHealthKitStore.unit(.vo2Max), HKUnit(from: "ml/kg*min"))
        XCTAssertEqual(LiveHealthKitStore.unit(.steps), .count())
    }

    /// AC1, AC2, AC11: the new code holds no file, defaults, record, engine, log or telemetry
    /// call, and nothing outside it but My data's wiring names it.
    func testTheLiveCodeKeepsAndSendsNothing_AC1_AC11() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "HealthRoadmap")
        guard FileManager.default.fileExists(atPath: app.path(percentEncoded: false)) else {
            throw XCTSkip("The app's sources are not on this device (a real iPhone); the simulator run checks them.")
        }
        let live = try FileManager.default.contentsOfDirectory(at: app.appending(path: "AppleHealthMetrics"), includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        XCTAssertEqual(live.count, 6)
        for file in live {
            // Code only: comments may name what is not done.
            let text = try String(contentsOf: file, encoding: .utf8).split(separator: "\n")
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
            for banned in ["UserDefaults", "FileManager", "write(to", "RecordStore", "HealthEngine", "print(", "Logger", "os_log", "NSLog", "SentrySDK", "ClaritySDK", "save("] {
                XCTAssertFalse(text.contains(banned), "\(file.lastPathComponent) uses \(banned)")
            }
        }
        let engine = try FileManager.default.contentsOfDirectory(at: app.appending(path: "Engine"), includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        for file in engine {
            XCTAssertFalse(try String(contentsOf: file, encoding: .utf8).contains("LiveHealth"), "the engine never reads them: \(file.lastPathComponent)")
        }
    }
}

/// Records whether an observation fired.
private final class Changed: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var fired: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func fire() { lock.lock(); value = true; lock.unlock() }
}

/// A HealthKit stand-in with a fortnight of each metric.
private final class FakeLiveStore: LiveHealthStore, @unchecked Sendable {
    private let lock = NSLock()
    private var state = State()
    private struct State {
        var due: Bool
        var available = true
        var locked = false
        var empty: Set<LiveMetric> = []
        var requests = 0
        var reads = 0
        var statusFails = false
        var delay: Duration?
        var latestCalls = 0
        var queries: [(start: Date, end: Date, component: Calendar.Component)] = []
        var days: [LiveMetric: [LivePoint]] = [:]
        var latest: (Double, Date)?
        var segments: [SleepSegment] = []
        init(due: Bool = true) { self.due = due }
    }

    init(due: Bool) { state = State(due: due) }

    private func with<T>(_ body: (inout State) throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body(&state) }

    var available: Bool { get { with { $0.available } } set { with { $0.available = newValue } } }
    var locked: Bool { get { with { $0.locked } } set { with { $0.locked = newValue } } }
    var empty: Set<LiveMetric> { get { with { $0.empty } } set { with { $0.empty = newValue } } }
    var requests: Int { with { $0.requests } }
    var reads: Int { with { $0.reads } }
    var statusFails: Bool { get { with { $0.statusFails } } set { with { $0.statusFails = newValue } } }
    /// Each read waits this long, cancellably, as a slow HealthKit query would.
    var delay: Duration? { get { with { $0.delay } } set { with { $0.delay = newValue } } }
    var latestCalls: Int { with { $0.latestCalls } }

    private func wait() async throws {
        if let delay { try await Task.sleep(for: delay) }
    }
    var queries: [(start: Date, end: Date, component: Calendar.Component)] { with { $0.queries } }

    func fill(now: Date) {
        let today = Date(timeIntervalSince1970: (now.timeIntervalSince1970 / 86_400).rounded(.down) * 86_400)
        let days = (0..<14).map { today.addingTimeInterval(Double($0 - 13) * 86_400) }
        with { state in
            state.days[.steps] = days.enumerated().map { LivePoint(start: $1, value: Double(8000 + ($0 == 13 ? 1000 : 0))) }
            state.days[.heartRate] = days.map { LivePoint(start: $0, value: 70, low: 50, high: 140) }
            state.days[.restingHeartRate] = days.map { LivePoint(start: $0, value: 58) }
            state.days[.vo2Max] = [LivePoint(start: days[10], value: 41.2)]
            state.latest = (64, now.addingTimeInterval(-600))
            state.segments = [SleepSegment(stage: .core, start: today.addingTimeInterval(-3600), end: today.addingTimeInterval(6 * 3600), source: "watch")]
        }
    }

    var isAvailable: Bool { available }

    func needsRequest() async throws -> Bool {
        try with { state in
            if state.statusFails { throw HKError(.errorDatabaseInaccessible) }
            return state.due
        }
    }

    func requestAccess() async throws { with { $0.requests += 1; $0.due = false } }

    func points(_ metric: LiveMetric, from start: Date, to end: Date, every component: Calendar.Component) async throws -> [LivePoint] {
        try await wait()
        return try with { state in
            state.reads += 1
            state.queries.append((start, end, component))
            if state.locked { throw HealthStoreError.locked }
            return state.empty.contains(metric) ? [] : (state.days[metric] ?? []).filter { $0.start >= start.addingTimeInterval(-86_400) && $0.start <= end }
        }
    }

    func latest(_ metric: LiveMetric) async throws -> (value: Double?, date: Date)? {
        with { $0.latestCalls += 1 }
        try await wait()
        return try with { state in
            if state.locked { throw HealthStoreError.locked }
            if state.empty.contains(metric) { return nil }
            switch metric {
            case .heartRate: return state.latest.map { (value: $0.0, date: $0.1) }
            case .sleep: return state.segments.map(\.end).max().map { (value: nil, date: $0) }
            default: return state.days[metric]?.filter { $0.value != nil }.max { $0.start < $1.start }.map { (value: $0.value!, date: $0.start.addingTimeInterval(43_200)) }
            }
        }
    }

    /// Replaces one metric's days, or sleep's segments.
    func set(_ metric: LiveMetric, days: [LivePoint] = [], segments: [SleepSegment] = []) {
        with { state in
            if metric == .sleep { state.segments = segments } else { state.days[metric] = days }
        }
    }

    func sleep(from start: Date, to end: Date) async throws -> [SleepSegment] {
        try await wait()
        return try with { state in
            if state.locked { throw HealthStoreError.locked }
            return state.empty.contains(.sleep) ? [] : state.segments.filter { $0.end > start && $0.start < end }
        }
    }
}
