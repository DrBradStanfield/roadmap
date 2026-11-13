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
    /// When set, each engine read takes the record as it is when called, then waits to be
    /// resumed: a read in flight across a record switch (S41).
    private var holdsReads = false
    private var heldReads: [CheckedContinuation<Void, Never>] = []
    /// The store's erase count (RecordStore.erasures), as the app hands it in.
    private var erasureCount = 0

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
        holdsReads = false
        heldReads = []
        erasureCount = 0
    }

    private func scheduler() -> ReminderScheduler {
        ReminderScheduler(center: center, folder: folder, erasures: { [unowned self] in erasureCount }) { [unowned self] firstSeen in
            sentFirstSeen.append(firstSeen)
            let fails = engineFails, output = engineOutput
            if holdsReads { await withCheckedContinuation { heldReads.append($0) } }
            if fails { throw HealthEngine.EngineError.callFailed("unreadable") }
            return output!
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

    private var optInKept: Bool {
        FileManager.default.fileExists(atPath: folder.appending(path: "reminders-opt-in").path(percentEncoded: false))
    }

    /// US-25 AC12b (S52): an erase held with no record to read still ends reminders. The failed
    /// read alone is not an erase, but the store's erase count moved: the erase words say
    /// reminders are deleted, so the opt-in and the first-seen days go.
    func testAnEraseHeldWithNoRecordEndsReminders_US25_AC12b() async {
        engineOutput.firstSeen = ["screening_colorectal:organize": "2026-11-05"]
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        XCTAssertTrue(optInKept)
        XCTAssertTrue(firstSeenKept)
        erasureCount = 1
        engineFails = true
        await scheduler.refresh()
        XCTAssertFalse(scheduler.optedIn, "the erase ends the opt-in though nothing could be read")
        XCTAssertFalse(optInKept)
        XCTAssertFalse(firstSeenKept)
        XCTAssertEqual(center.pending.count, 0)
    }

    /// US-25 AC12b (S52): after a held erase, the user turns reminders on again under the new
    /// record, and that opt-in holds: the count was already seen.
    func testAnOptInAfterAHeldEraseHolds() async {
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        erasureCount = 1
        engineFails = true
        await scheduler.refresh()
        XCTAssertFalse(scheduler.optedIn)
        engineFails = false
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        let on = await scheduler.optIn()
        XCTAssertTrue(on)
        XCTAssertEqual(center.pending.count, 1)
        await scheduler.refresh()
        XCTAssertTrue(scheduler.optedIn, "the erase was seen once; it ends nothing more")
        XCTAssertEqual(center.pending.count, 1)
    }

    /// US-25 AC12b (S52, adversary finding 1): an erase moves the count, and the person turns
    /// reminders on before any refresh has seen it. That opt-in is made after the erase, under
    /// the new record: the next refresh must not take it for the erase and end it.
    func testAnOptInBeforeTheRefreshThatSeesTheEraseHolds_US25_AC12b() async {
        let scheduler = scheduler()
        erasureCount = 1
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        let on = await scheduler.optIn()
        XCTAssertTrue(on)
        await scheduler.refresh()
        XCTAssertTrue(scheduler.optedIn, "the erase came before the opt-in; it ends nothing")
        XCTAssertTrue(optInKept)
        XCTAssertEqual(center.pending.count, 1)
    }

    /// US-25 AC12b (S52): already on, "Allow notifications" tapped after a held erase the
    /// scheduler has not seen yet. The tap is not an opt-in after the erase: the erase still ends it.
    func testAllowNotificationsAfterAnUnseenHeldEraseStillEndsReminders_US25_AC12b() async {
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        erasureCount = 1
        engineFails = true
        _ = await scheduler.optIn()
        await scheduler.refresh()
        XCTAssertFalse(scheduler.optedIn)
        XCTAssertFalse(optInKept)
        XCTAssertEqual(center.pending.count, 0)
    }

    /// Owner pin 1a (S52): an erase made on another device reaches this phone as a record whose
    /// erase epoch moved. This phone's erase count does not move for it (only RecordStore's
    /// own erases count), so the epoch rule ends the opt-in, and both files go the same way.
    func testARemoteEraseSeenHereEndsRemindersTheSameWay_US25_AC12b() async {
        engineOutput.firstSeen = ["screening_colorectal:organize": "2026-11-05"]
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        await scheduler.refresh()
        XCTAssertFalse(scheduler.optedIn)
        XCTAssertFalse(optInKept)
        XCTAssertFalse(firstSeenKept)
        XCTAssertEqual(center.pending.count, 0)
    }

    /// Owner pin 1b (S52): an own erase whose record draws at once moves both the count and the
    /// epoch in one refresh. Reminders end once: one mode change, no effect, one engine read.
    func testAnOwnDrawnEraseEndsRemindersExactlyOnce_US25_AC12b() async {
        engineOutput.firstSeen = ["screening_colorectal:organize": "2026-11-05"]
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        let (asks, reads) = (center.permissionAsks, sentFirstSeen.count)
        erasureCount = 1
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        await scheduler.refresh()
        XCTAssertFalse(scheduler.optedIn)
        XCTAssertFalse(optInKept)
        XCTAssertFalse(firstSeenKept)
        XCTAssertEqual(center.pending.count, 0)
        XCTAssertEqual(center.permissionAsks, asks, "no ask")
        XCTAssertEqual(sentFirstSeen.count, reads + 1, "one read: no refresh effect ran a second")
        // The two events that refresh sent: the first ends the opt-in, the epoch rule then has nothing to end.
        let (afterErase, eraseEffect) = ReminderMode.transition(.on(epoch: 0), .erased)
        let (afterRead, readEffect) = ReminderMode.transition(afterErase, .read(epoch: 1))
        XCTAssertEqual([afterErase, afterRead], [.off, .off])
        XCTAssertEqual([eraseEffect, readEffect], [nil, nil])
    }

    /// Owner pin 2, the kill limit (S52): killed between the store's erase and the refresh, the
    /// next launch's scheduler starts from the store's fresh count (0), so the count cannot tell.
    /// Its first good read, at the new epoch, ends the opt-in through the epoch rule.
    func testAKillBetweenTheEraseAndTheRefreshEndsRemindersAtTheNextGoodRead_US25_AC12b() async {
        engineOutput.firstSeen = ["screening_colorectal:organize": "2026-11-05"]
        _ = await scheduler().optIn()
        erasureCount = 1 // the store erased; the app was killed before the refresh
        erasureCount = 0 // the next launch: a new store's count
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        let relaunched = scheduler()
        XCTAssertTrue(relaunched.optedIn, "the saved opt-in, before any read")
        await relaunched.refresh()
        XCTAssertFalse(relaunched.optedIn)
        XCTAssertFalse(optInKept)
        XCTAssertFalse(firstSeenKept)
        XCTAssertEqual(center.pending.count, 0)
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

    /// US-25 AC12b (adversary F1): the answer to an older ask is dropped through the scheduler,
    /// whether reminders are off by then or a newer ask is out.
    func testALateAnswerToAnOlderAskIsDropped_US25_AC12b() async {
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        // "Allow notifications" asks again while on; the user turns reminders off; the answer lands.
        center.holdsAnswers = true
        let reask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        await scheduler.optOut()
        center.releaseAll()
        _ = await reask.value
        XCTAssertFalse(scheduler.optedIn, "off x asked: the late answer is dropped")
        XCTAssertEqual(center.pending.count, 0)

        // On again; a re-ask is out; off; on again (a newer ask); the older answer lands first.
        center.holdsAnswers = false
        _ = await scheduler.optIn()
        center.holdsAnswers = true
        let older = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        await scheduler.optOut()
        let newer = Task { await scheduler.optIn() }
        await until { self.center.held.count == 2 }
        center.releaseFirst()
        _ = await older.value
        XCTAssertFalse(scheduler.optedIn, "asking x an older attempt's answer: still asking")
        XCTAssertEqual(center.pending.count, 0)
        center.releaseFirst()
        _ = await newer.value
        XCTAssertTrue(scheduler.optedIn, "the newer ask's grant turns reminders on")
        XCTAssertEqual(center.pending.count, 2)
    }

    /// US-25 AC12b, US-11: an erase that lands while iOS is answering ends the ask. The grant
    /// was given for the record before the erase, so reminders stay off and nothing is scheduled.
    func testAnEraseDuringThePermissionAskLeavesRemindersOff_US25_AC12b() async {
        center.holdsAnswers = true
        let scheduler = scheduler()
        let ask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        await scheduler.refresh() // the erase's refresh
        center.releaseAll()
        _ = await ask.value
        XCTAssertFalse(scheduler.optedIn, "no reminders for the erased record")
        XCTAssertEqual(center.pending.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appending(path: "reminders-opt-in").path(percentEncoded: false)))
    }

    /// US-25 AC12b, US-11 (lead R1): the read before the ask fails, an erase lands while iOS
    /// answers, then the grant arrives. The last good read tells the erase: reminders stay off.
    func testAFailedReadBeforeTheAskStillCatchesAnEraseDuringIt_US25_AC12b() async {
        let scheduler = scheduler()
        await scheduler.refresh() // a good read at epoch 0
        center.holdsAnswers = true
        engineFails = true
        let ask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineFails = false
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        await scheduler.refresh() // the erase's refresh
        center.releaseAll()
        _ = await ask.value
        XCTAssertFalse(scheduler.optedIn, "no reminders for the erased record")
        XCTAssertEqual(center.pending.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appending(path: "reminders-opt-in").path(percentEncoded: false)))
    }

    /// US-25 AC12b (lead R1): the read before the ask fails with nothing erased; the last good
    /// read stands in, so the grant turns reminders on.
    func testAFailedReadBeforeTheAskFallsBackToTheLastGoodRead_US25_AC12b() async {
        let scheduler = scheduler()
        await scheduler.refresh() // a good read at epoch 0
        center.holdsAnswers = true
        engineFails = true
        let ask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineFails = false
        center.releaseAll()
        let on = await ask.value
        XCTAssertTrue(on, "the last good read matches the record after the grant")
        XCTAssertEqual(center.pending.count, 2)
    }

    /// US-25 AC12b, US-11 (lead R1): with no good read before the ask, an erase during it cannot
    /// be told, so the grant does not turn reminders on. A later tap, with the record read, does.
    func testAGrantWithNoGoodReadBeforeTheAskLeavesRemindersOff_US25_AC12b() async {
        engineFails = true
        let scheduler = scheduler()
        center.holdsAnswers = true
        let ask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineFails = false
        center.releaseAll()
        let on = await ask.value
        XCTAssertFalse(on, "never read: fail safe")
        XCTAssertEqual(center.pending.count, 0)
        center.holdsAnswers = false
        let again = await scheduler.optIn()
        XCTAssertTrue(again, "the next tap, with the record read, turns reminders on")
        XCTAssertEqual(center.pending.count, 2)
    }

    /// US-25 AC12b, US-11 (lead S41): record A was read at a high epoch; the person switches to
    /// record B, B's read before the ask fails, and B is erased while iOS answers. A's epoch must
    /// not stand in for B's, so the grant does not count and reminders stay off.
    func testASwitchDownThenAnEraseDuringTheAskLeavesRemindersOff_US25_AC12b() async {
        engineOutput = reminders(epoch: 5, days: ["2027-01-15"])
        let scheduler = scheduler()
        await scheduler.refresh() // record A, a good read at epoch 5
        scheduler.recordSourceChanged() // now record B, at epoch 1
        center.holdsAnswers = true
        engineFails = true
        let ask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineFails = false
        engineOutput = reminders(epoch: 2, days: ["2027-01-15"]) // B erased during the ask
        center.releaseAll()
        let on = await ask.value
        XCTAssertFalse(on, "A's epoch 5 never vouches for B's erase to 2")
        XCTAssertEqual(center.pending.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appending(path: "reminders-opt-in").path(percentEncoded: false)))
    }

    /// US-25 AC12b, US-11 (lead S41): a switch up to record B, read there, then back to record A,
    /// whose read before the ask fails and which is erased while iOS answers. B's higher epoch must
    /// not vouch for A, so reminders end off; the next tap, after a good read of A, turns them on.
    func testASwitchUpAndBackThenAnEraseDuringTheAskLeavesRemindersOff_US25_AC12b() async {
        let scheduler = scheduler()
        await scheduler.refresh() // record A, a good read at epoch 0
        scheduler.recordSourceChanged()
        engineOutput = reminders(epoch: 3, days: ["2027-01-15"])
        await scheduler.refresh() // record B, a good read at epoch 3
        scheduler.recordSourceChanged() // back to record A, at epoch 0
        center.holdsAnswers = true
        engineFails = true
        let ask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineFails = false
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"]) // A erased during the ask
        center.releaseAll()
        let on = await ask.value
        XCTAssertFalse(on, "B's epoch 3 never vouches for A's erase to 1")
        XCTAssertEqual(center.pending.count, 0)
        center.holdsAnswers = false
        await scheduler.refresh() // a good read of A at epoch 1
        let again = await scheduler.optIn()
        XCTAssertTrue(again, "the next tap, with A read, turns reminders on")
        XCTAssertEqual(center.pending.count, 1)
    }

    /// US-25 AC12b (lead S41): right after a switch, a grant with no good read of the new record
    /// ends off, even with nothing erased; a good read of it restores the fallback, so the next
    /// grant is accepted.
    func testAGoodReadAfterASwitchRestoresTheFallback_US25_AC12b() async {
        engineOutput = reminders(epoch: 5, days: ["2027-01-15"])
        let scheduler = scheduler()
        await scheduler.refresh() // record A at epoch 5
        scheduler.recordSourceChanged() // now record B, at epoch 1
        engineOutput = reminders(epoch: 1, days: ["2027-01-15", "2027-03-01"])
        center.holdsAnswers = true
        engineFails = true
        let first = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineFails = false
        center.releaseAll()
        let before = await first.value
        XCTAssertFalse(before, "A's epoch 5 is not B's: no fallback yet")
        center.holdsAnswers = false
        await scheduler.refresh() // record B, a good read at epoch 1
        center.holdsAnswers = true
        engineFails = true
        let ask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineFails = false
        center.releaseAll()
        let on = await ask.value
        XCTAssertTrue(on, "B's own last good read matches B after the grant")
        XCTAssertEqual(center.pending.count, 2)
    }

    /// US-25 AC12b, US-11 (lead S41): a connected cloud shows the phone's copy until it opens. A
    /// refresh in that window reads the phone's copy; the open is a second switch, so the phone's
    /// epoch never vouches for the cloud record's erase during the ask.
    func testTheWindowBeforeTheCloudOpensNeverVouchesForTheCloudRecord_US25_AC12b() async {
        engineOutput = reminders(epoch: 5, days: ["2027-01-15"])
        let scheduler = scheduler()
        await scheduler.refresh() // the phone's record at epoch 5
        scheduler.recordSourceChanged() // signed in: the provider is set, the phone's copy still shows
        await scheduler.refresh() // a return to the foreground reads the phone's copy again
        scheduler.recordSourceChanged() // the cloud record opens, at epoch 1
        center.holdsAnswers = true
        engineFails = true
        let ask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineFails = false
        engineOutput = reminders(epoch: 2, days: ["2027-01-15"]) // the cloud record erased during the ask
        center.releaseAll()
        let on = await ask.value
        XCTAssertFalse(on, "the phone's epoch 5 never vouches for the cloud's erase to 2")
        XCTAssertEqual(center.pending.count, 0)
    }

    /// US-25 AC12b, US-11 (lead S41, checkpoint review): the cloud's open lands before its record is
    /// drawn (CloudSync.open sets the session, then RecordStore.draw awaits the engine). The open
    /// alone leaves ShownRecord as it was (S72: open turns true only at the draw), so a refresh in
    /// that gap reads the phone's copy under the sign-in's token. The draw flips ShownRecord's open
    /// and moves its epoch, and RootView treats that as a switch, so the phone's epoch never vouches
    /// for the cloud record's erase during the ask. A contract test: this drives the scheduler as
    /// RootView does.
    func testARefreshBetweenTheOpenAndTheDrawNeverVouchesForTheCloudRecord_US25_AC12b() async {
        engineOutput = reminders(epoch: 5, days: ["2027-01-15"])
        let scheduler = scheduler()
        await scheduler.refresh() // the phone's record at epoch 5
        scheduler.recordSourceChanged() // signed in: the provider is set, the phone's copy still shows
        // The cloud's session opens; its record is not drawn yet, so ShownRecord is unchanged: no call.
        await scheduler.refresh() // a refresh in the gap reads the phone's copy at 5, under the sign-in's token
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        scheduler.recordSourceChanged() // the cloud record is drawn at epoch 1: ShownRecord's open flips, its epoch moves 5 to 1
        center.holdsAnswers = true
        engineFails = true // the tap's read before the ask fails
        let ask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineFails = false
        engineOutput = reminders(epoch: 2, days: ["2027-01-15"]) // the cloud record erased during the ask
        center.releaseAll()
        let on = await ask.value
        XCTAssertFalse(on, "the phone's epoch 5 never vouches for the cloud's erase to 2")
        XCTAssertEqual(center.pending.count, 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: folder.appending(path: "reminders-opt-in").path(percentEncoded: false)))
    }

    /// US-25 AC12b, US-11 (lead S41): RootView's key, built from what RootView has. It carries the
    /// drawn record's erase epoch, so the draw moving it is a switch for the reminders: PR 1608's key
    /// left the epoch out and missed a refresh between the cloud's open and its draw.
    func testRootViewsKeyCarriesTheDrawnRecordsEpoch_US25_AC12b() async throws {
        let (store, records) = try phoneStoreAtEpoch5()

        let cloud = ShownRecord(source: "google-drive", shownSession: 7, store: store)
        XCTAssertEqual(cloud.epoch, 5, "the drawn epoch is carried")
        XCTAssertEqual(cloud.source, "google-drive")
        let phone = ShownRecord(source: "", shownSession: nil, store: store)
        XCTAssertEqual(phone.epoch, 5)
        XCTAssertEqual(phone.source, "", "the phone's record: no source")
        XCTAssertTrue(phone.open, "the store is on the phone's record: open (S73)")

        try FileManager.default.removeItem(at: records)
        await store.showPhone().value // the phone's file cannot be read: nothing is drawn
        XCTAssertNil(store.myData, "fixture: no drawn record")
        let undrawn = ShownRecord(source: "dropbox", shownSession: nil, store: store)
        XCTAssertNil(undrawn.epoch, "no drawn record gives no epoch")
        XCTAssertEqual(undrawn.source, "dropbox")
    }

    /// A phone RecordStore whose drawn record is at erase epoch 5, and its folder.
    private func phoneStoreAtEpoch5() throws -> (RecordStore, URL) {
        let records = folder.appending(path: "record")
        try FileManager.default.createDirectory(at: records, withIntermediateDirectories: true)
        let file = records.appending(path: "health-roadmap.json")
        let engine = try HealthEngine()
        _ = try RecordStore(folder: records, engine: engine, deviceId: "ios-test") // writes an empty record
        var record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: file)) as? [String: Any])
        var meta = try XCTUnwrap(record["meta"] as? [String: Any])
        meta["eraseEpoch"] = 5
        meta["erasedAt"] = (meta["updatedAt"] as? String) ?? "2026-01-01T00:00:00.000Z"
        record["meta"] = meta
        record["erasedRows"] = ["fromEpoch": 5, "ids": [String]()]
        try JSONSerialization.data(withJSONObject: record).write(to: file)
        let store = try RecordStore(folder: records, engine: engine, deviceId: "ios-test")
        XCTAssertEqual(store.myData?.eraseEpoch, 5, "fixture: the drawn record is at epoch 5")
        return (store, records)
    }

    /// US-25 AC12b, US-54 AC7 (leads S72, S73): "open" is the source's own record drawn. Connected:
    /// the shown session's record; with no session open, nil on both sides, the nil guard keeps it
    /// closed, and the phone's flag counts for nothing. Local: the store on the phone's record,
    /// whatever session a Disconnect's cloud record still carries.
    func testOpenIsTheSourcesOwnRecordDrawn_S72_S73() {
        let rows: [(source: String, shown: Int?, drawn: Int?, phoneDrawn: Bool, want: Bool)] = [
            ("dropbox", nil, nil, false, false), ("dropbox", 7, nil, false, false), ("dropbox", nil, 7, false, false),
            ("dropbox", 7, 7, false, true), ("dropbox", 8, 7, false, false), ("dropbox", nil, nil, true, false),
            ("", nil, nil, true, true), ("", nil, 7, false, false), ("", nil, nil, false, false),
        ]
        for row in rows {
            XCTAssertEqual(ShownRecord.open(source: row.source, shown: row.shown, drawn: row.drawn, phoneDrawn: row.phoneDrawn), row.want, "\(row)")
        }
    }

    /// US-25 AC12b, US-54 AC7 (lead S72): on a real store, a session open with the phone's copy
    /// still drawn is not open; the session's record drawn is, with the cloud's epoch. At an equal
    /// epoch the key still changes at the draw, so RootView's onChange runs and takes the count.
    func testTheCloudsDrawFlipsOpenEvenAtAnEqualEpoch_S72() async throws {
        let (store, _) = try phoneStoreAtEpoch5()
        let before = ShownRecord(source: "dropbox", shownSession: 7, store: store)
        XCTAssertFalse(before.open, "the session is open but the phone's copy is drawn")
        XCTAssertEqual(before.epoch, 5)

        // The cloud's record, at the same erase epoch 5.
        await store.showCloud(HealthEngine.CloudView(record: store.recordJSON, erase: "e", session: 7)).value
        XCTAssertEqual(store.source.session, 7, "fixture: the cloud's record is drawn")
        let after = ShownRecord(source: "dropbox", shownSession: 7, store: store)
        XCTAssertTrue(after.open, "the shown session's record is drawn")
        XCTAssertEqual(after.epoch, 5, "the cloud's epoch")
        XCTAssertNotEqual(before, after, "the draw changes the key at an equal epoch")
        XCTAssertFalse(ShownRecord(source: "dropbox", shownSession: 8, store: store).open, "a newer session's record is not drawn yet")
    }

    /// US-54 AC7 (lead S73): on a real store, a Disconnect turns the source local while the cloud's
    /// record is still drawn: not open. The phone's record landing is, and at an equal epoch the
    /// key still changes at the land, so RootView's onChange runs and takes the phone's count.
    func testThePhonesLandFlipsOpenEvenAtAnEqualEpoch_S73() async throws {
        let (store, _) = try phoneStoreAtEpoch5()
        await store.showCloud(HealthEngine.CloudView(record: store.recordJSON, erase: "e", session: 7)).value
        XCTAssertNotNil(store.source.erase, "fixture: the cloud's record is drawn")

        let landing = store.showPhone() // CloudSync.disconnect queues it, then sends .disconnectEnded
        let before = ShownRecord(source: "", shownSession: nil, store: store)
        XCTAssertFalse(before.open, "the source is local but the cloud's record is still drawn")
        XCTAssertEqual(before.epoch, 5)

        await landing.value
        XCTAssertNil(store.source.erase, "fixture: the phone's record is drawn")
        let after = ShownRecord(source: "", shownSession: nil, store: store)
        XCTAssertTrue(after.open, "the phone's record is drawn")
        XCTAssertEqual(after.epoch, 5, "the phone's epoch, equal to the cloud's")
        XCTAssertNotEqual(before, after, "the land changes the key at an equal epoch")
    }

    /// US-25 AC9, US-11 (lead S73, the owner's reminders case): a Disconnect whose phone copy is
    /// byte-equal to the cloud's record. RootView bumps the token twice (the source going local, then
    /// the phone's land flipping open), but readable.json never changes, so its .task(id:) does not
    /// refresh. A bump only moves the token and drops the fallback epoch: nothing removes or adds a
    /// notification, so the person keeps the reminders the cloud's record scheduled, which are the
    /// phone's own (same record), until the next foreground or edit refreshes them. A contract test
    /// of the scheduler side, driven as RootView does.
    func testADisconnectToAnEqualRecordKeepsTheRemindersScheduled_S73() async {
        engineOutput = reminders(epoch: 0, days: ["2027-01-15", "2027-03-01"]) // the cloud's record
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        let scheduled = center.pending.map(\.identifier)
        XCTAssertEqual(scheduled, ["reminder.2027-01-15", "reminder.2027-03-01"])
        let reads = sentFirstSeen.count

        scheduler.recordSourceChanged() // .disconnectEnded: the source goes from dropbox to ""
        scheduler.recordSourceChanged() // the phone's copy lands: ShownRecord's open flips; the json is unchanged, no refresh
        XCTAssertEqual(sentFirstSeen.count, reads, "a bump reads nothing")
        XCTAssertEqual(center.pending.map(\.identifier), scheduled, "a bump removes nothing: the reminders stay")
        XCTAssertTrue(scheduler.optedIn)

        await scheduler.refresh() // the next return to the foreground
        XCTAssertEqual(center.pending.map(\.identifier), scheduled, "the same record schedules the same days")
    }

    /// US-25 AC12b, US-11 (lead S72): a switch whose new cloud's draw fails. Its open never flips
    /// ShownRecord, but the source changes at the Disconnect and the connect bump the token, and the
    /// refresh when the phone's file lands removes every reminder of ours and schedules from the
    /// record now shown, so the old cloud record's days do not stay. A contract test of the
    /// scheduler side, driven as RootView does; RootView's .task(id: readable json) is checked by reading.
    func testASwitchWhoseNewCloudNeverDrawsReschedulesFromTheShownRecord_S72() async {
        engineOutput = reminders(epoch: 0, days: ["2027-01-15", "2027-03-01"]) // Dropbox's record
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        XCTAssertEqual(center.pending.map(\.identifier), ["reminder.2027-01-15", "reminder.2027-03-01"])
        scheduler.recordSourceChanged() // the Disconnect: the source goes from dropbox to ""
        engineOutput = reminders(epoch: 0, days: ["2027-06-01"]) // the phone's file after the copy-down
        await scheduler.refresh() // the phone's file lands: RootView's .task(id: readable json)
        scheduler.recordSourceChanged() // the connect: "" to google-drive. Its draw fails: no more calls.
        XCTAssertEqual(center.pending.map(\.identifier), ["reminder.2027-06-01"], "Dropbox's days are gone")
        engineFails = true
        await scheduler.refresh() // a later round that cannot read the shown record
        XCTAssertEqual(center.pending.count, 0, "a failed read schedules nothing")
    }

    /// US-25 AC12b, US-11 (lead S41): a refresh that began reading record A lands after the switch
    /// to record B. Its epoch is A's, so it never becomes B's fallback.
    func testARefreshInFlightAcrossASwitchNeverBecomesTheFallback_US25_AC12b() async {
        engineOutput = reminders(epoch: 5, days: ["2027-01-15"])
        let scheduler = scheduler()
        holdsReads = true
        let refresh = Task { await scheduler.refresh() } // reads record A at epoch 5
        await until { self.heldReads.count == 1 }
        holdsReads = false
        scheduler.recordSourceChanged() // now record B, at epoch 1
        heldReads.removeFirst().resume()
        await refresh.value
        center.holdsAnswers = true
        engineFails = true
        let ask = Task { await scheduler.optIn() }
        await until { self.center.held.count == 1 }
        engineFails = false
        engineOutput = reminders(epoch: 2, days: ["2027-01-15"]) // B erased during the ask
        center.releaseAll()
        let on = await ask.value
        XCTAssertFalse(on, "A's late read never vouches for B's erase to 2")
        XCTAssertEqual(center.pending.count, 0)
    }

    /// US-25 AC12b, US-11 (lead S41): the switch lands while iOS answers. The reads before the ask
    /// were the old record's, so they never vouch for the new record's erase.
    func testASwitchDuringThePermissionAskLeavesRemindersOff_US25_AC12b() async {
        engineOutput = reminders(epoch: 5, days: ["2027-01-15"])
        let scheduler = scheduler()
        await scheduler.refresh() // record A at epoch 5
        center.holdsAnswers = true
        let ask = Task { await scheduler.optIn() } // its read before the ask is A's 5
        await until { self.center.held.count == 1 }
        scheduler.recordSourceChanged() // now record B, at epoch 1
        engineOutput = reminders(epoch: 2, days: ["2027-01-15"]) // B erased during the ask
        center.releaseAll()
        let on = await ask.value
        XCTAssertFalse(on, "A's reads never vouch for B's erase to 2")
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
