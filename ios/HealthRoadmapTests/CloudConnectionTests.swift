import XCTest
@testable import HealthRoadmap

/// US-25 AC11m: CloudConnection's transition, cell by cell (every state by every event),
/// its status function, and random runs against a model of the files and the engine.
final class CloudConnectionTests: XCTestCase {
    private typealias C = CloudConnection

    private let t0 = Date(timeIntervalSince1970: 1_000)
    private let t1 = Date(timeIntervalSince1970: 2_000)
    private let p = SyncProblem(kind: .unreachable)
    private let full = SyncProblem(kind: .storageFull)
    private let view = HealthEngine.CloudView(record: "{}", erase: "e", session: 9)
    private let another = "Disconnect from Dropbox first, then connect Google Drive."
    private let otherAccount = "That is a different Dropbox account from the one this iPhone syncs with. To use it, disconnect first, then connect it."

    // The states each row starts from: attempt 4, a connection made at attempt 2.
    private let phone = C.phone(attempt: 4)
    private var closed: C { .closed(.init(provider: .dropbox, attempt: 4, connectedAt: 2)) }
    private var opening: C { .opening(.init(provider: .dropbox, attempt: 4, connectedAt: 2, firstConnect: false)) }
    private var open: C { .open(.init(provider: .dropbox, attempt: 4, connectedAt: 2, session: 7, save: .clean(t0))) }
    private let closing = C.closing(.init(provider: .dropbox, attempt: 4))

    private func trying(attempt: Int = 4, first: Bool = false, tries: Int = 1, edits: Int = 0, held: C.Held = .init()) -> C {
        .opening(.init(provider: .dropbox, attempt: attempt, connectedAt: 2, firstConnect: first, tries: tries, editsSince: edits, held: held))
    }

    private func openWith(_ save: C.Save, session: Int = 7) -> C {
        .open(.init(provider: .dropbox, attempt: 4, connectedAt: 2, session: session, save: save))
    }

    private func closedWith(_ problem: SyncProblem?, attempt: Int = 4, connectedAt: Int = 2) -> C {
        .closed(.init(provider: .dropbox, attempt: attempt, connectedAt: connectedAt, problem: problem))
    }

    private struct Row {
        let state: C
        let event: C.Event
        let next: C
        let effects: [C.Effect]
        let line: UInt
    }

    private func row(_ state: C, _ event: C.Event, _ next: C, _ effects: [C.Effect] = [], line: UInt = #line) -> Row {
        Row(state: state, event: event, next: next, effects: effects, line: line)
    }

    /// A row whose state does not change and which has no effect.
    private func drop(_ state: C, _ events: [C.Event], line: UInt = #line) -> [Row] {
        events.map { Row(state: state, event: $0, next: state, effects: [], line: line) }
    }

    private var rows: [Row] {
        var rows: [Row] = []
        // phone(4)
        rows += drop(phone, [.launched(nil), .launched(.dropbox), .signInStarted(.googleDrive), .keepFailed(attempt: 4, p, onFile: true),
                             .openStarted, .edited, .opened(attempt: 4, session: 9, at: t1), .openFailed(attempt: 4, p),
                             .news(session: 7, .saving, at: t1), .syncStarted, .syncEnded(session: 7, .done, at: t1),
                             .eraseEnded(session: 7, .done, at: t1), .disconnectStarted, .disconnectEnded(attempt: 4), .closeFailed(attempt: 4)])
        rows += [
            row(.phone(attempt: 0), .launched(nil), .phone(attempt: 0)),
            row(.phone(attempt: 0), .launched(.dropbox), closedWith(nil, attempt: 0, connectedAt: 0)),
            row(phone, .signInReturned(key: 4, provider: .dropbox, otherAccount: false),
                .opening(.init(provider: .dropbox, attempt: 5, connectedAt: 5, firstConnect: true)), [.keep, .open]),
            row(phone, .signInReturned(key: 4, provider: .dropbox, otherAccount: true),
                .opening(.init(provider: .dropbox, attempt: 5, connectedAt: 5, firstConnect: true)), [.keep, .open]),
            row(phone, .signInReturned(key: 3, provider: .dropbox, otherAccount: false), phone, [.cancel]), // S21
        ]

        // closed(Dropbox, 4)
        rows += drop(closed, [.launched(.dropbox), .signInStarted(.dropbox), .keepFailed(attempt: 4, p, onFile: true), .edited,
                              .opened(attempt: 4, session: 9, at: t1), .openFailed(attempt: 4, p), .news(session: 7, .synced, at: t1),
                              .syncStarted, .syncEnded(session: 7, .done, at: t1), .eraseEnded(session: 7, .done, at: t1),
                              .disconnectEnded(attempt: 4), .closeFailed(attempt: 4)])
        rows += [
            row(closed, .signInStarted(.googleDrive), closed, [.refuse(another)]), // AC11l
            row(closed, .signInReturned(key: 2, provider: .dropbox, otherAccount: false), trying(attempt: 5), [.keep, .open]),
            row(closed, .signInReturned(key: 2, provider: .googleDrive, otherAccount: false), closed, [.refuse(another)]),
            row(closed, .signInReturned(key: 1, provider: .dropbox, otherAccount: false), closed, [.cancel]),
            row(closed, .signInReturned(key: 2, provider: .dropbox, otherAccount: true), closed, [.refuse(otherAccount)]), // A6
            row(closedWith(p), .openStarted, trying(attempt: 5), [.open]),
            row(closed, .disconnectStarted, .closing(.init(provider: .dropbox, attempt: 5))),
        ]

        // opening(Dropbox, 4)
        rows += drop(opening, [.launched(.dropbox), .signInStarted(.dropbox), .keepFailed(attempt: 3, p, onFile: true), .openStarted,
                               .opened(attempt: 3, session: 9, at: t1), .openFailed(attempt: 3, p), .news(session: 9, .saving, at: t1),
                               .syncStarted, .syncEnded(session: 7, .done, at: t1), .eraseEnded(session: 7, .done, at: t1),
                               .disconnectEnded(attempt: 4), .closeFailed(attempt: 4)])
        let held = C.Held(news: [9: view], failures: [9: full])
        rows += [
            row(opening, .signInStarted(.googleDrive), opening, [.refuse(another)]), // AC11j
            // Owner's item 3: the open restarts under the new tokens.
            row(opening, .signInReturned(key: 2, provider: .dropbox, otherAccount: false), trying(attempt: 5), [.keep, .open]),
            row(trying(first: true), .signInReturned(key: 2, provider: .dropbox, otherAccount: false), trying(attempt: 5, first: true), [.keep, .open]),
            row(opening, .signInReturned(key: 2, provider: .googleDrive, otherAccount: false), opening, [.refuse(another)]),
            row(opening, .keepFailed(attempt: 4, p, onFile: true), closedWith(p), [.closeSession, .showPhone]),
            row(opening, .keepFailed(attempt: 4, p, onFile: false), .phone(attempt: 4), [.unkeep(.dropbox)]),
            row(opening, .edited, trying(edits: 1)),
            row(opening, .opened(attempt: 4, session: 9, at: t1), openWith(.clean(t1), session: 9), [.remember(.dropbox)]),
            row(trying(held: held), .opened(attempt: 4, session: 9, at: t1), openWith(.failed(full), session: 9), [.showCloud(view), .remember(.dropbox)]),
            row(trying(edits: 1), .opened(attempt: 4, session: 9, at: t1), trying(attempt: 5, tries: 2), [.open]),
            row(trying(first: true, edits: 1), .opened(attempt: 4, session: 9, at: t1), trying(attempt: 5, tries: 2), [.open]),
            row(trying(tries: 3, edits: 1), .opened(attempt: 4, session: 9, at: t1), closedWith(SyncProblem(kind: .busy)), [.closeSession]),
            row(opening, .openFailed(attempt: 4, p), closedWith(p)),
            row(opening, .news(session: 9, .failed(full), at: t1), trying(held: .init(failures: [9: full]))),
            row(trying(held: held), .news(session: 9, .synced, at: t1), trying(held: .init(news: [9: view]))),
            row(opening, .news(session: 9, .changed(view), at: t1), trying(held: .init(news: [9: view]))),
            row(opening, .disconnectStarted, .closing(.init(provider: .dropbox, attempt: 5))),
        ]

        // open(Dropbox, 4, session 7)
        rows += drop(open, [.launched(.dropbox), .signInStarted(.dropbox), .keepFailed(attempt: 3, p, onFile: true), .openStarted,
                            .opened(attempt: 4, session: 9, at: t1), .openFailed(attempt: 4, p), .news(session: 9, .failed(p), at: t1),
                            .news(session: 7, .other, at: t1), .syncEnded(session: 7, .waiting, at: t1), .syncEnded(session: 9, .done, at: t1),
                            .eraseEnded(session: 9, .done, at: t1), .disconnectEnded(attempt: 4), .closeFailed(attempt: 4)])
        rows += [
            row(open, .signInStarted(.googleDrive), open, [.refuse(another)]), // AC11l
            row(open, .signInReturned(key: 2, provider: .dropbox, otherAccount: false), trying(attempt: 5), [.keep, .showPhone, .open]),
            row(open, .signInReturned(key: 2, provider: .googleDrive, otherAccount: false), open, [.refuse(another)]),
            row(open, .keepFailed(attempt: 4, p, onFile: true), closedWith(p), [.closeSession, .showPhone]),
            row(open, .edited, openWith(.saving)),
            row(open, .news(session: 7, .saving, at: t1), openWith(.saving)),
            row(openWith(.saving), .news(session: 7, .saved, at: t1), openWith(.clean(t1))),
            row(openWith(.saving), .news(session: 7, .synced, at: t1), openWith(.clean(t1))),
            row(open, .news(session: 7, .failed(full), at: t1), openWith(.failed(full))),
            row(open, .news(session: 7, .changed(view), at: t1), open, [.showCloud(view)]),
            row(open, .syncStarted, openWith(.saving)),
            row(openWith(.saving), .syncEnded(session: 7, .done, at: t1), openWith(.clean(t1))),
            row(openWith(.saving), .syncEnded(session: 7, .failed(p), at: t1), openWith(.failed(p))),
            // Q2: the erase's own result decides; news mid-erase never does.
            row(openWith(.clean(t0)), .eraseEnded(session: 7, .failed(p), at: t1), openWith(.failed(p))),
            row(openWith(.saving), .eraseEnded(session: 7, .done, at: t1), openWith(.clean(t1))),
            row(openWith(.failed(full)), .eraseEnded(session: 7, .failed(p), at: t1), openWith(.failed(full))),
            row(open, .disconnectStarted, .closing(.init(provider: .dropbox, attempt: 5))),
        ]

        // closing(Dropbox, 4)
        rows += drop(closing, [.launched(.dropbox), .keepFailed(attempt: 4, p, onFile: true), .openStarted, .edited,
                               .opened(attempt: 3, session: 9, at: t1), .openFailed(attempt: 3, p), .news(session: 7, .synced, at: t1),
                               .syncStarted, .syncEnded(session: 7, .done, at: t1), .eraseEnded(session: 7, .done, at: t1),
                               .disconnectStarted, .disconnectEnded(attempt: 3), .closeFailed(attempt: 3)])
        rows += [
            row(closing, .signInStarted(.dropbox), closing, [.cancel]), // S22
            row(closing, .signInReturned(key: 4, provider: .dropbox, otherAccount: false), closing, [.cancel]),
            row(closing, .disconnectEnded(attempt: 4), .phone(attempt: 4)),
            row(closing, .closeFailed(attempt: 4), closedWith(nil, attempt: 4, connectedAt: 4), [.showPhone]),
        ]
        return rows
    }

    func testEveryCellOfTheTable_US25_AC11m() {
        for row in rows {
            let step = C.transition(row.state, row.event)
            XCTAssertEqual(step.next, row.next, "\(row.state) × \(row.event)", line: row.line)
            XCTAssertEqual(step.effects, row.effects, "\(row.state) × \(row.event)", line: row.line)
        }
        let covered = Set(rows.map { "\(Self.name(of: $0.state)) × \(Self.name(of: $0.event))" })
        let states = [phone, closed, opening, open, closing].map(Self.name(of:))
        let events: [C.Event] = [.launched(nil), .signInStarted(.dropbox), .signInReturned(key: 0, provider: .dropbox, otherAccount: false),
                                 .keepFailed(attempt: 0, p, onFile: true), .openStarted, .edited, .opened(attempt: 0, session: 0, at: t0),
                                 .openFailed(attempt: 0, p), .news(session: 0, .saving, at: t0), .syncStarted,
                                 .syncEnded(session: 0, .done, at: t0), .eraseEnded(session: 0, .done, at: t0), .disconnectStarted,
                                 .disconnectEnded(attempt: 0), .closeFailed(attempt: 0)]
        for state in states {
            for event in events.map(Self.name(of:)) {
                XCTAssertTrue(covered.contains("\(state) × \(event)"), "no row for \(state) × \(event)")
            }
        }
    }

    /// No default arm here either: a new case does not compile until the table names it.
    private static func name(of state: C) -> String {
        switch state {
        case .phone: "phone"
        case .closed: "closed"
        case .opening: "opening"
        case .open: "open"
        case .closing: "closing"
        }
    }

    private static func name(of event: C.Event) -> String {
        switch event {
        case .launched: "launched"
        case .signInStarted: "signInStarted"
        case .signInReturned: "signInReturned"
        case .keepFailed: "keepFailed"
        case .openStarted: "openStarted"
        case .edited: "edited"
        case .opened: "opened"
        case .openFailed: "openFailed"
        case .news: "news"
        case .syncStarted: "syncStarted"
        case .syncEnded: "syncEnded"
        case .eraseEnded: "eraseEnded"
        case .disconnectStarted: "disconnectStarted"
        case .disconnectEnded: "disconnectEnded"
        case .closeFailed: "closeFailed"
        }
    }

    // MARK: Status

    func testTheStatusOfEachState_US25_AC11m() {
        let cases: [(C, Bool, CloudSync.Status)] = [
            (phone, false, .onPhone),
            (phone, true, .onPhone),
            (closed, false, .connecting),
            (closedWith(p), true, .problem(p)),
            (opening, true, .connecting),
            (openWith(.clean(t0)), false, .synced(t0)),
            (openWith(.clean(t0)), true, .saving),
            (openWith(.saving), false, .saving),
            (openWith(.failed(full)), true, .problem(full)),
            (closing, true, .disconnecting),
        ]
        for (state, pending, status) in cases {
            XCTAssertEqual(C.status(state, pending: pending), status, "\(state), pending \(pending)")
        }
        XCTAssertEqual(SyncStatusText.headline(.disconnecting, provider: .dropbox), "Disconnecting…")
        XCTAssertEqual(SyncStatusText.disconnectFailed(.googleDrive), "Couldn't disconnect from Google Drive. Try again.")
    }

    // MARK: Random runs against a model

    /// The files, the tokens and the engine, as CloudSync's effects change them.
    private struct World {
        var state = C.phone(attempt: 0)
        var onFile: CloudProvider?
        var tokens: Set<CloudProvider> = []
        /// The engine's open session, and the attempt of the open it runs (only the newest runs).
        var engineSession: Int?
        var running: Int?
        var nextSession = 1
        var signIns: [(key: Int, provider: CloudProvider)] = []

        mutating func send(_ event: C.Event) -> [C.Effect] {
            let effects = take(event)
            run(effects)
            return effects
        }

        /// The transition alone: connect keeps the sign-in before it runs the rest.
        mutating func take(_ event: C.Event) -> [C.Effect] {
            let step = C.transition(state, event)
            state = step.next
            return step.effects
        }

        mutating func run(_ effects: [C.Effect]) {
            for effect in effects {
                switch effect {
                // cloudOpen closes the session it replaces; a close supersedes an open in flight.
                case .open: (engineSession, running) = (nil, state.attempt)
                case .closeSession: (engineSession, running) = (nil, nil)
                case .unkeep(let provider): tokens.remove(provider)
                case .refuse, .cancel, .keep, .showPhone, .showCloud, .remember: break
                }
            }
        }
    }

    /// SplitMix64, seeded: the same runs every time.
    private struct Seeded: RandomNumberGenerator {
        var state: UInt64
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }

    /// (a) the provider on file is the state's after every step, and tokens are kept only
    /// beside it; (b) only a sign-in whose attempt is current keeps anything; (c) at most one
    /// session is open, and it is the one shown: none a late open made is left behind.
    func testRandomRunsKeepTheFilesTheTokensAndTheEngineInStep_US25_AC11m() {
        var random = Seeded(state: 20_261_112)
        for run in 0..<1_500 {
            var world = World()
            let launched: CloudProvider? = Bool.random(using: &random) ? .dropbox : nil
            if let launched { (world.onFile, world.tokens) = (launched, [launched]) }
            _ = world.send(.launched(launched))
            for step in 0..<40 {
                let before = world.state
                act(&world, Int.random(in: 0..<12, using: &random), &random)
                let at = "run \(run) step \(step), from \(before) to \(world.state)"
                XCTAssertEqual(world.onFile, world.state.provider, "(a) \(at)")
                XCTAssertEqual(world.tokens, Set([world.onFile].compactMap { $0 }), "(a) tokens, \(at)")
                if let session = world.engineSession { XCTAssertEqual(world.state.shownSession, session, "(c) \(at)") }
                if world.state.shownSession != nil { XCTAssertEqual(world.state.shownSession, world.engineSession, "(c) shown, \(at)") }
            }
        }
    }

    private func act(_ world: inout World, _ choice: Int, _ random: inout Seeded) {
        let cloud: CloudProvider = Bool.random(using: &random) ? .dropbox : .googleDrive
        switch choice {
        case 0: // a sign-in begins
            if world.send(.signInStarted(cloud)).isEmpty { world.signIns.append((world.state.signInKey, cloud)) }
        case 1: // a sign-in returns, and its keep may fail
            guard !world.signIns.isEmpty else { return }
            let signIn = world.signIns.remove(at: Int.random(in: 0..<world.signIns.count, using: &random))
            let key = world.state.signInKey
            let effects = world.take(.signInReturned(key: signIn.key, provider: signIn.provider, otherAccount: false))
            guard effects.contains(.keep) else { return }
            XCTAssertEqual(signIn.key, key, "(b) a stale sign-in kept its tokens")
            if Int.random(in: 0..<5, using: &random) == 0 {
                _ = world.send(.keepFailed(attempt: world.state.attempt, SyncProblem(kind: .unreachable), onFile: world.onFile != nil))
            } else {
                world.tokens.insert(signIn.provider)
                world.onFile = signIn.provider
                world.run(effects)
            }
        case 2: _ = world.send(.openStarted)
        case 3: _ = world.send(.edited)
        case 4: // the engine's open lands or fails
            guard let attempt = world.running else { return }
            world.running = nil
            if Bool.random(using: &random) {
                world.engineSession = world.nextSession
                world.nextSession += 1
                _ = world.send(.opened(attempt: attempt, session: world.engineSession!, at: .now))
            } else {
                _ = world.send(.openFailed(attempt: attempt, SyncProblem(kind: .unreachable)))
            }
        case 5: // a late result from an attempt that ended: the engine superseded it
            let stale = world.state.attempt - Int.random(in: 1...3, using: &random)
            _ = world.send(Bool.random(using: &random) ? .opened(attempt: stale, session: 999, at: .now) : .openFailed(attempt: stale, SyncProblem(kind: .busy)))
        case 6: _ = world.send(.news(session: Int.random(in: 1...world.nextSession, using: &random), .failed(SyncProblem(kind: .storageFull)), at: .now))
        case 7: // Disconnect begins: cloudClose closes the session and supersedes an open
            _ = world.send(.disconnectStarted)
            if case .closing = world.state { (world.engineSession, world.running) = (nil, nil) }
        case 8: // the provider file goes, then the cleanup; or it stays and the cloud reopens
            guard case .closing(let closing) = world.state else { return }
            if Int.random(in: 0..<4, using: &random) == 0 {
                _ = world.send(.closeFailed(attempt: closing.attempt))
                _ = world.send(.openStarted)
            } else {
                world.onFile = nil
                world.tokens = []
                _ = world.send(.disconnectEnded(attempt: closing.attempt))
            }
        case 9: _ = world.send(.syncStarted)
        case 10: _ = world.send(.syncEnded(session: world.state.shownSession ?? 0, .done, at: .now))
        default: _ = world.send(.eraseEnded(session: world.state.shownSession ?? 0, .failed(SyncProblem(kind: .unreachable)), at: .now))
        }
    }
}
