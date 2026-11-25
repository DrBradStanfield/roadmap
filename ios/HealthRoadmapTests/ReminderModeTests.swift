import XCTest
@testable import HealthRoadmap

/// US-25 AC12b (iPhone survey S7): the reminders switch is one mode, changed only by
/// `ReminderMode.transition`. Every mode x every event shape: the mode that follows and
/// the effect it asks for.
final class ReminderModeTests: XCTestCase {
    private typealias Row = (event: String, mode: ReminderMode, effect: ReminderEffect?)

    // The shapes of every event, sent to `asking(attempt: 1)` and `on(epoch: 5)`.
    private static let events: [(String, ReminderEvent)] = [
        ("tappedOn", .tappedOn(attempt: 2)),
        ("tappedOff", .tappedOff),
        ("asked granted", .asked(attempt: 1, granted: true, epoch: 7, askedAt: 7, lastRead: 7)),
        ("asked granted, unread at the ask", .asked(attempt: 1, granted: true, epoch: 7, askedAt: nil, lastRead: 7)),
        ("asked granted, unread at the ask, erased since the last read", .asked(attempt: 1, granted: true, epoch: 7, askedAt: nil, lastRead: 6)),
        ("asked granted, never read", .asked(attempt: 1, granted: true, epoch: 7, askedAt: nil, lastRead: nil)),
        ("asked granted, erased since", .asked(attempt: 1, granted: true, epoch: 7, askedAt: 6, lastRead: 6)),
        ("asked granted, unreadable", .asked(attempt: 1, granted: true, epoch: nil, askedAt: 7, lastRead: 7)),
        ("asked refused", .asked(attempt: 1, granted: false, epoch: nil, askedAt: 7, lastRead: 7)),
        ("asked stale", .asked(attempt: 9, granted: true, epoch: 7, askedAt: 7, lastRead: 7)),
        ("read same", .read(epoch: 5)),
        ("read moved", .read(epoch: 6)),
        ("read failed", .read(epoch: nil)),
        ("erased", .erased),
    ]

    private static let table: [(ReminderMode, [Row])] = [
        (.off, [
            // A tap from off takes the erase count afresh: an erase before it does not end the opt-in.
            ("tappedOn", .asking(attempt: 2), .resnapshotAndAsk(attempt: 2)),
            ("tappedOff", .off, nil),
            // A late answer after the user turned reminders off is dropped.
            ("asked granted", .off, nil),
            ("asked granted, unread at the ask", .off, nil),
            ("asked granted, unread at the ask, erased since the last read", .off, nil),
            ("asked granted, never read", .off, nil),
            ("asked granted, erased since", .off, nil),
            ("asked granted, unreadable", .off, nil),
            ("asked refused", .off, nil),
            ("asked stale", .off, nil),
            ("read same", .off, nil),
            ("read moved", .off, nil),
            ("read failed", .off, nil),
            ("erased", .off, nil),
        ]),
        (.asking(attempt: 1), [
            // A double tap while iOS answers asks nothing more.
            ("tappedOn", .asking(attempt: 1), nil),
            ("tappedOff", .off, .refresh),
            ("asked granted", .on(epoch: 7), .refresh),
            // A failed read before the ask falls back to the last good read (R1).
            ("asked granted, unread at the ask", .on(epoch: 7), .refresh),
            // ...which tells an erase since it: the grant was for the record before (US-11).
            ("asked granted, unread at the ask, erased since the last read", .off, .refresh),
            // With no good read ever, an erase cannot be told: the grant does not count.
            ("asked granted, never read", .off, .refresh),
            // An erase while iOS answered: the grant was for the record before it (US-11).
            ("asked granted, erased since", .off, .refresh),
            ("asked granted, unreadable", .off, .refresh),
            ("asked refused", .off, .refresh),
            ("asked stale", .asking(attempt: 1), nil),
            ("read same", .asking(attempt: 1), nil),
            ("read moved", .asking(attempt: 1), nil),
            ("read failed", .asking(attempt: 1), nil),
            // An erase while iOS answers: the late answer then lands on off and is dropped.
            ("erased", .off, nil),
        ]),
        (.on(epoch: 5), [
            // "Allow notifications" asks again; reminders stay on whatever iOS says.
            // An unseen erase must still end it, no resnapshot.
            ("tappedOn", .on(epoch: 5), .askPermission(attempt: 2)),
            ("tappedOff", .off, .refresh),
            ("asked granted", .on(epoch: 5), .refresh),
            ("asked granted, unread at the ask", .on(epoch: 5), .refresh),
            ("asked granted, unread at the ask, erased since the last read", .on(epoch: 5), .refresh),
            ("asked granted, never read", .on(epoch: 5), .refresh),
            ("asked granted, erased since", .on(epoch: 5), .refresh),
            ("asked granted, unreadable", .on(epoch: 5), .refresh),
            ("asked refused", .on(epoch: 5), .refresh),
            ("asked stale", .on(epoch: 5), .refresh),
            ("read same", .on(epoch: 5), nil),
            // An erase moved the epoch: the opt-in ends (US-11).
            ("read moved", .off, nil),
            // A failed read is not an erase.
            ("read failed", .on(epoch: 5), nil),
            // An erase here, even one held with no record to read (S52).
            ("erased", .off, nil),
        ]),
    ]

    func testEveryModeAndEvent_US25_AC12b() {
        var rows = 0
        for (mode, expected) in Self.table {
            XCTAssertEqual(expected.map(\.event), Self.events.map(\.0), "\(mode): every event has a row")
            for (row, (name, event)) in zip(expected, Self.events) {
                let (next, effect) = ReminderMode.transition(mode, event)
                XCTAssertEqual(next, row.mode, "\(mode) x \(name)")
                XCTAssertEqual(effect, row.effect, "\(mode) x \(name): effect")
                rows += 1
            }
        }
        XCTAssertEqual(rows, 42)
    }
}
