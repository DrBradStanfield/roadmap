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
        ("labResults undated", .labResults(undated: true)),
        ("labResults clean", .labResults(undated: false)),
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
            // A pass that is not running reports nothing.
            ("labResults undated", .unavailable, nil),
            ("labResults clean", .unavailable, nil),
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
            // A pass that is not running reports nothing.
            ("labResults undated", .disconnected, nil),
            ("labResults clean", .disconnected, nil),
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
            // A pass that is not running reports nothing.
            ("labResults undated", .idle(.notYet), nil),
            ("labResults clean", .idle(.notYet), nil),
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
            // A pass that is not running reports nothing.
            ("labResults undated", .idle(.upToDate(earlier)), nil),
            ("labResults clean", .idle(.upToDate(earlier)), nil),
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
            // AC18: a pass that read lab results sets or clears it.
            ("labResults undated", .running(queued: false, undated: true), nil),
            ("labResults clean", .running(queued: false), nil),
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
            // AC18: a pass that read lab results sets or clears it.
            ("labResults undated", .running(queued: true, undated: true), nil),
            ("labResults clean", .running(queued: true), nil),
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
            // A failed reconnect during the drain: the pass still runs, so the claim stays (review R1).
            ("connectFailed", .stopping, nil),
            // A pass that is not running reports nothing.
            ("labResults undated", .stopping, nil),
            ("labResults clean", .stopping, nil),
        ]),
        // US-72 AC18: a lab result skipped for a bad date, carried until a reading pass reports none.
        (.idle(.upToDate(earlier), undated: true), [
            ("trigger connected", .running(queued: false, undated: true), .pass),
            // Disconnected: the sentence goes with the connection.
            ("trigger not connected", .disconnected, nil),
            ("passEnded up to date", .idle(.upToDate(earlier), undated: true), nil),
            ("passEnded not allowed", .idle(.upToDate(earlier), undated: true), nil),
            ("passEnded moved", .idle(.upToDate(earlier), undated: true), nil),
            ("passEnded locked", .idle(.upToDate(earlier), undated: true), nil),
            ("passEnded failed", .idle(.upToDate(earlier), undated: true), nil),
            ("gateClosed", .idle(.upToDate(earlier), undated: true), nil),
            ("disconnect connected", .disconnected, nil),
            ("disconnect not connected", .idle(.upToDate(earlier), undated: true), nil),
            ("connectFailed", .idle(.failed("sheet failed"), undated: true), nil),
            ("labResults undated", .idle(.upToDate(earlier), undated: true), nil),
            ("labResults clean", .idle(.upToDate(earlier), undated: true), nil),
        ]),
        (.running(queued: false, undated: true), [
            ("trigger connected", .running(queued: true, undated: true), .wait),
            ("trigger not connected", .running(queued: true, undated: true), .wait),
            // A pass that read no lab results keeps it, however it ended.
            ("passEnded up to date", .idle(.upToDate(day), undated: true), .release),
            ("passEnded not allowed", .idle(.notAllowed, undated: true), .release),
            ("passEnded moved", .running(queued: false, undated: true), .pass),
            ("passEnded locked", .idle(.waitingForUnlock, undated: true), .release),
            ("passEnded failed", .idle(.failed("refused"), undated: true), .release),
            ("gateClosed", .disconnected, .release),
            ("disconnect connected", .stopping, nil),
            ("disconnect not connected", .running(queued: false, undated: true), nil),
            ("connectFailed", .running(queued: false, undated: true), nil),
            ("labResults undated", .running(queued: false, undated: true), nil),
            // Cleared only by a pass that read lab results and skipped none.
            ("labResults clean", .running(queued: false), nil),
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
        XCTAssertEqual(rows, 117)
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

    /// US-72 AC18: "Some results could not be read." is set by a pass whose lab results had a bad
    /// date, kept by a pass that read none, and cleared by a pass that read some and skipped none.
    func testTheUndatedSentenceIsSetKeptAndCleared_US72_AC18() {
        func pass(from run: Run, labs: Bool?) -> Run {
            var next = Run.transition(run, .trigger(connected: true)).0
            if let labs { next = Run.transition(next, .labResults(undated: labs)).0 }
            return Run.transition(next, .passEnded(.done(.upToDate(Self.day)))).0
        }
        let set = pass(from: .idle(.notYet), labs: true)
        XCTAssertEqual(set, .idle(.upToDate(Self.day), undated: true))
        XCTAssertTrue(set.undated)
        XCTAssertEqual(set.status, .upToDate(Self.day), "the status line is unchanged")
        XCTAssertTrue(pass(from: set, labs: nil).undated, "a pass that read no lab results keeps it")
        XCTAssertTrue(Run.transition(set, .trigger(connected: true)).0.undated, "shown while the next pass runs")
        XCTAssertFalse(pass(from: set, labs: false).undated, "a clean reading pass clears it")
        XCTAssertFalse(Run.transition(set, .disconnect(wasConnected: true)).0.undated, "an erase disconnect drops it")
        XCTAssertEqual(AppleHealthSection.undated, "Some results could not be read.")
    }
}
