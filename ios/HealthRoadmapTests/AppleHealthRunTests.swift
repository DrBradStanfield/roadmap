import XCTest
@testable import HealthRoadmap

/// Lead H27 (US-72 AC10, US-25 AC13): Apple Health's run state is one mode, changed only by
/// `AppleHealthSync.Run.transition`. Every state x every event shape: the state that follows and
/// the effect it asks for. Then what Settings shows for each state.
final class AppleHealthRunTests: XCTestCase {
    private typealias Run = AppleHealthSync.Run
    private typealias Row = (event: String, run: Run, effect: AppleHealthSync.RunEffect?)

    private static let day = Date(timeIntervalSince1970: 1_792_000_000)
    private static let earlier = Date(timeIntervalSince1970: 1_791_000_000)

    private static let events: [(String, AppleHealthSync.RunEvent)] = [
        ("trigger connected", .trigger(connected: true)),
        ("trigger not connected", .trigger(connected: false)),
        ("passEnded up to date", .passEnded(.done(.upToDate(day)))),
        ("passEnded not allowed", .passEnded(.done(.notAllowed))),
        ("passEnded moved", .passEnded(.moved)),
        ("passEnded locked", .passEnded(.locked)),
        ("passEnded failed", .passEnded(.failed("refused"))),
        ("gateClosed", .gateClosed),
        ("disconnect connected", .disconnect(wasConnected: true)),
        ("disconnect not connected", .disconnect(wasConnected: false)),
        ("connectFailed", .connectFailed("sheet failed")),
    ]

    private static let table: [(Run, [Row])] = [
        // No Health on this phone absorbs everything, an erase included (D3).
        (.unavailable, [
            ("trigger connected", .unavailable, nil),
            ("trigger not connected", .unavailable, nil),
            ("passEnded up to date", .unavailable, nil),
            ("passEnded not allowed", .unavailable, nil),
            ("passEnded moved", .unavailable, nil),
            ("passEnded locked", .unavailable, nil),
            ("passEnded failed", .unavailable, nil),
            ("gateClosed", .unavailable, nil),
            ("disconnect connected", .unavailable, nil),
            ("disconnect not connected", .unavailable, nil),
            ("connectFailed", .unavailable, nil),
        ]),
        (.disconnected, [
            // Connect, then its refresh: the first pass.
            ("trigger connected", .running(queued: false), .pass),
            ("trigger not connected", .disconnected, nil),
            ("passEnded up to date", .disconnected, nil),
            ("passEnded not allowed", .disconnected, nil),
            ("passEnded moved", .disconnected, nil),
            ("passEnded locked", .disconnected, nil),
            ("passEnded failed", .disconnected, nil),
            ("gateClosed", .disconnected, nil),
            ("disconnect connected", .disconnected, nil),
            ("disconnect not connected", .disconnected, nil),
            ("connectFailed", .idle(.failed("sheet failed")), nil),
        ]),
        (.idle(.notYet), [
            ("trigger connected", .running(queued: false), .pass),
            ("trigger not connected", .disconnected, nil),
            ("passEnded up to date", .idle(.notYet), nil),
            ("passEnded not allowed", .idle(.notYet), nil),
            ("passEnded moved", .idle(.notYet), nil),
            ("passEnded locked", .idle(.notYet), nil),
            ("passEnded failed", .idle(.notYet), nil),
            ("gateClosed", .idle(.notYet), nil),
            ("disconnect connected", .disconnected, nil),
            ("disconnect not connected", .idle(.notYet), nil),
            ("connectFailed", .idle(.failed("sheet failed")), nil),
        ]),
        (.idle(.upToDate(earlier)), [
            ("trigger connected", .running(queued: false), .pass),
            ("trigger not connected", .disconnected, nil),
            ("passEnded up to date", .idle(.upToDate(earlier)), nil),
            ("passEnded not allowed", .idle(.upToDate(earlier)), nil),
            ("passEnded moved", .idle(.upToDate(earlier)), nil),
            ("passEnded locked", .idle(.upToDate(earlier)), nil),
            ("passEnded failed", .idle(.upToDate(earlier)), nil),
            ("gateClosed", .idle(.upToDate(earlier)), nil),
            ("disconnect connected", .disconnected, nil),
            ("disconnect not connected", .idle(.upToDate(earlier)), nil),
            ("connectFailed", .idle(.failed("sheet failed")), nil),
        ]),
        (.running(queued: false), [
            // However many ask during a pass, one more runs after it; each waits for it.
            ("trigger connected", .running(queued: true), .wait),
            ("trigger not connected", .running(queued: true), .wait),
            ("passEnded up to date", .idle(.upToDate(day)), .release),
            ("passEnded not allowed", .idle(.notAllowed), .release),
            // An erase landed meanwhile: the next pass meets it at the gate.
            ("passEnded moved", .running(queued: false), .pass),
            ("passEnded locked", .idle(.waitingForUnlock), .release),
            ("passEnded failed", .idle(.failed("refused")), .release),
            ("gateClosed", .disconnected, .release),
            ("disconnect connected", .stopping, nil),
            ("disconnect not connected", .running(queued: false), nil),
            // The running pass owns what Settings shows (D2 (a)).
            ("connectFailed", .running(queued: false), nil),
        ]),
        (.running(queued: true), [
            ("trigger connected", .running(queued: true), .wait),
            ("trigger not connected", .running(queued: true), .wait),
            ("passEnded up to date", .running(queued: false), .pass),
            ("passEnded not allowed", .running(queued: false), .pass),
            ("passEnded moved", .running(queued: false), .pass),
            // A locked phone or a failure drops the queued run.
            ("passEnded locked", .idle(.waitingForUnlock), .release),
            ("passEnded failed", .idle(.failed("refused")), .release),
            // The gate disconnected Health: the queued run is dropped.
            ("gateClosed", .disconnected, .release),
            // An erase disconnect drops the queued run too.
            ("disconnect connected", .stopping, nil),
            ("disconnect not connected", .running(queued: true), nil),
            ("connectFailed", .running(queued: true), nil),
        ]),
        (.stopping, [
            // A genuine reconnect during the drain: its pass runs once the old one ends.
            ("trigger connected", .running(queued: true), .wait),
            // Never a new pass while an erase drains.
            ("trigger not connected", .stopping, nil),
            // However the pass ended, the erase disconnect shows (D1).
            ("passEnded up to date", .disconnected, .release),
            ("passEnded not allowed", .disconnected, .release),
            ("passEnded moved", .disconnected, .release),
            ("passEnded locked", .disconnected, .release),
            ("passEnded failed", .disconnected, .release),
            ("gateClosed", .disconnected, .release),
            ("disconnect connected", .stopping, nil),
            ("disconnect not connected", .stopping, nil),
            ("connectFailed", .idle(.failed("sheet failed")), nil),
        ]),
    ]

    func testEveryStateAndEvent_US72_AC10() {
        var rows = 0
        for (run, expected) in Self.table {
            XCTAssertEqual(expected.map(\.event), Self.events.map(\.0), "\(run): every event has a row")
            for (row, (name, event)) in zip(expected, Self.events) {
                let (next, effect) = Run.transition(run, event)
                XCTAssertEqual(next, row.run, "\(run) x \(name)")
                XCTAssertEqual(effect, row.effect, "\(run) x \(name): effect")
                rows += 1
            }
        }
        XCTAssertEqual(rows, 77)
    }

    /// Settings reads the seven statuses it always read (`AppleHealthSection`).
    func testWhatSettingsShowsForEachState_US72_AC10() {
        let shown: [(Run, AppleHealthSync.Status)] = [
            (.unavailable, .unavailable),
            (.disconnected, .notConnected),
            (.stopping, .notConnected),
            (.running(queued: false), .working),
            (.running(queued: true), .working),
            // At launch, connected, before the first pass.
            (.idle(.notYet), .working),
            (.idle(.upToDate(Self.day)), .upToDate(Self.day)),
            (.idle(.notAllowed), .notAllowed),
            (.idle(.waitingForUnlock), .waitingForUnlock),
            (.idle(.failed("refused")), .failed("refused")),
        ]
        for (run, status) in shown { XCTAssertEqual(run.status, status, "\(run)") }
    }
}
