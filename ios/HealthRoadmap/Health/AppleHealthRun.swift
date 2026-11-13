import Foundation

/// Apple Health's run state as one named mode (lead H27, US-72 AC10), changed only by
/// `Run.transition`. A pass runs only from `running`; a refresh asked for while one runs queues
/// one more (`running(queued: true)`), however many ask, and every caller returns once the pass
/// it waited for has ended. An erase disconnect during a pass leaves it `stopping`: it starts no
/// new pass, and the pass ends on `disconnected` however it ended (D1). A phone with no Health
/// stays `unavailable` whatever happens, an erase included (D3).
extension AppleHealthSync {
    enum Run: Equatable {
        /// This device has no Health database.
        case unavailable
        case disconnected
        /// No pass running; how the last one ended.
        case idle(Outcome)
        /// A pass runs; `queued`: a refresh asked for one more after it.
        case running(queued: Bool)
        /// An erase disconnected Health while a pass ran: it drains, and nothing starts after it.
        case stopping

        nonisolated static func transition(_ run: Run, _ event: RunEvent) -> (Run, RunEffect?) {
            switch (run, event) {
            // No Health on this phone: the section stays hidden whatever happens (D3).
            case (.unavailable, _): (run, nil)

            case (.idle, .trigger(connected: true)), (.disconnected, .trigger(connected: true)): (.running(queued: false), .pass)
            case (.idle, .trigger(connected: false)), (.disconnected, .trigger(connected: false)): (.disconnected, nil)
            // However many ask during a pass, one more runs after it.
            case (.running, .trigger): (.running(queued: true), .wait)
            // Only a genuine reconnect during an erase's drain queues a pass, after the drain.
            case (.stopping, .trigger(connected: true)): (.running(queued: true), .wait)
            case (.stopping, .trigger(connected: false)): (run, nil)

            case (.running(queued: false), .passEnded(.done(let outcome))): (.idle(outcome), .release)
            // An erase landed meanwhile (`moved`): the next pass meets it at the gate.
            case (.running(queued: true), .passEnded(.done)), (.running, .passEnded(.moved)): (.running(queued: false), .pass)
            // A locked phone or a failure drops the queued run: the next unlock or refresh retries.
            case (.running, .passEnded(.locked)): (.idle(.waitingForUnlock), .release)
            case (.running, .passEnded(.failed(let message))): (.idle(.failed(message)), .release)
            // After an erase disconnect, however the pass ended (D1).
            case (.stopping, .passEnded): (.disconnected, .release)
            case (.idle, .passEnded), (.disconnected, .passEnded): (run, nil)

            case (.running, .gateClosed), (.stopping, .gateClosed): (.disconnected, .release)
            case (.idle, .gateClosed), (.disconnected, .gateClosed): (run, nil)

            case (_, .disconnect(wasConnected: false)): (run, nil)
            case (.idle, .disconnect): (.disconnected, nil)
            case (.running, .disconnect): (.stopping, nil)
            case (.stopping, .disconnect), (.disconnected, .disconnect): (run, nil)

            // A running pass owns what Settings shows (D2 (a)).
            case (.running, .connectFailed): (run, nil)
            case (_, .connectFailed(let message)): (.idle(.failed(message)), nil)
            }
        }

        /// What Settings shows (`AppleHealthSection`). Before the first pass after launch: working.
        var status: Status {
            switch self {
            case .unavailable: .unavailable
            case .disconnected, .stopping: .notConnected
            case .running, .idle(.notYet): .working
            case .idle(.upToDate(let date)): .upToDate(date)
            case .idle(.notAllowed): .notAllowed
            case .idle(.waitingForUnlock): .waitingForUnlock
            case .idle(.failed(let message)): .failed(message)
            }
        }

        /// A pass is in flight: an erase's Health delete waits for it (`drained`).
        var passing: Bool {
            switch self {
            case .running, .stopping: true
            case .unavailable, .disconnected, .idle: false
            }
        }
    }

    enum Outcome: Equatable {
        case notYet
        case upToDate(Date)
        /// After "Don't Allow" (AC15b): nothing may be written and nothing has come in.
        case notAllowed
        /// Health is encrypted while the phone is locked; the next unlock retries.
        case waitingForUnlock
        case failed(String)
    }

    enum RunEvent: Equatable {
        /// A refresh asked for, with Apple Health connected on this phone or not (`memory.connected`).
        case trigger(connected: Bool)
        case passEnded(PassEnd)
        /// The pass's erase gate disconnected Health, or found it disconnected.
        case gateClosed
        /// An erase disconnect; `wasConnected`: Health was connected as it began.
        case disconnect(wasConnected: Bool)
        /// Connect's permission sheet failed.
        case connectFailed(String)
    }

    enum PassEnd: Equatable {
        case done(Outcome)
        /// The pass's mark or generation no longer held (an erase landed since it began).
        case moved
        case locked
        case failed(String)
    }

    enum RunEffect: Equatable {
        /// Run one pass.
        case pass
        /// Wait for the running pass, and the one queued after it, to end.
        case wait
        /// The pass ended: let every caller waiting on it go.
        case release
    }
}
