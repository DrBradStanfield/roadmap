import UserNotifications
import XCTest
@testable import HealthRoadmap

/// US-25 AC12: the phone's reminders. The engine says what is due and when
/// (ios/engine/reminders.ts); these tests pin what the app does with it: only
/// after opt-in and permission, at most 64 pending, rebuilt from scratch with
/// stable ids, generic words on the lock screen, and nothing left after an erase.
@MainActor
final class ReminderSchedulerTests: XCTestCase {
    private var center: FakeNotificationCenter!
    private var folder: URL!
    private var engineOutput: PhoneReminders!
    private var engineFails = false
    /// What the scheduler passed the engine as kept first-seen days, call by call.
    private var sentFirstSeen: [[String: String]] = []

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    override func setUp() async throws {
        center = FakeNotificationCenter()
        folder = FileManager.default.temporaryDirectory.appending(path: "Reminders \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        engineOutput = reminders(epoch: 0, days: ["2027-01-15", "2027-03-01"])
        engineFails = false
        sentFirstSeen = []
    }

    private func scheduler() -> ReminderScheduler {
        ReminderScheduler(center: center, folder: folder) { [unowned self] firstSeen in
            sentFirstSeen.append(firstSeen)
            if engineFails { throw HealthEngine.EngineError.callFailed("unreadable") }
            return engineOutput
        }
    }

    private func reminders(epoch: Int, days: [String]) -> PhoneReminders {
        PhoneReminders(
            eraseEpoch: epoch,
            upcoming: [.init(category: "blood_test_lipids", group: "blood_test", label: "Lipid panel blood test", dueAt: days.first ?? "2027-01-15", overdue: false, dueText: "Jan 2027")],
            notifications: days.map { .init(id: "reminder.\($0)", fireDay: $0, categories: ["blood_test_lipids"]) }
        )
    }

    func testNothingIsScheduledBeforeTheUserOptsIn() async {
        let scheduler = scheduler()
        await scheduler.refresh()
        XCTAssertFalse(scheduler.optedIn)
        XCTAssertEqual(center.pending.map(\.identifier), [])
        XCTAssertEqual(scheduler.reminders?.upcoming.count, 1, "the list shows even with reminders off")
    }

    func testOptingInAsksPermissionThenSchedulesTheEnginesDaysWithStableIds() async {
        let scheduler = scheduler()
        let on = await scheduler.optIn()
        XCTAssertTrue(on)
        XCTAssertEqual(center.permissionAsks, 1)
        XCTAssertEqual(center.pending.map(\.identifier), ["reminder.2027-01-15", "reminder.2027-03-01"])
        // A refill gives the same ids, so nothing doubles.
        await scheduler.refresh()
        XCTAssertEqual(center.pending.count, 2)
    }

    func testARefusedPermissionLeavesRemindersOff() async {
        center.grants = false
        let scheduler = scheduler()
        let on = await scheduler.optIn()
        XCTAssertFalse(on)
        XCTAssertFalse(scheduler.optedIn)
        XCTAssertEqual(center.pending.count, 0)
    }

    func testPermissionTurnedOffInSettingsSchedulesNothing() async {
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        center.status = .denied
        await scheduler.refresh()
        XCTAssertTrue(scheduler.optedIn)
        XCTAssertEqual(scheduler.permission, .denied)
        XCTAssertEqual(center.pending.count, 0)
    }

    func testNoMoreThan64ArePending() async {
        // 100 days, 2027-01-01 onward, 28 to a month so every day is real.
        let days: [String] = (0..<100).map { index in
            let month = index / 28 + 1, day = index % 28 + 1
            return String(format: "2027-%02d-%02d", month, day)
        }
        engineOutput = reminders(epoch: 0, days: days)
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        XCTAssertEqual(center.pending.count, 64)
        XCTAssertEqual(center.pending.map(\.identifier), engineOutput.notifications.prefix(64).map(\.id), "the soonest 64, in order")
    }

    func testARefillReplacesOurRemindersFromScratchAndLeavesOthersAlone() async {
        center.pending = [request("reminder.2026-12-01"), request("someone-else")]
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        engineOutput = reminders(epoch: 0, days: ["2027-06-01"])
        await scheduler.refresh()
        XCTAssertEqual(Set(center.pending.map(\.identifier)), ["someone-else", "reminder.2027-06-01"])
    }

    func testAnEraseCancelsEveryReminderAndTurnsThemOff() async {
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        XCTAssertEqual(center.pending.count, 2)
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        await scheduler.refresh()
        XCTAssertEqual(center.pending.count, 0)
        XCTAssertFalse(scheduler.optedIn, "an erase ends the opt-in; the user turns reminders on again")
        await scheduler.refresh()
        XCTAssertEqual(center.pending.count, 0)
        // Opting in again holds under the new epoch.
        _ = await scheduler.optIn()
        XCTAssertEqual(center.pending.count, 1)
    }

    func testTheOptInSurvivesARelaunchInTheRecordsFolder() async {
        _ = await scheduler().optIn()
        let relaunched = scheduler()
        XCTAssertTrue(relaunched.optedIn)
        // Kept beside the record, in the folder backups leave out (D5), so a restored
        // phone, which starts a new record, starts with reminders off.
        XCTAssertTrue(FileManager.default.fileExists(atPath: folder.appending(path: "reminders-opt-in").path(percentEncoded: false)))
    }

    func testAnUnreadableRecordCancelsEverythingButKeepsTheOptIn() async {
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        engineFails = true
        await scheduler.refresh()
        XCTAssertEqual(center.pending.count, 0)
        XCTAssertNil(scheduler.reminders)
        XCTAssertTrue(scheduler.optedIn, "a failed read is not an erase")
        engineFails = false
        await scheduler.refresh()
        XCTAssertEqual(center.pending.count, 2)
    }

    func testAGrantWithAnUnreadableRecordIsNotReportedAsARefusal() async {
        engineFails = true
        let scheduler = scheduler()
        let on = await scheduler.optIn()
        XCTAssertFalse(on)
        XCTAssertEqual(scheduler.permission, .allowed, "the switch must not send the user to Settings")
    }

    func testTurningRemindersOffRedrawsTheSwitch() async {
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        let redrawn = expectation(description: "the section is told the opt-in changed")
        withObservationTracking { _ = scheduler.optedIn } onChange: { redrawn.fulfill() }
        await scheduler.optOut()
        await fulfillment(of: [redrawn], timeout: 1)
    }

    func testOptingOutCancelsEverything() async {
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        await scheduler.optOut()
        XCTAssertFalse(scheduler.optedIn)
        XCTAssertEqual(center.pending.count, 0)
    }

    func testTheLockScreenSaysOnlyThatACheckUpIsDue() throws {
        let request = ReminderScheduler.request(for: .init(id: "reminder.2027-03-01", fireDay: "2027-03-01", categories: ["screening_colorectal"]))
        XCTAssertEqual(request.identifier, "reminder.2027-03-01")
        XCTAssertEqual(request.content.title, "Health Roadmap")
        XCTAssertEqual(request.content.body, "A check-up is due. Open the app to see which.")
        let trigger = try XCTUnwrap(request.trigger as? UNCalendarNotificationTrigger)
        XCTAssertFalse(trigger.repeats)
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = .autoupdatingCurrent
        XCTAssertEqual(trigger.dateComponents, DateComponents(calendar: gregorian, year: 2027, month: 3, day: 1, hour: 9))
    }

    /// US-25 AC12: a reminder shows on its day at 9:00 whatever calendar the phone is set to.
    /// The engine's days are Gregorian; a trigger without a calendar is read in the phone's,
    /// so a Buddhist phone was asked for 1556 (never fired) and a Japanese one for 4117.
    func testTheReminderShowsOnItsDayWhateverCalendarThePhoneUses() throws {
        let request = ReminderScheduler.request(for: .init(id: "reminder.2099-03-01", fireDay: "2099-03-01", categories: ["screening_colorectal"]))
        let trigger = try XCTUnwrap(request.trigger as? UNCalendarNotificationTrigger)
        var gregorian = Calendar(identifier: .gregorian)
        gregorian.timeZone = .current
        let nineOnTheDay = try XCTUnwrap(gregorian.date(from: DateComponents(year: 2099, month: 3, day: 1, hour: 9)))
        // iOS reads a trigger's components in their own calendar, or in the phone's when they carry none.
        for identifier in [Calendar.Identifier.buddhist, .japanese, .islamicUmmAlQura, .persian, .hebrew] {
            var phone = Calendar(identifier: identifier)
            phone.timeZone = .current
            XCTAssertEqual((trigger.dateComponents.calendar ?? phone).date(from: trigger.dateComponents), nineOnTheDay, "\(identifier)")
        }
        XCTAssertNil(trigger.dateComponents.timeZone, "9:00 on the phone's clock, wherever the phone is")
        XCTAssertEqual(trigger.nextTriggerDate(), nineOnTheDay)
    }

    /// US-25 AC12: 9:00 stays 9:00 on the phone's clock after the phone changes time zone. iOS keeps the trigger
    /// (archived) and reads it later, so a calendar holding the zone it was built in fired at 9:00 in that old zone.
    func testTheReminderStaysAtNineOnThePhonesClockAfterAZoneChange() throws {
        let saved = ProcessInfo.processInfo.environment["TZ"]
        defer {
            if let saved { setenv("TZ", saved, 1) } else { unsetenv("TZ") }
            NSTimeZone.resetSystemTimeZone()
        }
        // The phone's own zone moves, as when it travels (NSTimeZone.default would leave the phone's zone alone).
        func movePhone(to zone: String) {
            setenv("TZ", zone, 1)
            NSTimeZone.resetSystemTimeZone()
        }
        movePhone(to: "America/New_York")
        let request = ReminderScheduler.request(for: .init(id: "reminder.2099-03-01", fireDay: "2099-03-01", categories: ["screening_colorectal"]))
        let archived = try NSKeyedArchiver.archivedData(withRootObject: try XCTUnwrap(request.trigger), requiringSecureCoding: true)
        movePhone(to: "Pacific/Auckland")
        let auckland = try XCTUnwrap(TimeZone(identifier: "Pacific/Auckland"))
        XCTAssertEqual(TimeZone.current, auckland)
        let trigger = try XCTUnwrap(NSKeyedUnarchiver.unarchivedObject(ofClass: UNCalendarNotificationTrigger.self, from: archived))
        var there = Calendar(identifier: .gregorian)
        there.timeZone = auckland
        XCTAssertEqual(trigger.nextTriggerDate(), there.date(from: DateComponents(year: 2099, month: 3, day: 1, hour: 9)))
    }

    func testTheEngineGivesTheAnnualFloorForANewRecord() throws {
        let engine = try HealthEngine()
        let now = try Date("2026-10-21T08:00:00.000Z", strategy: .iso8601)
        let record = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "UTC")!) }
        let out = try engine.blocking { [now] in try $0.reminders(recordJSON: record, now: now, deviceId: "test") }
        XCTAssertEqual(out.eraseEpoch, 0)
        XCTAssertEqual(out.upcoming.map(\.category), ["annual_checkin"])
        XCTAssertEqual(out.upcoming.first?.dueAt, "2027-10-21")
        XCTAssertEqual(out.notifications.first?.id, "reminder.2027-10-21")
    }

    /// US-17 AC15: the day the phone first saw each follow-up reminder is kept beside
    /// the opt-in and sent back, so the engine fires it that morning and then every
    /// 90 days from it. Kept only on the phone; cleared while nothing is scheduled.
    private var firstSeenKept: Bool {
        FileManager.default.fileExists(atPath: folder.appending(path: "reminders-first-seen").path(percentEncoded: false))
    }

    /// US-17 AC15: kept across a relaunch and sent back to the engine.
    func testFollowUpFirstSeenDaysAreKeptOnThePhoneAndSentBack() async {
        engineOutput.firstSeen = ["screening_colorectal:organize": "2026-11-05"]
        _ = await scheduler().optIn()
        let relaunched = scheduler()
        engineOutput.firstSeen = nil // an engine before them: what is kept stays as it is
        await relaunched.refresh()
        XCTAssertEqual(sentFirstSeen.last, ["screening_colorectal:organize": "2026-11-05"])
        XCTAssertTrue(firstSeenKept)
    }

    /// US-17 AC15: turning reminders off clears them.
    func testFirstSeenDaysClearWhenNothingIsScheduled() async {
        engineOutput.firstSeen = ["screening_colorectal:organize": "2026-11-05"]
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        await scheduler.optOut()
        await scheduler.refresh()
        XCTAssertEqual(sentFirstSeen.last, [:], "turned back on, a follow-up fires once more on its first morning")
        XCTAssertFalse(firstSeenKept)
    }

    /// US-17 AC15: turned off while the record cannot be read, they still clear, so turned on
    /// again a follow-up fires on its first morning (Codex R1).
    func testFirstSeenDaysClearOnOptOutEvenWhenTheEngineFails() async {
        engineOutput.firstSeen = ["screening_colorectal:organize": "2026-11-05"]
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        XCTAssertTrue(firstSeenKept)
        engineFails = true
        await scheduler.optOut()
        XCTAssertFalse(firstSeenKept)
        engineFails = false
        _ = await scheduler.optIn()
        XCTAssertEqual(sentFirstSeen.last, [:], "nothing kept: the engine starts the follow-up on its first morning")
    }

    /// US-17 AC15: an erase ends the opt-in, and the first-seen days go with it.
    func testAnEraseRemovesTheFirstSeenDays() async {
        engineOutput.firstSeen = ["screening_colorectal:organize": "2026-11-05"]
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        XCTAssertTrue(firstSeenKept)
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        await scheduler.refresh()
        XCTAssertFalse(firstSeenKept)
    }

    /// US-17 AC15: the real engine answers first-seen days when the app sends them.
    func testTheEngineAnswersFirstSeenDaysWhenAsked() throws {
        let engine = try HealthEngine()
        let now = try Date("2026-10-21T08:00:00.000Z", strategy: .iso8601)
        let record = try engine.blocking { [now] in try $0.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "UTC")!) }
        let out = try engine.blocking { [now] in try $0.reminders(recordJSON: record, now: now, deviceId: "test", firstSeen: [:]) }
        XCTAssertEqual(out.firstSeen, [:], "no follow-up in a new record")
    }

    /// US-25 AC12b (iPhone survey S7): a second tap on the switch while iOS is still answering
    /// the first asks nothing more. Permission already decided means no alert, so the switch,
    /// still drawn off, takes the tap.
    func testADoubleTapMidOptInAsksIOSOnce_US25_AC12b() async {
        center.holdsAnswers = true
        let scheduler = scheduler()
        let first = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        let second = Task { await scheduler.optIn() }
        await until { false } // the second tap runs as far as it can
        center.releaseAll()
        _ = await first.value
        _ = await second.value
        XCTAssertEqual(center.permissionAsks, 1, "one tap's worth of asking")
        XCTAssertTrue(scheduler.optedIn)
        XCTAssertEqual(center.pending.count, 2)
    }

    /// US-25 AC12b (iPhone survey S7): an answer that lands after the user turned reminders off
    /// leaves them off. Before, the double tap's second answer turned them back on.
    func testALateOptInCannotUndoALaterOptOut_US25_AC12b() async {
        center.holdsAnswers = true
        let scheduler = scheduler()
        let first = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        let second = Task { await scheduler.optIn() }
        await until { false }
        center.releaseFirst()
        _ = await first.value
        XCTAssertTrue(scheduler.optedIn, "the first answer turns reminders on")
        await scheduler.optOut()
        center.releaseAll()
        _ = await second.value
        XCTAssertFalse(scheduler.optedIn, "the user asked for off")
        XCTAssertEqual(center.pending.count, 0)
    }

    /// Lets queued main-actor work run until `done` holds, or a bounded number of turns pass.
    private func until(_ done: () -> Bool) async {
        for _ in 0..<200 where !done() { await Task.yield() }
    }

    private func request(_ id: String) -> UNNotificationRequest {
        UNNotificationRequest(identifier: id, content: UNMutableNotificationContent(), trigger: nil)
    }
}

/// Stands in for UNUserNotificationCenter: keeps pending requests in memory.
@MainActor
final class FakeNotificationCenter: NotificationScheduling {
    var pending: [UNNotificationRequest] = []
    var grants = true
    var status = NotificationPermission.notAsked
    var permissionAsks = 0
    /// When set, each permission answer waits for `releaseFirst` or `releaseAll`, as iOS's
    /// answer arrives after an XPC hop.
    var holdsAnswers = false
    private(set) var held: [CheckedContinuation<Void, Never>] = []

    func releaseFirst() { if !held.isEmpty { held.removeFirst().resume() } }
    func releaseAll() { while !held.isEmpty { releaseFirst() } }

    func requestPermission() async throws -> Bool {
        permissionAsks += 1
        if holdsAnswers { await withCheckedContinuation { held.append($0) } }
        status = grants ? .allowed : .denied
        return grants
    }

    func permission() async -> NotificationPermission { status }

    func pendingIdentifiers() async -> [String] { pending.map(\.identifier) }

    func removePending(_ identifiers: [String]) {
        pending.removeAll { identifiers.contains($0.identifier) }
    }

    func add(_ request: UNNotificationRequest) async throws {
        pending.removeAll { $0.identifier == request.identifier }
        pending.append(request)
    }
}
