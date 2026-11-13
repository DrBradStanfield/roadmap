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
    }

    private func scheduler() -> ReminderScheduler {
        ReminderScheduler(center: center, folder: folder) { [unowned self] firstSeen in
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
    /// drawn (CloudSync.open sets the session, then RecordStore.draw awaits the engine). A refresh in
    /// that gap reads the phone's copy under the open's token. The draw moves ShownRecord's epoch,
    /// and RootView treats that as a switch too, so the phone's epoch never vouches for the cloud
    /// record's erase during the ask. A contract test: on main RootView's key left the epoch out, so
    /// it made no call at the draw; this test drives the scheduler as RootView now does.
    func testARefreshBetweenTheOpenAndTheDrawNeverVouchesForTheCloudRecord_US25_AC12b() async {
        engineOutput = reminders(epoch: 5, days: ["2027-01-15"])
        let scheduler = scheduler()
        await scheduler.refresh() // the phone's record at epoch 5
        scheduler.recordSourceChanged() // signed in: the provider is set, the phone's copy still shows
        scheduler.recordSourceChanged() // the cloud's session opens; its record is not drawn yet
        await scheduler.refresh() // a refresh in the gap reads the phone's copy at 5, under the open's token
        engineOutput = reminders(epoch: 1, days: ["2027-01-15"])
        scheduler.recordSourceChanged() // the cloud record is drawn at epoch 1: ShownRecord's epoch moves 5 to 1
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
