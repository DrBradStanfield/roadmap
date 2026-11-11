import XCTest
@testable import HealthRoadmap

/// US-56 AC5d (iPhone survey S4): the Apple Health cards' access state, one named state changed
/// only by a pure transition. Every state meets every event, and each place's row follows the state.
final class LiveAccessTests: XCTestCase {
    private let a: [LiveMetric: LiveCard] = [.steps: LiveCard(value: 9000, date: Date(timeIntervalSince1970: 1_792_900_000), trend: [])]
    private let b: [LiveMetric: LiveCard] = [.sleep: LiveCard(value: 27000, date: Date(timeIntervalSince1970: 1_792_900_000), trend: [])]
    private let fitness = HealthTopic.fitness.liveMetrics, sleep = HealthTopic.sleep.liveMetrics

    /// Every state × every event: the next state.
    func testEveryStateMeetsEveryEvent_US56_AC5d() {
        typealias Row = (from: LiveAccess, event: LiveAccess.Event, to: LiveAccess, why: String)
        let rows: [Row] = [
            // checked(nil): the check failed, so the state stays and the Turn On row never flashes (R4).
            (.unknown, .checked(nil), .unknown, "a failed check keeps unknown"),
            (.needsAccess, .checked(nil), .needsAccess, "a failed check keeps the Turn On row"),
            (.granted, .checked(nil), .granted, "a failed check keeps granted"),
            (.read(a), .checked(nil), .read(a), "a failed check keeps the cards"),
            (.read([:]), .checked(nil), .read([:]), "a failed check keeps the Open Settings row"),
            // checked(true): an access reset, from every state (AC2).
            (.unknown, .checked(true), .needsAccess, "the sheet is due"),
            (.needsAccess, .checked(true), .needsAccess, "still due"),
            (.granted, .checked(true), .needsAccess, "reset before the first read"),
            (.read(a), .checked(true), .needsAccess, "reset: the cards go"),
            (.read([:]), .checked(true), .needsAccess, "reset after an empty read"),
            // checked(false): access answered.
            (.unknown, .checked(false), .granted, "answered: granted, nothing read yet"),
            (.needsAccess, .checked(false), .granted, "the sheet answered: granted, not read"),
            (.granted, .checked(false), .granted, "still granted"),
            (.read(a), .checked(false), .read(a), "the cards stay until the next read"),
            (.read([:]), .checked(false), .read([:]), "the empty read stays"),
            // cardsRead: lands only once granted. In unknown or needsAccess it is a late read from
            // before a reset; it must not draw cards the person has just withdrawn access to.
            (.unknown, .cardsRead(b), .unknown, "no answer yet: a stray read draws nothing"),
            (.needsAccess, .cardsRead(b), .needsAccess, "access withdrawn: a late read draws nothing"),
            (.granted, .cardsRead(b), .read(b), "the first read draws"),
            (.granted, .cardsRead([:]), .read([:]), "a first read with none: Open Settings may show"),
            (.read(a), .cardsRead(b), .read(b), "a new read replaces the cards"),
            (.read(a), .cardsRead([:]), .read([:]), "a read with none empties them"),
            // readFailed: locked or cancelled, the state stays (N1, AC13). Granted stays granted,
            // so a failed first read never shows Open Settings (the S4 fix).
            (.unknown, .readFailed, .unknown, "nothing known"),
            (.needsAccess, .readFailed, .needsAccess, "the Turn On row stays"),
            (.granted, .readFailed, .granted, "not read: no Open Settings row (AC5d)"),
            (.read(a), .readFailed, .read(a), "a locked phone keeps what was drawn (AC13)"),
            (.read([:]), .readFailed, .read([:]), "the empty read stays"),
            // forgot: the erase empties the cards; nothing shows until the next read (AC2).
            (.unknown, .forgot, .unknown, "nothing to forget"),
            (.needsAccess, .forgot, .needsAccess, "the Turn On row stays"),
            (.granted, .forgot, .granted, "nothing drawn"),
            (.read(a), .forgot, .granted, "the cards go, access stays"),
            (.read([:]), .forgot, .granted, "no Open Settings row until the next read"),
        ]
        for row in rows {
            XCTAssertEqual(LiveAccess.transition(row.from, row.event), row.to, "\(row.from) + \(row.event): \(row.why)")
        }
        let states: [LiveAccess] = [.unknown, .needsAccess, .granted, .read(a), .read([:])]
        let events: [LiveAccess.Event] = [.checked(nil), .checked(true), .checked(false), .cardsRead(b), .readFailed, .forgot]
        for state in states {
            for event in events {
                XCTAssertTrue(rows.contains { $0.from == state && $0.event == event }, "no row for \(state) + \(event)")
            }
        }
    }

    /// AC15: kept cards start as read; none start as unknown.
    func testTheLaunchState_US56_AC15() {
        XCTAssertEqual(LiveAccess.launch(a), .read(a))
        XCTAssertEqual(LiveAccess.launch([:]), .unknown)
        XCTAssertEqual(LiveAccess.read(a).cards, a)
        XCTAssertEqual(LiveAccess.granted.cards, [:])
        XCTAssertEqual(LiveAccess.needsAccess.cards, [:])
    }

    /// AC5b, AC5d: each place's row from the state.
    func testEachPlaceShowsFromTheState_US56_AC5b_AC5d() {
        let both = a.merging(b) { $1 }
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .needsAccess, keepsReconnect: true), .turnOn)
        XCTAssertEqual(LiveShown.shown(fitness, connected: false, access: .needsAccess, keepsReconnect: true), .nothing, "not connected: the settings row is the way in")
        XCTAssertEqual(LiveShown.shown(sleep, connected: true, access: .needsAccess, keepsReconnect: false), .nothing, "Turn On is said once, in Fitness")
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .unknown, keepsReconnect: true), .nothing, "unknown: nothing flashes")
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .granted, keepsReconnect: true), .nothing, "granted, not read: no Open Settings row (AC5d)")
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .read([:]), keepsReconnect: true), .reconnect, "read, none: Open Settings (AC5b)")
        XCTAssertEqual(LiveShown.shown(sleep, connected: true, access: .read([:]), keepsReconnect: false), .nothing)
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .read(both), keepsReconnect: true), .cards([.steps]))
        XCTAssertEqual(LiveShown.shown(fitness, connected: true, access: .read(b), keepsReconnect: true), .nothing, "only sleep: Fitness hides (US-73 AC2)")
        XCTAssertEqual(LiveShown.shown(sleep, connected: true, access: .read(both), keepsReconnect: false), .cards([.sleep]))
    }
}
