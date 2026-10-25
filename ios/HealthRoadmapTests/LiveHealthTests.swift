import HealthKit
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

    func testNothingIsKept_AC1_AC2() async {
        let before = Set(UserDefaults.standard.dictionaryRepresentation().keys)
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        _ = try? await LiveHealth.readPage(store, .steps, now: now, calendar: utc)
        _ = try? await LiveHealth.readNights(store, now: now, calendar: utc)
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

    func testThePageReadsAYearByDayAndAWeekByHour_AC7() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let page = try await LiveHealth.readPage(store, .heartRate, now: now, calendar: utc)
        XCTAssertFalse(page.days.isEmpty)
        XCTAssertEqual(Set(store.components.map { "\($0)" }), ["day", "hour"])
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
        var components: [Calendar.Component] = []
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
    var components: [Calendar.Component] { with { $0.components } }

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

    func needsRequest() async -> Bool { with { $0.due } }

    func requestAccess() async throws { with { $0.requests += 1; $0.due = false } }

    func points(_ metric: LiveMetric, from start: Date, to end: Date, every component: Calendar.Component) async throws -> [LivePoint] {
        try with { state in
            state.reads += 1
            state.components.append(component)
            if state.locked { throw LiveHealthError.locked }
            return state.empty.contains(metric) ? [] : (state.days[metric] ?? []).filter { $0.start >= start.addingTimeInterval(-86_400) && $0.start <= end }
        }
    }

    func latest(_ metric: LiveMetric) async throws -> (value: Double, date: Date)? {
        try with { state in
            if state.locked { throw LiveHealthError.locked }
            if state.empty.contains(metric) { return nil }
            switch metric {
            case .heartRate: return state.latest.map { (value: $0.0, date: $0.1) }
            case .sleep: return state.segments.map(\.end).max().map { (value: 0, date: $0) }
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
        try with { state in
            if state.locked { throw LiveHealthError.locked }
            return state.empty.contains(.sleep) ? [] : state.segments.filter { $0.end > start && $0.start < end }
        }
    }
}
