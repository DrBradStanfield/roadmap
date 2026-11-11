import HealthKit
import Observation
import UIKit
import XCTest
@testable import HealthRoadmap

/// US-56 on a fake store: the app asks for exactly its five types and draws each one
/// (AC10), in the app's one Health request (AC4), shows the Turn On row until Apple's
/// sheet is done (AC4, AC5), keeps only the cards' last readings, in their own file
/// (AC1, AC2, AC15), keeps the cards through a locked phone (AC13), and shows nothing without
/// Health (AC13).
@MainActor
final class LiveHealthTests: XCTestCase {
    /// My health's two places: Fitness keeps the Turn On / Open Settings row, Sleep does not (US-73).
    private let fitness = HealthTopic.fitness.liveMetrics, sleep = HealthTopic.sleep.liveMetrics
    private let now = Date(timeIntervalSince1970: 1_792_900_000) // 2026-10-25
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = .gmt
        return calendar
    }

    /// Four since 2026-11-05: heart rate is no longer shown (US-73), so it is not read.
    func testItAsksToReadExactlyTheFourTypes_AC10() {
        let expected: Set<HKObjectType> = [
            HKQuantityType(.restingHeartRate), HKCategoryType(.sleepAnalysis),
            HKQuantityType(.vo2Max), HKQuantityType(.stepCount),
        ]
        XCTAssertEqual(LiveHealthKitStore.readTypes, expected, "no HRV, nothing else")
        XCTAssertFalse(LiveHealthKitStore.readTypes.contains(HKQuantityType(.heartRateVariabilitySDNN)))
        XCTAssertFalse(LiveHealthKitStore.readTypes.contains(HKQuantityType(.heartRate)), "no heart rate card, no heart rate read")
    }

    /// AC4 (Brad 2026-10-26): one request for everything. Onboarding's connect asks for the
    /// record's types, sex and date of birth, and the five live types together.
    func testOneRequestAsksForEverything_US54_AC3_AC4() {
        let (share, read) = HealthKitClient.requested
        let record: Set<HKObjectType> = [
            HKCharacteristicType(.biologicalSex), HKCharacteristicType(.dateOfBirth), HKQuantityType(.height), HKQuantityType(.bodyMass),
            HKQuantityType(.waistCircumference), HKQuantityType(.bloodPressureSystolic), HKQuantityType(.bloodPressureDiastolic),
        ]
        XCTAssertEqual(read, record.union(LiveHealthKitStore.readTypes), "the six and the five, nothing else")
        XCTAssertEqual(share, [HKQuantityType(.bodyMass), HKQuantityType(.waistCircumference), HKQuantityType(.bloodPressureSystolic), HKQuantityType(.bloodPressureDiastolic)],
                       "height and the five are never written")
    }

    /// AC4, advisory: only `HealthKitClient` asks HealthKit for access (the DEBUG seed aside).
    /// The guarantee is the type system (`LiveHealthStore` has no request); this scan only
    /// flags a new call early.
    func testOnlyHealthKitClientAsksForAccess_AC4() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "HealthRoadmap")
        guard FileManager.default.fileExists(atPath: app.path(percentEncoded: false)) else {
            throw XCTSkip("The app's sources are not on this device (a real iPhone); the simulator run checks them.")
        }
        let files = FileManager.default.enumerator(at: app, includingPropertiesForKeys: nil)?.compactMap { $0 as? URL }.filter { $0.pathExtension == "swift" } ?? []
        let asking = try files.filter { try String(contentsOf: $0, encoding: .utf8).contains("requestAuthorization(toShare:") }.map(\.lastPathComponent).sorted()
        XCTAssertEqual(asking, ["HealthKitClient.swift", "LiveHealthSeed.swift"])
    }

    /// "Never in the record" rests on this: the record's types and the five live ones never overlap,
    /// so no live reading can be imported into the record or written to Health (AC1, AC10).
    func testTheRecordsTypesAndTheLiveTypesNeverOverlap_AC1_AC10() {
        let record = Set<HKObjectType>(HealthKind.allCases.flatMap(HealthKitClient.quantityTypes))
        XCTAssertTrue(record.isDisjoint(with: LiveHealthKitStore.readTypes))
        XCTAssertTrue(Set<HKObjectType>(HealthKitClient.requested.share).isDisjoint(with: LiveHealthKitStore.readTypes))
    }

    /// AC4, AC5 (2026-10-26): before the five are asked nothing is read. Turn On shows only to
    /// a person who connected Apple Health (before the one-step sheet); otherwise My data's
    /// Apple Health row is the one way in. Its button acts on the known answer, no fresh check.
    func testTurnOnShowsOnlyOnceConnectedUntilTheSheetIsDone_AC4_AC5() async {
        let store = FakeLiveStore(due: true)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(live.access, .needsAccess)
        XCTAssertTrue(live.cards.isEmpty)
        XCTAssertEqual(store.reads, 0, "nothing is read before access")
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: live.access, keepsReconnect: true), .turnOn)
        XCTAssertEqual(LiveShown.shown(fitness, connected: false, access: live.access, keepsReconnect: true), .nothing,
                       "not connected: My data's Apple Health row is the way in")
        let action = await LiveReconnectRow.action(turnOn: true) { XCTFail("no fresh check for Turn On"); return false }
        XCTAssertEqual(action, .connect)
    }

    /// AC4: the one connect reads the cards as soon as the sheet is answered, beside the import.
    func testConnectReadsTheCards_AC4() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Live connect \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let suite = "LiveConnect-\(UUID().uuidString)"
        defer { UserDefaults().removePersistentDomain(forName: suite) }
        let engine = try HealthEngine()
        let record = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let health = FakeHealthStore()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        let sync = AppleHealthSync(store: record, engine: engine, client: health, memory: HealthSyncMemory(defaults: UserDefaults(suiteName: suite)!), live: live)
        // The import waits here until the cards are read (or about 2 s pass): read in sequence,
        // after the import, they never would be.
        var readWhileImporting = false
        health.hold = {
            health.hold = nil
            for _ in 0..<200 where !live.access.isRead { try? await Task.sleep(for: .milliseconds(10)) }
            readWhileImporting = live.access.isRead
        }
        await sync.connect()
        XCTAssertTrue(sync.connected)
        XCTAssertTrue(readWhileImporting, "the cards were read while the import was still pending")
        XCTAssertFalse(live.cards.isEmpty)
    }

    /// US-73 (Brad dropped the heart rate card, round 4): a phone that kept heart rate's history
    /// deletes it at the next launch; the other metrics' files stay.
    func testALaunchDeletesTheKeptHeartRateHistory_US73() async throws {
        let kept = try keptFile()
        let folder = kept.deletingLastPathComponent()
        for name in LiveHistory.dropped + ["history-steps.json"] { try Data("{}".utf8).write(to: folder.appending(path: name)) }
        let live = LiveHealth(store: FakeLiveStore(due: false), now: { [now] in now }, calendar: utc, kept: kept)
        await live.history.forgetDropped()
        let left = try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))
        XCTAssertFalse(left.contains { LiveHistory.dropped.contains($0) }, "heart rate's history is gone")
        XCTAssertTrue(left.contains("history-steps.json"), "the others stay")
    }

    /// AC2 with US-73 (review round 3): "Delete all my data" removes heart rate's kept files too,
    /// one a launch could not delete while the phone was locked.
    func testRemovingEveryHistoryRemovesTheHeartRateFiles_AC2_US73() async throws {
        let folder = try folder()
        for name in LiveHistory.dropped + ["history-steps.json"] { try Data("{}".utf8).write(to: folder.appending(path: name)) }
        await LiveHistory(folder: folder).removeAll()
        let left = try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false))
        XCTAssertEqual(left, [], "no history is left: \(left)")
    }

    /// AC15 with US-73 (review round 2): cards kept before heart rate was dropped still draw in
    /// the first frame, without heart rate, and the file is written again without it.
    func testCardsKeptWithHeartRateStillDrawAndLoseIt_AC15_US73() throws {
        let kept = try keptFile()
        let legacy = #"{"version":1,"cards":{"heartRate":{"value":64,"date":815000000,"trend":[60,64],"inBed":false},"#
            + #""sleep":{"value":27000,"date":815000000,"trend":[26000,27000],"inBed":false},"steps":{"value":9000,"date":815000000,"trend":[8000,9000],"inBed":false}}}"#
        try Data(legacy.utf8).write(to: kept)
        let launch = LiveHealth(store: FakeLiveStore(due: false), now: { [now] in now }, calendar: utc, kept: kept)
        XCTAssertEqual(Set(launch.cards.keys), [.sleep, .steps], "sleep and steps from the file, before any read")
        XCTAssertEqual(launch.cards[.sleep]?.value, 27000)
        XCTAssertEqual(launch.cards[.steps]?.value, 9000)
        XCTAssertEqual(launch.access, .read(launch.cards), "kept cards count as read")
        let rewritten = try String(contentsOf: kept, encoding: .utf8)
        XCTAssertFalse(rewritten.contains("heartRate"), "heart rate's reading is gone from the file")
        XCTAssertTrue(rewritten.contains("steps"), "the others stay")
        XCTAssertEqual(LiveHealth(store: FakeLiveStore(due: false), now: { [now] in now }, calendar: utc, kept: kept).cards, launch.cards)
    }

    func testEveryTypeAskedForIsDrawn_AC10_AC6() async {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(Set(live.cards.keys), Set(LiveMetric.allCases))
        XCTAssertEqual(live.cards[.steps]?.value, 9000)
        XCTAssertEqual(live.cards[.restingHeartRate]?.value, 58, "the newest day")
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

    /// AC14: a metric with fewer than two readings in the last 30 days draws its last seven,
    /// however old, so the card reads back past its 30 days; a dense one draws its 30 days.
    func testASparseMetricsTrendReadsBackForSevenReadings_AC14() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let today = utc.startOfDay(for: now)
        let backs = [380, 350, 300, 250, 200, 150, 100, 45]
        store.set(.vo2Max, days: backs.enumerated().map { LivePoint(start: today.addingTimeInterval(Double(-$1) * 86_400), value: Double(40 + $0)) })
        let night = { (back: Int) in today.addingTimeInterval(Double(-back) * 86_400) }
        store.set(.sleep, segments: [190, 120, 90, 60, 50, 40, 35, 25].map {
            SleepSegment(stage: .core, start: night($0).addingTimeInterval(-3600), end: night($0).addingTimeInterval(6 * 3600), source: "watch")
        })
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(live.cards[.vo2Max]?.value, 47, "the newest, six weeks ago")
        XCTAssertEqual(live.cards[.vo2Max]?.trend, [41, 42, 43, 44, 45, 46, 47], "the last seven, back a year")
        XCTAssertEqual(live.cards[.sleep]?.trend.count, 7, "one night in 30 days: the last seven nights")
        XCTAssertEqual(live.cards[.steps]?.trend.count, 14, "every day of the fortnight, all in the last 30 days")
    }

    /// AC14, adversary R2, Codex R1: two or more readings in the 30 days need nothing older,
    /// so the card reads once; one recent reading still reads back for the last seven.
    func testACardReadsBackOnlyWhenItsTrendNeedsOlderReadings_AC14() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let today = utc.startOfDay(for: now)
        let day = { (back: Int) in today.addingTimeInterval(Double(-back) * 86_400) }
        store.set(.vo2Max, days: [20, 10, 2].enumerated().map { LivePoint(start: day($1), value: Double(40 + $0)) })
        store.set(.sleep, segments: [20, 10, 2].map {
            SleepSegment(stage: .core, start: day($0).addingTimeInterval(-3600), end: day($0).addingTimeInterval(6 * 3600), source: "watch")
        })
        store.set(.steps, days: [300, 250, 200, 150, 100, 60, 45, 3].enumerated().map { LivePoint(start: day($1), value: Double(1000 + $0)) })
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(live.cards[.vo2Max]?.trend, [40, 41, 42])
        XCTAssertEqual(store.calls[.vo2Max], 1, "three readings in 30 days: one read")
        XCTAssertEqual(live.cards[.sleep]?.trend.count, 3)
        XCTAssertEqual(store.calls[.sleep], 1, "three nights in 30 days: one read")
        XCTAssertEqual(live.cards[.steps]?.trend, (1001...1007).map(Double.init), "one recent reading: the last seven")
        XCTAssertEqual(store.calls[.steps], 2, "one recent reading: it reads back")
    }

    /// Codex R2: a read-back that fails keeps the card the first read drew, trend and all.
    func testAFailedReadBackKeepsTheFirstCard_AC14() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let today = utc.startOfDay(for: now)
        let day = { (back: Int) in today.addingTimeInterval(Double(-back) * 86_400) }
        store.set(.restingHeartRate, days: [LivePoint(start: day(90), value: 66), LivePoint(start: day(1), value: 72)])
        store.set(.vo2Max, days: [LivePoint(start: day(90), value: 39), LivePoint(start: day(3), value: 41)])
        store.set(.sleep, segments: [90, 2].map {
            SleepSegment(stage: .core, start: day($0).addingTimeInterval(-3600), end: day($0).addingTimeInterval(6 * 3600), source: "watch")
        })
        store.failFrom = [.restingHeartRate: 2, .vo2Max: 2, .sleep: 2]
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(store.calls[.restingHeartRate], 2, "it tried to read back")
        XCTAssertEqual(live.cards[.restingHeartRate]?.trend, [72], "resting heart rate keeps its first trend")
        XCTAssertEqual(live.cards[.restingHeartRate]?.value, 72)
        XCTAssertEqual(live.cards[.vo2Max]?.trend, [41])
        XCTAssertEqual(live.cards[.sleep]?.trend, [7])
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

    /// AC2 (Brad 2026-10-27): only the cards are kept, in their own file. No UserDefaults
    /// value, and a page's days, hours and nights are never kept.
    func testOnlyTheCardsAreKept_AC1_AC2() async throws {
        let before = Set(UserDefaults.standard.dictionaryRepresentation().keys)
        let kept = try keptFile()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        await live.refresh()
        let file = try Data(contentsOf: kept)
        _ = try? await LiveHealth.readDays(store, .steps, reaching: nil, now: now, calendar: utc)
        _ = try? await LiveHistory(folder: nil).refreshHours(store, .steps, day: now, now: now, calendar: utc)
        _ = try? await LiveHealth.readNights(store, reaching: nil, now: now, calendar: utc)
        XCTAssertEqual(Set(UserDefaults.standard.dictionaryRepresentation().keys), before, "no UserDefaults value")
        XCTAssertEqual(try Data(contentsOf: kept), file, "pages keep nothing")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: kept.deletingLastPathComponent().path(percentEncoded: false)), [kept.lastPathComponent], "one file")
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: file) as? [String: Any])
        XCTAssertEqual(Set(json.keys), ["version", "cards"], "the cards and a version, nothing identifying")
    }

    // MARK: The kept readings (AC2, AC15; Brad 2026-10-27, option A)

    /// A kept-readings file in its own test folder, as AppParts makes it.
    /// A fresh folder for kept histories, removed after the test.
    private func folder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Live history \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        addTeardownBlock { try? FileManager.default.removeItem(at: folder) }
        return folder
    }

    private func keptFile() throws -> URL {
        let base = FileManager.default.temporaryDirectory.appending(path: "Live kept \(UUID().uuidString)")
        addTeardownBlock { try? FileManager.default.removeItem(at: base) }
        return try LiveHealth.keptFile(in: base)
    }

    /// AC15: at launch the cards draw from the kept readings before Health answers, so
    /// nothing is inserted under blood pressure a moment later.
    func testTheKeptCardsDrawBeforeAnyRead_AC15() async throws {
        let kept = try keptFile()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let first = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        await first.refresh()
        let reads = store.reads
        let later = now.addingTimeInterval(3 * 86_400)
        let launch = LiveHealth(store: store, now: { later }, calendar: utc, kept: kept)
        XCTAssertEqual(store.reads, reads, "nothing read yet")
        XCTAssertEqual(launch.cards, first.cards, "the cards are there in the first frame")
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: launch.access, keepsReconnect: true),
                       .cards(fitness), "the cards, never the Turn On or Reconnect row")
        XCTAssertEqual(LiveShown.shown(sleep, connected: true, access: launch.access, keepsReconnect: false),
                       .cards(sleep))
        // The day is worked out when drawn: a card kept three days ago no longer says Today.
        let card = try XCTUnwrap(launch.cards[.steps])
        XCTAssertEqual(DayText.when(card.date, now: now, calendar: utc), "Today")
        XCTAssertNotEqual(DayText.when(card.date, now: launch.now(), calendar: utc), "Today")
        XCTAssertNotEqual(DayText.when(card.date, now: launch.now(), calendar: utc), "Yesterday")
    }

    /// AC2: a read that changes the cards replaces the kept ones.
    func testAReadReplacesTheKeptCards_AC2() async throws {
        let kept = try keptFile()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        await live.refresh()
        XCTAssertNotNil(LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept).cards[.steps])
        store.empty = [.steps]
        await live.refresh()
        let next = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        XCTAssertNil(next.cards[.steps], "the next launch draws the new read")
        XCTAssertEqual(next.cards, live.cards)
    }

    /// AC2: a read with nothing (access turned off in Settings, or an emptied Health) clears
    /// the kept readings, so the next launch draws none.
    func testAnEmptyReadClearsTheKeptCards_AC2() async throws {
        let kept = try keptFile()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        await live.refresh()
        XCTAssertTrue(FileManager.default.fileExists(atPath: kept.path(percentEncoded: false)))
        store.empty = Set(LiveMetric.allCases)
        await live.refresh()
        XCTAssertFalse(FileManager.default.fileExists(atPath: kept.path(percentEncoded: false)))
        XCTAssertTrue(LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept).cards.isEmpty)
    }

    /// AC2, AC13, N1: a locked phone's or a cancelled read changes nothing kept.
    func testALockedOrCancelledReadKeepsTheFile_AC2_AC13() async throws {
        let kept = try keptFile()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        await live.refresh()
        let file = try Data(contentsOf: kept)
        store.empty = Set(LiveMetric.allCases)
        store.locked = true
        await live.refresh()
        XCTAssertEqual(try Data(contentsOf: kept), file, "locked: kept")
        store.locked = false
        store.delay = .seconds(10)
        let refresh = Task { await live.refresh() }
        try await Task.sleep(for: .milliseconds(50))
        refresh.cancel()
        await refresh.value
        XCTAssertEqual(try Data(contentsOf: kept), file, "cancelled: kept")
    }

    /// AC2: access reset (Apple's sheet is due again) clears the kept readings and the cards.
    func testAccessResetClearsTheKeptCards_AC2() async throws {
        let kept = try keptFile()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        await live.refresh()
        store.due = true
        await live.refresh()
        XCTAssertTrue(live.cards.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: kept.path(percentEncoded: false)))
    }

    /// AC2: the file is encrypted until the first unlock (so it reads at launch) and left out
    /// of iCloud and computer backups, apart from the record's folder.
    func testTheKeptFileIsProtectedAndLeftOutOfBackups_AC2() async throws {
        let kept = try keptFile()
        let folder = kept.deletingLastPathComponent()
        XCTAssertEqual(folder.lastPathComponent, "Apple Health")
        XCTAssertNotEqual(folder, try RecordStore.appFolder(in: folder.deletingLastPathComponent()), "not the record's folder")
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        await live.refresh()
        await live.refresh() // a second write replaces the file: the folder's mark holds
        XCTAssertEqual(try folder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
        // Device only: the simulator keeps no protection class (nil, checked 2026-10-27, adversary
        // R8), so there the source scan pins the write's option (testTheLiveCodeKeepsAndSendsNothing_AC1_AC11).
        #if !targetEnvironment(simulator)
        let protection = try FileManager.default.attributesOfItem(atPath: kept.path(percentEncoded: false))[.protectionKey] as? FileProtectionType
        XCTAssertEqual(protection, .completeUntilFirstUserAuthentication)
        #endif
    }

    /// AC2: a damaged, unreadable or older-version file is no cache: no card, no row, no crash.
    func testADamagedOrOldKeptFileIsIgnored_AC2() async throws {
        let kept = try keptFile()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        await LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept).refresh()
        // Version 0 with real, non-empty cards (adversary R7): only the version makes it no cache.
        var old = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: kept)) as? [String: Any])
        XCTAssertFalse((old["cards"] as? [String: Any] ?? [:]).isEmpty)
        old["version"] = 0
        let version0 = try XCTUnwrap(String(data: JSONSerialization.data(withJSONObject: old), encoding: .utf8))
        for text in ["not json", version0, #"{"version":1,"cards":{"pulse":{}}}"#] {
            try Data(text.utf8).write(to: kept)
            let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
            XCTAssertTrue(live.cards.isEmpty, text)
            XCTAssertEqual(live.access, .unknown, text)
        }
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        await live.refresh()
        XCTAssertFalse(LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept).cards.isEmpty, "the next read replaces it")
    }

    /// AC2, Codex R1, adversary R4: a read under way when "Delete all my data" runs lands
    /// nowhere: no file, no cards, and a refresh asked for during it is dropped too.
    func testAReadBegunBeforeForgetKeepsNothing_AC2() async throws {
        let kept = try keptFile()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        store.delay = .milliseconds(300)
        let refresh = Task { await live.refresh() }
        try await Task.sleep(for: .milliseconds(50))
        await live.refresh(force: true) // queued as `again`
        await live.forget()
        await refresh.value
        XCTAssertTrue(live.cards.isEmpty, "no cards")
        XCTAssertEqual(live.access, .granted, "not read since the erase")
        XCTAssertFalse(FileManager.default.fileExists(atPath: kept.path(percentEncoded: false)), "no file")
        store.delay = nil
        await live.refresh()
        XCTAssertFalse(live.cards.isEmpty, "a refresh begun after it reads as usual")
    }

    /// AC2, adversary R3: an empty read deletes a file the launch did not load (here written
    /// after launch, as one the locked phone could not read would be).
    func testAnEmptyReadDeletesAFileItDidNotLoad_AC2() async throws {
        let kept = try keptFile()
        let store = FakeLiveStore(due: false)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        XCTAssertTrue(live.cards.isEmpty)
        try Data("kept earlier".utf8).write(to: kept)
        await live.refresh()
        XCTAssertTrue(live.cards.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: kept.path(percentEncoded: false)))
    }

    /// AC2 (US-25 AC16): "Delete all my data" deletes the kept readings and empties the cards.
    func testForgetDeletesTheKeptCards_AC2() async throws {
        let kept = try keptFile()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        await live.refresh()
        await live.forget()
        XCTAssertTrue(live.cards.isEmpty)
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: live.access, keepsReconnect: true), .nothing,
                       "no Reconnect row until the next read")
        XCTAssertFalse(FileManager.default.fileExists(atPath: kept.path(percentEncoded: false)))
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
        XCTAssertFalse(live.available)
        XCTAssertEqual(live.access, .unknown)
    }

    /// AC7, adversary R6: the page reads 400 days by day, and D one day by hour.
    func testThePageReads400DaysByDayAndOneDayByHour_AC7_R6() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let today = utc.startOfDay(for: now)
        let days = try await LiveHealth.readDays(store, .restingHeartRate, reaching: nil, now: now, calendar: utc)
        XCTAssertFalse(days.isEmpty)
        XCTAssertEqual(store.queries.last?.start, today.addingTimeInterval(-400 * 86_400), "400 days back")
        XCTAssertEqual(store.queries.last?.end, now)
        XCTAssertEqual(store.queries.last?.component, .day)
        let yesterday = today.addingTimeInterval(-86_400 + 3600)
        _ = try await LiveHistory(folder: nil).refreshHours(store, .restingHeartRate, day: yesterday, now: now, calendar: utc)
        XCTAssertEqual(store.queries.last?.start, today.addingTimeInterval(-86_400), "the day D shows")
        XCTAssertEqual(store.queries.last?.end, today)
        XCTAssertEqual(store.queries.last?.component, .hour)
        _ = try await LiveHistory(folder: nil).refreshHours(store, .restingHeartRate, day: now, now: now, calendar: utc)
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

    /// AC7a (Brad 2026-11-03: "We should be importing everything from Apple Health"): the
    /// history reads every day from the oldest sample, as Weight's page scrolls back to its first
    /// reading; a first visit draws 400 days (sleep 200 nights) meanwhile. VO2 max and a night
    /// from three years ago both come back.
    func testTheHistoryReadsEverythingFromTheOldestSample_AC7a() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let today = utc.startOfDay(for: now)
        let old = today.addingTimeInterval(-3 * 365 * 86_400)
        let recent = today.addingTimeInterval(-10 * 86_400)
        store.set(.vo2Max, days: [LivePoint(start: old, value: 38.0), LivePoint(start: recent, value: 41.2)])
        let first = try await LiveHealth.readDays(store, .vo2Max, reaching: recent, now: now, calendar: utc)
        XCTAssertEqual(first.map(\.start), [recent], "a first visit draws the last 400 days")
        let history = LiveHistory(folder: try folder())
        let all = try await history.refreshDays(store, .vo2Max, now: now, calendar: utc)
        XCTAssertEqual(all.map(\.start), [old, recent], "then every reading, back to the oldest")
        XCTAssertEqual(store.queries.last?.start, old, "one read by day from the oldest sample's day")
        XCTAssertEqual(store.queries.last?.component, .day)
        store.set(.sleep, segments: [
            SleepSegment(stage: .core, start: old.addingTimeInterval(-3600), end: old.addingTimeInterval(6 * 3600), source: "watch"),
            SleepSegment(stage: .core, start: today.addingTimeInterval(-3600), end: today.addingTimeInterval(6 * 3600), source: "watch"),
        ])
        let lastNight = try await LiveHealth.readNights(store, reaching: today, now: now, calendar: utc)
        XCTAssertEqual(lastNight.map(\.day), [today], "sleep's first visit draws last night without the whole history")
        XCTAssertEqual(store.earliestCalls, 1, "only the history read asks for the oldest sample; neither first-visit read waits on it")
        let nights = try await history.refreshNights(store, now: now, calendar: utc)
        XCTAssertEqual(nights.map(\.day), [old, today], "then every night")
    }

    /// AC7a, adversary R7: the page draws its kept days before HealthKit is asked anything, after
    /// a relaunch too; with none kept it draws 400 days read now.
    func testAPageDrawsFromTheKeptHistoryBeforeAnyRead_AC7a() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let kept = try keptFile()
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        let days = try await live.history.refreshDays(store, .restingHeartRate, now: now, calendar: utc)
        let nights = try await live.history.refreshNights(store, now: now, calendar: utc)
        let reads = (store.reads, store.calls[.sleep] ?? 0)
        let drawn = await live.firstDays(.restingHeartRate, reaching: nil)
        XCTAssertEqual(drawn, days)
        let relaunched = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        let drawnAgain = await relaunched.firstDays(.restingHeartRate, reaching: nil)
        let keptNights = await relaunched.history.keptNights(calendar: utc)
        XCTAssertEqual(drawnAgain, days, "after a relaunch, from the file")
        XCTAssertEqual(keptNights, nights)
        XCTAssertFalse(days.isEmpty)
        XCTAssertEqual(store.reads, reads.0, "no HealthKit read")
        XCTAssertEqual(store.calls[.sleep] ?? 0, reads.1)
        let fresh = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: try keptFile())
        _ = await fresh.firstDays(.restingHeartRate, reaching: nil)
        XCTAssertEqual(store.queries.last?.start, utc.startOfDay(for: now).addingTimeInterval(-400 * 86_400), "nothing kept: 400 days read now")
    }

    /// AC7a, adversary R2: a later read asks HealthKit only what changed. A late sync re-reads
    /// just its day; a sample deleted in Health is gone from the kept days (read in full again,
    /// since HealthKit does not say which day it was on) and from the kept sleep (by id).
    func testALaterReadAsksOnlyForWhatChanged_AC7a() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let history = LiveHistory(folder: try folder())
        let full = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        let unchanged = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        XCTAssertEqual(unchanged, full)
        let synced = full[full.count - 3]
        var steps = full
        steps[full.count - 3] = LivePoint(start: synced.start, value: 12_000)
        store.set(.steps, days: steps)
        let reads = store.reads
        let late = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        XCTAssertEqual(store.reads, reads + 1)
        XCTAssertEqual(store.queries.last?.start, synced.start, "only the late-synced day")
        XCTAssertEqual(late, steps, "merged, nothing lost or doubled")
        store.set(.steps, days: Array(steps.dropFirst()))
        let afterDelete = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        XCTAssertEqual(afterDelete, Array(steps.dropFirst()), "deleted in Health, gone from the app")
        let today = utc.startOfDay(for: now)
        let nights = (0..<10).map { today.addingTimeInterval(Double(-$0) * 86_400) }.reversed()
        let segments = nights.map { SleepSegment(stage: .core, start: $0.addingTimeInterval(-3600), end: $0.addingTimeInterval(6 * 3600), source: "watch") }
        store.set(.sleep, segments: segments)
        let first = try await history.refreshNights(store, now: now, calendar: utc)
        XCTAssertEqual(first.count, 10)
        store.set(.sleep, segments: Array(segments.dropFirst()))
        let second = try await history.refreshNights(store, now: now, calendar: utc)
        XCTAssertEqual(second.map(\.day), Array(first.dropFirst()).map(\.day), "a night deleted in Health is gone")
        store.set(.sleep, segments: segments)
        let third = try await history.refreshNights(store, now: now, calendar: utc)
        XCTAssertEqual(third.map(\.day), first.map(\.day), "added back once, never twice")
    }

    /// AC7a, adversary R7: a sample added later with an old date (an import) is read in, and the
    /// kept span reaches back to it.
    func testAnOlderSampleAddedLaterIsReadIn_AC7a() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let history = LiveHistory(folder: try folder())
        let full = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        let old = LivePoint(start: utc.startOfDay(for: now).addingTimeInterval(-100 * 86_400), value: 5000)
        store.set(.steps, days: [old] + full)
        let again = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        XCTAssertEqual(again, [old] + full)
        XCTAssertEqual(store.queries.last?.start, old.start)
    }

    /// AC7a: HealthKit's change list past its limit reads everything again.
    func testALongChangeListReadsEverythingAgain_AC7a() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let history = LiveHistory(folder: try folder())
        let full = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        store.changeLimit = 0
        store.set(.steps, days: full.map { LivePoint(start: $0.start, value: 1) })
        let again = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        XCTAssertEqual(store.queries.last?.start, full.first?.start, "a full read")
        XCTAssertEqual(again.map(\.value), full.map { _ in 1 })
    }

    /// AC7a, adversary R4: days kept in one time zone are read in full again in another, so a
    /// westward move shifts no day and counts none twice.
    func testANewTimeZoneReadsTheDaysAgain_R4() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let history = LiveHistory(folder: try folder())
        _ = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        _ = try await history.refreshHours(store, .steps, day: now, now: now, calendar: utc)
        var west = Calendar(identifier: .gregorian)
        west.timeZone = try XCTUnwrap(TimeZone(identifier: "America/Los_Angeles"))
        let reads = store.reads
        let days = try await history.refreshDays(store, .steps, now: now, calendar: west)
        XCTAssertEqual(store.reads, reads + 1)
        let earliest = try XCTUnwrap(days.first?.start)
        XCTAssertEqual(store.queries.last?.start, west.startOfDay(for: earliest), "read in full from the oldest day, in the new zone")
        XCTAssertEqual(Set(days.map(\.start)).count, days.count, "no day counted twice")
        let hours = await history.keptHours(.steps, calendar: west)
        XCTAssertNil(hours, "hours kept in another zone are not drawn")
    }

    /// AC7a: a locked phone keeps the history; Health holding none of a metric removes its file.
    func testALockedReadKeepsTheHistoryAndAnEmptyHealthRemovesIt_AC7a() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let folder = try folder()
        let history = LiveHistory(folder: folder)
        let days = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        _ = try await history.refreshNights(store, now: now, calendar: utc)
        store.locked = true
        do {
            _ = try await history.refreshDays(store, .steps, now: now, calendar: utc)
            XCTFail("a locked read throws")
        } catch {}
        store.locked = false
        let keptAfterFailure = await LiveHistory(folder: folder).keptDays(.steps)
        XCTAssertEqual(keptAfterFailure, days, "kept through a locked read")
        store.set(.steps, days: [])
        store.set(.sleep, segments: [])
        let empty = try await history.refreshDays(store, .steps, now: now, calendar: utc)
        let noNights = try await history.refreshNights(store, now: now, calendar: utc)
        XCTAssertTrue(empty.isEmpty && noNights.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appending(path: "history-steps.json").path(percentEncoded: false)))
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appending(path: "history-sleep.json").path(percentEncoded: false)))
    }

    /// AC2, adversary R7: a read under way when the histories are removed keeps nothing.
    func testAReadUnderWayDuringRemovalKeepsNothing_AC2() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let folder = try folder()
        let history = LiveHistory(folder: folder)
        store.delay = .milliseconds(300)
        let read = Task { try await history.refreshDays(store, .steps, now: now, calendar: utc) }
        try await Task.sleep(for: .milliseconds(100))
        await history.removeAll()
        _ = try? await read.value
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appending(path: "history-steps.json").path(percentEncoded: false)))
        let kept = await history.keptDays(.steps)
        XCTAssertNil(kept)
    }

    /// AC7a: D's hours draw from the kept last week, after a relaunch too; each day read replaces
    /// that day's kept hours, and a day further back than a week is read but never kept.
    func testDsHoursAreKeptForAWeek_AC7a() async throws {
        let store = FakeLiveStore(due: false)
        let today = utc.startOfDay(for: now)
        let hourly = (0..<10 * 24).map { LivePoint(start: today.addingTimeInterval(Double(-$0) * 3600), value: 70) }
        store.set(.restingHeartRate, days: hourly)
        let folder = try folder()
        let history = LiveHistory(folder: folder)
        let old = today.addingTimeInterval(-9 * 86_400)
        let oldHours = try await history.refreshHours(store, .restingHeartRate, day: old, now: now, calendar: utc)
        XCTAssertFalse(oldHours.isEmpty, "a day scrolled back to is read and shown")
        let todays = try await history.refreshHours(store, .restingHeartRate, day: now, now: now, calendar: utc)
        XCTAssertEqual(store.queries.last?.component, .hour)
        let kept = await LiveHistory(folder: folder).keptHours(.restingHeartRate, calendar: utc)
        XCTAssertEqual(kept, todays, "today's hours kept, the day nine days back not")
        let again = try await history.refreshHours(store, .restingHeartRate, day: now, now: now, calendar: utc)
        let keptAgain = await history.keptHours(.restingHeartRate, calendar: utc)
        XCTAssertEqual(keptAgain, again, "a day read again replaces its hours, never doubles them")
    }

    /// AC7a, adversary R3: a date before HealthKit existed (an importer's artifact) is read from
    /// 1 January 2014, not from 1970.
    func testTheOldestDateIsClampedTo2014_AC7a() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        store.set(.vo2Max, days: [LivePoint(start: Date(timeIntervalSince1970: 0), value: 30), LivePoint(start: utc.startOfDay(for: now), value: 41)])
        _ = try await LiveHistory(folder: nil).refreshDays(store, .vo2Max, now: now, calendar: utc)
        let floor = try XCTUnwrap(utc.date(from: DateComponents(year: 2014, month: 1, day: 1)))
        XCTAssertEqual(store.queries.last?.start, floor)
    }

    /// AC2, AC7a: "Delete all my data", an access reset and an empty Health each remove every
    /// kept history; every write ran off the main thread.
    func testDeleteAllAccessResetAndAnEmptyHealthRemoveTheHistories_AC2_AC7a() async throws {
        let kept = try keptFile()
        let folder = kept.deletingLastPathComponent()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        func histories() throws -> [String] {
            try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false)).filter { $0.hasPrefix("history-") || $0.hasPrefix("hours-") }.sorted()
        }
        func fill() async throws {
            for metric in LiveMetric.allCases where metric != .sleep {
                _ = try await live.history.refreshDays(store, metric, now: now, calendar: utc)
                _ = try await live.history.refreshHours(store, metric, day: now, now: now, calendar: utc)
            }
            _ = try await live.history.refreshNights(store, now: now, calendar: utc)
        }
        try await fill()
        XCTAssertEqual(try histories(), ["history-restingHeartRate.json", "history-sleep.json", "history-steps.json", "history-vo2Max.json",
                                         "hours-restingHeartRate.json", "hours-steps.json", "hours-vo2Max.json"])
        let (writes, onMain) = (await live.history.writes, await live.history.writesOnMain)
        XCTAssertGreaterThan(writes, 0)
        XCTAssertEqual(onMain, 0, "every write ran off the main thread")
        await live.forget()
        XCTAssertEqual(try histories(), [], "Delete all my data")
        try await fill()
        store.due = true
        await live.refresh()
        XCTAssertEqual(try histories(), [], "access reset")
        store.due = false
        try await fill()
        store.empty = Set(LiveMetric.allCases)
        await live.refresh()
        XCTAssertEqual(try histories(), [], "Health gave nothing back")
    }

    /// Adversary R3: Health holding none of one metric (its access off in Settings) removes that
    /// metric's history and hours, and only that one's.
    func testOneMetricGoneFromHealthRemovesOnlyItsHistory_R3() async throws {
        let kept = try keptFile()
        let folder = kept.deletingLastPathComponent()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        _ = try await live.history.refreshNights(store, now: now, calendar: utc)
        _ = try await live.history.refreshDays(store, .steps, now: now, calendar: utc)
        _ = try await live.history.refreshHours(store, .steps, day: now, now: now, calendar: utc)
        store.empty = [.sleep]
        await live.refresh()
        let exists = { (name: String) in FileManager.default.fileExists(atPath: folder.appending(path: name).path(percentEncoded: false)) }
        XCTAssertFalse(exists("history-sleep.json"), "sleep's access off: its history goes")
        XCTAssertTrue(exists("history-steps.json"))
        XCTAssertTrue(exists("hours-steps.json"))
        store.empty = [.steps]
        await live.refresh()
        XCTAssertFalse(exists("history-steps.json"))
        XCTAssertFalse(exists("hours-steps.json"), "and its hours")
    }

    /// Codex R1: a failed hourly read throws, so the kept hours (and the page's drawn ones) stay.
    func testAFailedHourlyReadKeepsTheKeptHours_CodexR1() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let folder = try folder()
        let history = LiveHistory(folder: folder)
        let todays = try await history.refreshHours(store, .restingHeartRate, day: now, now: now, calendar: utc)
        XCTAssertFalse(todays.isEmpty)
        store.failFrom = [.restingHeartRate: (store.calls[.restingHeartRate] ?? 0) + 1]
        do {
            _ = try await history.refreshHours(store, .restingHeartRate, day: now, now: now, calendar: utc)
            XCTFail("a failed hourly read throws, never an empty day")
        } catch {}
        let kept = await LiveHistory(folder: folder).keptHours(.restingHeartRate, calendar: utc)
        XCTAssertEqual(kept, todays, "the kept hours stay")
    }

    /// Codex R2: a metric revoked while its page is open bumps that metric's removal count, which
    /// is in the page's read key, so the page clears what it drew and drops a read begun before;
    /// that read keeps nothing on disk either.
    func testARevokedMetricClearsItsOpenPage_CodexR2() async throws {
        let kept = try keptFile()
        let folder = kept.deletingLastPathComponent()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        _ = try await live.history.refreshNights(store, now: now, calendar: utc)
        let before = LiveMetricPage.Wanted(wakes: live.wakes, removals: live.removals[.sleep] ?? 0, range: .week, days: [])
        store.set(.sleep, segments: [])
        store.empty = [.sleep]
        store.delay = .milliseconds(200)
        let open = Task { try await live.history.refreshNights(store, now: now, calendar: utc) }
        try await Task.sleep(for: .milliseconds(50))
        store.delay = nil
        await live.refresh()
        _ = try? await open.value
        XCTAssertEqual(live.removals[.sleep], 1)
        XCTAssertNil(live.removals[.steps], "only the revoked metric")
        XCTAssertNotEqual(LiveMetricPage.Wanted(wakes: live.wakes, removals: live.removals[.sleep] ?? 0, range: .week, days: []), before, "the open page reads again")
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appending(path: "history-sleep.json").path(percentEncoded: false)))
        let reread = try await live.history.refreshNights(store, now: now, calendar: utc)
        XCTAssertTrue(reread.isEmpty, "and its read again draws nothing")
    }

    /// Adversary R10: card reads that all fail remove no history; only Health's answer of no data does.
    func testFailedCardReadsKeepTheHistories_R10() async throws {
        let kept = try keptFile()
        let folder = kept.deletingLastPathComponent()
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc, kept: kept)
        _ = try await live.history.refreshDays(store, .steps, now: now, calendar: utc)
        _ = try await live.history.refreshNights(store, now: now, calendar: utc)
        store.latestFails = true
        await live.refresh()
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appending(path: "history-steps.json").path(percentEncoded: false)))
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appending(path: "history-sleep.json").path(percentEncoded: false)))
    }

    /// Adversary R2: W, M, 6M and Y share one read; only D reads otherwise, so moving between
    /// them never cancels and restarts the history read.
    func testARangeSwitchKeepsTheReadUnderWay_R2() {
        let ranges: [LiveRange] = [.week, .month, .sixMonths, .year]
        for range in ranges {
            XCTAssertEqual(LiveMetricPage.Wanted(wakes: 1, range: range, days: []), LiveMetricPage.Wanted(wakes: 1, range: .week, days: []))
        }
        XCTAssertNotEqual(LiveMetricPage.Wanted(wakes: 1, range: .day, days: []), LiveMetricPage.Wanted(wakes: 1, range: .week, days: []))
    }

    /// Adversary R3: the y-axis spans the points in view, so years of history do not flatten
    /// this year's range; all of them when none is in view.
    func testTheYAxisSpansThePointsInView_R3() {
        let today = utc.startOfDay(for: now)
        let old = LivePoint(start: today.addingTimeInterval(-3 * 365 * 86_400), value: 20_000)
        let recent = LivePoint(start: today.addingTimeInterval(-86_400), value: 8_000)
        let geometry = LiveChartGeometry(range: .week, now: now, calendar: utc, first: old.start)
        XCTAssertEqual(LiveMetricPage.scaled([old, recent], geometry: geometry, from: geometry.windowStart), [recent])
        XCTAssertEqual(LiveMetricPage.scaled([old], geometry: geometry, from: geometry.windowStart), [old], "none in view: all")
    }

    /// Adversary R4: a status check that throws keeps what was known; the Turn On row does not flash.
    func testAStatusCheckThatThrowsKeepsTheCards_R4() async {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        let drawn = live.cards
        XCTAssertEqual(live.access, .read(drawn))
        store.statusFails = true
        await live.refresh()
        XCTAssertEqual(live.access, .read(drawn), "no Turn On row")
        XCTAssertFalse(live.cards.isEmpty, "the cards stay")
        let fresh = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await fresh.refresh()
        XCTAssertEqual(fresh.access, .unknown, "unknown stays unknown: no Turn On row")
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
        withObservationTracking { _ = live.access } onChange: { changed.fire() }
        await live.refresh()
        XCTAssertFalse(changed.fired, "no write, no redraw")
    }

    /// AC5b (Brad 2026-10-25): what each place shows. Before access, the Turn On row in Vitals;
    /// with readings, the cards; after "Don't Allow" (iOS answers a refusal with no data), one
    /// calm Reconnect row in Vitals, never an error or a greyed "no data" line; nothing while unknown.
    func testWhatEachPlaceShows_AC5b() {
        let card = LiveCard(value: 60, date: now, trend: [])
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .needsAccess, keepsReconnect: true), .turnOn)
        XCTAssertEqual(LiveShown.shown(sleep, connected: true, access: .needsAccess, keepsReconnect: false), .nothing, "the Turn On row is said once, in Fitness")
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .unknown, keepsReconnect: true), .nothing, "unknown: nothing flashes")
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .granted, keepsReconnect: true), .nothing, "not read yet")
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .read([:]), keepsReconnect: true), .reconnect, "declined or empty: Reconnect")
        XCTAssertEqual(LiveShown.shown(sleep, connected: true, access: .read([:]), keepsReconnect: false), .nothing)
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .read([.sleep: card, .steps: card]), keepsReconnect: true), .cards([.steps]))
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .read([.sleep: card]), keepsReconnect: true), .nothing,
                       "only a sleep card: Fitness shows nothing, so its heading hides (US-73 AC2)")
        XCTAssertEqual(LiveShown.shown(sleep, connected: true, access: .read([.steps: card]), keepsReconnect: false), .nothing)
        XCTAssertEqual(LiveShown.shown(sleep, connected: true, access: .read([.sleep: card, .steps: card]), keepsReconnect: false), .cards([.sleep]))
    }

    /// AC5b: Reconnect asks again while Apple's sheet would still show; once it has been
    /// answered, iOS will not show it again, so the button opens Settings instead.
    func testReconnectAsksAgainOrOpensSettings_AC5b() async {
        let due = await LiveReconnectRow.action(turnOn: false) { true }
        XCTAssertEqual(due, .connect, "the sheet again")
        let answered = await LiveReconnectRow.action(turnOn: false) { false }
        XCTAssertEqual(answered, .settings, "answered: Settings")
        let unknown = await LiveReconnectRow.action(turnOn: false) { throw HKError(.errorDatabaseInaccessible) }
        XCTAssertEqual(unknown, .settings, "iOS cannot say: Settings")
    }

    /// AC5c (Brad 2026-11-01): iOS asks only once, so after the sheet the button opens
    /// Settings. It says "Open Settings", not "Reconnect". The path to Apple Health's settings
    /// depends on the iOS version: iOS 18 moved Health under Settings › Apps, and the app runs
    /// from iOS 17. The row on screen is checked by
    /// `OnboardingUITests.testAfterDontAllowTheRowSaysOpenSettings_US56_AC5c`.
    func testTheRowSaysOpenSettingsWithThePathForThisIOS_AC5c() {
        XCTAssertEqual(LiveReconnectRow.title(turnOn: false), "Open Settings")
        XCTAssertEqual(LiveReconnectRow.title(turnOn: true), "Turn On", "before the sheet, Turn On is unchanged")
        XCTAssertEqual(LiveFooter.healthPath(appsMenu: true), "Settings › Apps › Health › Data Access & Devices › Health Roadmap", "iOS 18 and later")
        XCTAssertEqual(LiveFooter.healthPath(appsMenu: false), "Settings › Health › Data Access & Devices › Health Roadmap", "iOS 17")
        let here: String
        if #available(iOS 18, *) { here = LiveFooter.healthPath(appsMenu: true) } else { here = LiveFooter.healthPath(appsMenu: false) }
        XCTAssertTrue(LiveFooter.healthSettings.hasSuffix(" \(here)."), "the path for the iOS this runs on")
        XCTAssertTrue(LiveFooter.access.hasSuffix(" \(here)."), "AC4's footer names the same path")
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
        XCTAssertEqual(fresh.access, .granted, "nothing was read")
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: fresh.access, keepsReconnect: true), .nothing,
                       "no Reconnect row from a cancelled read")
    }

    /// AC5d (iPhone survey S4): after an access reset and a re-allow, a first read that fails
    /// (the phone locked) shows no row. Before the fix the read flag outlived the reset, so the
    /// empty cards drew the Open Settings row as if the person had tapped Don't Allow.
    func testAFailedFirstReadAfterAnAccessResetShowsNoRow_US56_AC5d() async {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        await live.refresh()
        XCTAssertEqual(LiveShown.shown(fitness, keepsReconnect: true, live: live, health: nil), .cards(fitness))
        store.due = true
        await live.refresh()
        XCTAssertTrue(live.cards.isEmpty, "the reset clears the cards")
        store.due = false
        store.locked = true
        await live.refresh()
        XCTAssertNotEqual(LiveShown.shown(fitness, keepsReconnect: true, live: live, health: nil), .reconnect, "no Open Settings row from a failed read")
        XCTAssertEqual(LiveShown.shown(fitness, keepsReconnect: true, live: live, health: nil), .nothing)
        store.locked = false
        await live.refresh()
        XCTAssertEqual(LiveShown.shown(fitness, keepsReconnect: true, live: live, health: nil), .cards(fitness), "the next good read draws the cards")
    }

    /// N2: the sheet's answer always reads again, even within 2 s of a running read.
    func testTheSheetsAnswerAlwaysReadsAgain_N2() async throws {
        let store = FakeLiveStore(due: false)
        store.fill(now: now)
        store.delay = .milliseconds(300)
        let live = LiveHealth(store: store, now: { [now] in now }, calendar: utc)
        let running = Task { await live.refresh() }
        try await Task.sleep(for: .milliseconds(50))
        await live.refresh(force: true)
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
        let before = try await LiveHistory(folder: nil).refreshHours(store, .steps, day: now, now: now, calendar: utc)
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
        XCTAssertEqual(LiveHealthKitStore.unit(.restingHeartRate), HKUnit.count().unitDivided(by: .minute()))
        XCTAssertEqual(LiveHealthKitStore.unit(.restingHeartRate), HKUnit(from: "count/min"))
        XCTAssertEqual(LiveHealthKitStore.unit(.vo2Max), HKUnit(from: "ml/kg*min"))
        XCTAssertEqual(LiveHealthKitStore.unit(.steps), .count())
    }

    /// AC1, AC2, AC11: the new code holds no defaults, record, engine, log or telemetry call.
    /// Only LiveHealth.swift touches a file, its kept readings' (Brad 2026-10-27), in a folder
    /// made the record's way, and LiveHistory.swift the pages' histories beside it (AC7a, Brad
    /// 2026-11-03). Nothing outside them but My data's wiring names them.
    func testTheLiveCodeKeepsAndSendsNothing_AC1_AC11() throws {
        let app = URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().appending(path: "HealthRoadmap")
        guard FileManager.default.fileExists(atPath: app.path(percentEncoded: false)) else {
            throw XCTSkip("The app's sources are not on this device (a real iPhone); the simulator run checks them.")
        }
        let live = try FileManager.default.contentsOfDirectory(at: app.appending(path: "AppleHealthMetrics"), includingPropertiesForKeys: nil)
            .filter { $0.pathExtension == "swift" }
        XCTAssertEqual(live.count, 9, "LiveHistory.swift is the eighth (US-56 AC7a), LiveAccess.swift the ninth (AC5d)")
        for file in live {
            // Code only: comments may name what is not done.
            let text = try String(contentsOf: file, encoding: .utf8).split(separator: "\n")
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
            // The file calls, pinned exactly (adversary R9): each one protected atomic write and
            // one removal; LiveHealth.swift's of the kept file, with the record's folder helper.
            let allowed = [
                "LiveHealth.swift": ["try? data.write(to: kept, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])",
                                     "try? FileManager.default.removeItem(at: kept)",
                                     "RecordStore.appFolder(in: base, named: \"Apple Health\")"],
                "LiveHistory.swift": ["try? data.write(to: folder.appending(path: name), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])",
                                      "try? FileManager.default.removeItem(at: folder.appending(path: name))"],
            ][file.lastPathComponent] ?? []
            for call in allowed { XCTAssertEqual(text.components(separatedBy: call).count - 1, 1, call) }
            let code = allowed.reduce(text) { $0.replacingOccurrences(of: $1, with: "") }
            for banned in ["UserDefaults", "FileManager", "write(to", "RecordStore", "HealthEngine", "print(", "Logger", "os_log", "NSLog", "SentrySDK", "ClaritySDK", "save("] {
                XCTAssertFalse(code.contains(banned), "\(file.lastPathComponent) uses \(banned)")
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
extension LiveAccess {
    /// A read has landed since access (tests only).
    var isRead: Bool { if case .read = self { true } else { false } }
}

final class FakeLiveStore: LiveHealthStore, @unchecked Sendable {
    private let lock = NSLock()
    private var state = State()
    private struct State {
        var due: Bool
        var available = true
        var locked = false
        var empty: Set<LiveMetric> = []
        var reads = 0
        var statusFails = false
        var delay: Duration?
        var latestCalls = 0
        var queries: [(start: Date, end: Date, component: Calendar.Component)] = []
        var days: [LiveMetric: [LivePoint]] = [:]
        var segments: [SleepSegment] = []
        var calls: [LiveMetric: Int] = [:]
        var failFrom: [LiveMetric: Int] = [:]
        var earliestFails = false
        var earliestCalls = 0
        var latestFails = false
        /// Each version of the data, so `changes` can say what changed since an anchor.
        var version = 0
        var versions: [Int: (days: [LiveMetric: [LivePoint]], segments: [SleepSegment])] = [0: ([:], [])]
        var changeLimit = Int.max
        init(due: Bool = true) { self.due = due }
    }

    init(due: Bool) { state = State(due: due) }

    private func with<T>(_ body: (inout State) throws -> T) rethrows -> T { lock.lock(); defer { lock.unlock() }; return try body(&state) }

    var due: Bool { get { with { $0.due } } set { with { $0.due = newValue } } }
    var available: Bool { get { with { $0.available } } set { with { $0.available = newValue } } }
    var locked: Bool { get { with { $0.locked } } set { with { $0.locked = newValue } } }
    var empty: Set<LiveMetric> { get { with { $0.empty } } set { with { $0.empty = newValue } } }
    var reads: Int { with { $0.reads } }
    var statusFails: Bool { get { with { $0.statusFails } } set { with { $0.statusFails = newValue } } }
    /// Each read waits this long, cancellably, as a slow HealthKit query would.
    var delay: Duration? { get { with { $0.delay } } set { with { $0.delay = newValue } } }
    var latestCalls: Int { with { $0.latestCalls } }
    /// Each metric's points or sleep reads so far.
    var calls: [LiveMetric: Int] { with { $0.calls } }
    /// A metric's reads from this call on (1 is the first) fail, as HealthKit's other errors do.
    var failFrom: [LiveMetric: Int] { get { with { $0.failFrom } } set { with { $0.failFrom = newValue } } }

    private func count(_ metric: LiveMetric, _ state: inout State) throws {
        state.calls[metric, default: 0] += 1
        if let from = state.failFrom[metric], state.calls[metric]! >= from { throw HKError(.errorDatabaseInaccessible) }
    }

    private func wait() async throws {
        if let delay { try await Task.sleep(for: delay) }
    }
    var queries: [(start: Date, end: Date, component: Calendar.Component)] { with { $0.queries } }
    /// `earliest` throws, as HealthKit's other errors do.
    var earliestFails: Bool { get { with { $0.earliestFails } } set { with { $0.earliestFails = newValue } } }
    var earliestCalls: Int { with { $0.earliestCalls } }
    /// Every `latest` read fails, as HealthKit's other errors do (not a locked phone).
    var latestFails: Bool { get { with { $0.latestFails } } set { with { $0.latestFails = newValue } } }
    /// More changes than this since an anchor reports `more`, as HealthKit's limit does.
    var changeLimit: Int { get { with { $0.changeLimit } } set { with { $0.changeLimit = newValue } } }

    private static func record(_ state: inout State) {
        state.version += 1
        state.versions[state.version] = (state.days, state.segments)
    }

    func fill(now: Date) {
        let today = Date(timeIntervalSince1970: (now.timeIntervalSince1970 / 86_400).rounded(.down) * 86_400)
        let days = (0..<14).map { today.addingTimeInterval(Double($0 - 13) * 86_400) }
        with { state in
            state.days[.steps] = days.enumerated().map { LivePoint(start: $1, value: Double(8000 + ($0 == 13 ? 1000 : 0))) }
            state.days[.restingHeartRate] = days.map { LivePoint(start: $0, value: 58) }
            state.days[.vo2Max] = [LivePoint(start: days[10], value: 41.2)]
            state.segments = [SleepSegment(stage: .core, start: today.addingTimeInterval(-3600), end: today.addingTimeInterval(6 * 3600), source: "watch")]
            Self.record(&state)
        }
    }

    var isAvailable: Bool { available }

    func needsRequest() async throws -> Bool {
        try with { state in
            if state.statusFails { throw HKError(.errorDatabaseInaccessible) }
            return state.due
        }
    }


    func points(_ metric: LiveMetric, from start: Date, to end: Date, every component: Calendar.Component) async throws -> [LivePoint] {
        try await wait()
        return try with { state in
            state.reads += 1
            state.queries.append((start, end, component))
            if state.locked { throw HealthStoreError.locked }
            try count(metric, &state)
            return state.empty.contains(metric) ? [] : (state.days[metric] ?? []).filter { $0.start >= start.addingTimeInterval(-86_400) && $0.start <= end }
        }
    }

    func latest(_ metric: LiveMetric) async throws -> (value: Double?, date: Date)? {
        with { $0.latestCalls += 1 }
        try await wait()
        return try with { state in
            if state.locked { throw HealthStoreError.locked }
            if state.latestFails { throw HKError(.errorHealthDataUnavailable) }
            if state.empty.contains(metric) { return nil }
            switch metric {
            case .sleep: return state.segments.map(\.end).max().map { (value: nil, date: $0) }
            default: return state.days[metric]?.filter { $0.value != nil }.max { $0.start < $1.start }.map { (value: $0.value!, date: $0.start.addingTimeInterval(43_200)) }
            }
        }
    }

    func earliest(_ metric: LiveMetric) async throws -> Date? {
        try await wait()
        return try with { state in
            state.earliestCalls += 1
            if state.locked { throw HealthStoreError.locked }
            if state.earliestFails { throw HKError(.errorHealthDataUnavailable) }
            if state.empty.contains(metric) { return nil }
            return metric == .sleep ? state.segments.map(\.start).min() : state.days[metric]?.map(\.start).min()
        }
    }

    /// Replaces one metric's days, or sleep's segments.
    func set(_ metric: LiveMetric, days: [LivePoint] = [], segments: [SleepSegment] = []) {
        with { state in
            if metric == .sleep { state.segments = segments } else { state.days[metric] = days }
            Self.record(&state)
        }
    }

    func changes(_ metric: LiveMetric, after anchor: Data?, from start: Date?) async throws -> LiveChanges {
        try await wait()
        return try with { state in
            if state.locked { throw HealthStoreError.locked }
            func id(_ segment: SleepSegment) -> String { segment.uuid ?? "sleep-\(segment.start.timeIntervalSince1970)-\(segment.stage.rawValue)" }
            func tagged(_ segment: SleepSegment) -> SleepSegment { var segment = segment; segment.uuid = id(segment); return segment }
            let days = state.empty.contains(metric) ? [] : state.days[metric] ?? []
            let segments = state.empty.contains(.sleep) ? [] : state.segments
            var changes = LiveChanges()
            changes.anchor = Data(String(state.version).utf8)
            if let anchor, let version = Int(String(decoding: anchor, as: UTF8.self)), let old = state.versions[version] {
                if metric == .sleep {
                    let (before, after) = (Set(old.segments.map(id)), Set(segments.map(id)))
                    changes.deleted = before.subtracting(after).sorted()
                    changes.segments = segments.filter { !before.contains(id($0)) }.map(tagged)
                    changes.added = changes.segments.map(\.start)
                } else {
                    let before = old.days[metric] ?? []
                    changes.deleted = before.filter { point in !days.contains { $0.start == point.start } }.map { "\(metric.rawValue)-\($0.start.timeIntervalSince1970)" }
                    changes.added = days.filter { !before.contains($0) }.map(\.start)
                }
            } else if metric == .sleep {
                changes.segments = segments.filter { start == nil || $0.start >= start! }.map(tagged)
                changes.added = changes.segments.map(\.start)
            } else {
                changes.added = days.filter { start == nil || $0.start >= start! }.map(\.start)
            }
            changes.more = changes.added.count + changes.deleted.count > state.changeLimit
            return changes
        }
    }

    func sleep(from start: Date, to end: Date) async throws -> [SleepSegment] {
        try await wait()
        return try with { state in
            if state.locked { throw HealthStoreError.locked }
            try count(.sleep, &state)
            return state.empty.contains(.sleep) ? [] : state.segments.filter { $0.end > start && $0.start < end }
        }
    }
}
