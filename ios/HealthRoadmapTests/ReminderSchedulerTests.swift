import UserNotifications
import XCTest
@testable import HealthRoadmap

/// US-25 AC9: the phone's reminders. The engine says what is due and when
/// (ios/engine/reminders.ts); these tests pin what the app does with it: only
/// after opt-in and permission, at most 64 pending, rebuilt from scratch with
/// stable ids, generic words on the lock screen, and nothing left after an erase.
@MainActor
final class ReminderSchedulerTests: XCTestCase {
    private var center: FakeNotificationCenter!
    private var defaults: UserDefaults!
    private var engineOutput: PhoneReminders!
    private var engineFails = false

    override func setUp() async throws {
        center = FakeNotificationCenter()
        defaults = UserDefaults(suiteName: "ReminderSchedulerTests-\(UUID().uuidString)")
        engineOutput = reminders(epoch: 0, days: ["2027-01-15", "2027-03-01"])
        engineFails = false
    }

    private func scheduler() -> ReminderScheduler {
        ReminderScheduler(center: center, defaults: defaults) { [unowned self] in
            if engineFails { throw HealthEngine.EngineError.callFailed("unreadable") }
            return engineOutput
        }
    }

    private func reminders(epoch: Int, days: [String]) -> PhoneReminders {
        PhoneReminders(
            eraseEpoch: epoch,
            upcoming: [.init(category: "blood_test_lipids", group: "blood_test", label: "Lipid panel blood test", dueAt: days.first ?? "2027-01-15", overdue: false)],
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
        center.authorized = false
        await scheduler.refresh()
        XCTAssertTrue(scheduler.optedIn)
        XCTAssertFalse(scheduler.permitted)
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

    func testTheOptInSurvivesARelaunch() async {
        _ = await scheduler().optIn()
        let relaunched = scheduler()
        XCTAssertTrue(relaunched.optedIn)
    }

    func testAnUnreadableRecordCancelsEverything() async {
        let scheduler = scheduler()
        _ = await scheduler.optIn()
        engineFails = true
        await scheduler.refresh()
        XCTAssertEqual(center.pending.count, 0)
        XCTAssertNil(scheduler.reminders)
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
        XCTAssertEqual(trigger.dateComponents, DateComponents(year: 2027, month: 3, day: 1, hour: 9))
    }

    func testTheEngineGivesTheAnnualFloorForANewRecord() throws {
        let engine = try HealthEngine()
        let now = try Date("2026-10-21T08:00:00.000Z", strategy: .iso8601)
        let record = try engine.newRecord(now: now, deviceId: "test", locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "UTC")!)
        let out = try engine.reminders(recordJSON: record, now: now, deviceId: "test")
        XCTAssertEqual(out.eraseEpoch, 0)
        XCTAssertEqual(out.upcoming.map(\.category), ["annual_checkin"])
        XCTAssertEqual(out.upcoming.first?.dueAt, "2027-10-21")
        XCTAssertEqual(out.notifications.first?.id, "reminder.2027-10-21")
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
    var authorized = false
    var permissionAsks = 0

    func requestPermission() async throws -> Bool {
        permissionAsks += 1
        authorized = grants
        return grants
    }

    func isPermitted() async -> Bool { authorized }

    func pendingIdentifiers() async -> [String] { pending.map(\.identifier) }

    func removePending(_ identifiers: [String]) {
        pending.removeAll { identifiers.contains($0.identifier) }
    }

    func add(_ request: UNNotificationRequest) async throws {
        pending.removeAll { $0.identifier == request.identifier }
        pending.append(request)
    }
}
