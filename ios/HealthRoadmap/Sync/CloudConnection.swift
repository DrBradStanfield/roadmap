import Foundation

/// CloudSync's connection, as one state (survey S3, US-25 AC11m). Every case but `phone`
/// names the cloud it is about, so "opening for A while connected to B" cannot be written.
/// Every async result names the attempt it began under, and the transition drops one whose
/// attempt has ended. `transition` is pure and total: a switch on the event, then on the
/// state, with no default arm, so a new case does not compile until each cell is decided
/// (CloudConnectionTests names every cell). The state is what a relaunch would read from disk.
enum CloudConnection: Equatable {
    /// No cloud: the record is the phone's file.
    case phone(attempt: Int)
    /// A cloud is connected and no session is open: before an open, or after one failed.
    case closed(Closed)
    case opening(Opening)
    case open(Open)
    /// Disconnect is copying the record down and removing the cloud's files.
    case closing(Closing)

    struct Closed: Equatable {
        var provider: CloudProvider
        var attempt: Int
        /// The attempt this connection began at: a sign-in begun before it is dropped.
        var connectedAt: Int
        var problem: SyncProblem?
    }

    struct Opening: Equatable {
        var provider: CloudProvider
        var attempt: Int
        var connectedAt: Int
        /// Merge the phone's record up into the cloud's first (health-core's lift).
        var firstConnect: Bool
        /// This try, 1 to 3: an edit landing while it ran makes the open go round again,
        /// merging the phone's file in (`mergePhone`).
        var tries = 1
        var editsSince = 0
        var held = Held()
    }

    struct Open: Equatable {
        var provider: CloudProvider
        var attempt: Int
        var connectedAt: Int
        /// The engine session the app shows and sends edits to.
        var session: Int
        var save: Save
    }

    struct Closing: Equatable {
        var provider: CloudProvider
        var attempt: Int
    }

    enum Save: Equatable {
        case clean(Date)
        case saving
        case failed(SyncProblem)
    }

    /// News a session sent before the handover showed it: the newest record each session
    /// brought in, and its last failure, shown once that session is (adversary R2, R4).
    struct Held: Equatable {
        var news: [Int: HealthEngine.CloudView] = [:]
        var failures: [Int: SyncProblem] = [:]
    }

    /// How a Sync now or an erase ended.
    enum Outcome: Equatable {
        case done
        /// The save has not landed yet: its own news says when.
        case waiting
        case failed(SyncProblem)
    }

    enum Event: Equatable {
        case launched(CloudProvider?)
        case signInStarted(CloudProvider)
        /// `key`: `signInKey` when the sign-in began. `otherAccount`: the account on file is
        /// not the one signed in (review A6).
        case signInReturned(key: Int, provider: CloudProvider, otherAccount: Bool)
        /// Keeping a sign-in threw. `onFile`: a provider file is there after the failed keep
        /// removed what it wrote, so a relaunch would read a connected cloud.
        case keepFailed(attempt: Int, SyncProblem, onFile: Bool)
        case openStarted
        case edited
        case opened(attempt: Int, session: Int, at: Date)
        case openFailed(attempt: Int, SyncProblem)
        case news(session: Int, HealthEngine.CloudNews, at: Date)
        /// Sync now or an erase began a save on the open session.
        case syncStarted
        case syncEnded(session: Int, Outcome, at: Date)
        case eraseEnded(session: Int, Outcome, at: Date)
        case disconnectStarted
        /// The provider file is gone: the Disconnect happened.
        case disconnectEnded(attempt: Int)
        /// The provider file stayed after a retry: the Disconnect did not happen.
        case closeFailed(attempt: Int)
    }

    /// What CloudSync does after a step, in order.
    enum Effect: Equatable {
        /// connect throws these words; nothing changed.
        case refuse(String)
        /// connect throws `.cancelled`: the sign-in is dropped silently, nothing kept.
        case cancel
        /// Keep the sign-in: tokens first, the provider file last.
        case keep
        /// Remove what a first connect's failed keep wrote: the tokens and the account files.
        case unkeep
        /// The screen falls back to the phone's file, where edits wait marked pending.
        case showPhone
        /// Draw a record the shown session brought in.
        case showCloud(HealthEngine.CloudView)
        /// The record was synced with this cloud (review A3).
        case remember(CloudProvider)
        /// Run the open the state names, if the connection is still at this attempt: an effect
        /// runs after the step that decided it, and a later step may have moved on (review R1).
        case open(attempt: Int)
        /// Close the engine's session without a copy down, if still at this attempt.
        case closeSession(attempt: Int)
    }

    struct Step: Equatable {
        var next: CloudConnection
        var effects: [Effect] = []
    }

    // MARK: Read from the state

    var provider: CloudProvider? {
        switch self {
        case .phone: nil
        case .closed(let state): state.provider
        case .opening(let state): state.provider
        case .open(let state): state.provider
        case .closing(let state): state.provider
        }
    }

    var attempt: Int {
        switch self {
        case .phone(let attempt): attempt
        case .closed(let state): state.attempt
        case .opening(let state): state.attempt
        case .open(let state): state.attempt
        case .closing(let state): state.attempt
        }
    }

    /// The open session; nil when none is shown.
    var shownSession: Int? {
        if case .open(let state) = self { state.session } else { nil }
    }

    /// What a sign-in begun now must find when it returns: the phone's attempt, or the
    /// connection's. A reopen keeps it; a Disconnect or another connect moves it (AC11l).
    var signInKey: Int {
        switch self {
        case .phone(let attempt): attempt
        case .closed(let state): state.connectedAt
        case .opening(let state): state.connectedAt
        case .open(let state): state.connectedAt
        case .closing(let state): state.attempt
        }
    }

    /// The Sync screen's status: the one place it is worked out (owner, web PR 1323).
    /// `pending`: the phone holds changes the cloud lacks. The marker is set before every
    /// edit and cleared only once a save has landed, so it is the session's unsaved state too
    /// (re-check R3): "Synced" shows only when it is clear. A failure outranks it.
    static func status(_ connection: CloudConnection, pending: Bool) -> CloudSync.Status {
        switch connection {
        case .phone: .onPhone
        case .closed(let state): state.problem.map(CloudSync.Status.problem) ?? .connecting
        case .opening: .connecting
        case .open(let state):
            switch state.save {
            case .failed(let problem): .problem(problem)
            case .saving: .saving
            case .clean(let when): pending ? .saving : .synced(when)
            }
        case .closing: .disconnecting
        }
    }

    // MARK: The transition

    static func transition(_ state: CloudConnection, _ event: Event) -> Step {
        let stay = Step(next: state)
        switch event {
        case .launched(let provider):
            switch state {
            case .phone(attempt: 0): return Step(next: provider.map { .closed(Closed(provider: $0, attempt: 0, connectedAt: 0)) } ?? state)
            // Sent once, by init: any other state means it already ran.
            case .phone, .closed, .opening, .open, .closing: return stay
            }

        case .signInStarted(let provider):
            switch state {
            case .phone: return stay
            case .closed, .opening, .open: return state.provider == provider ? stay : refuseAnother(state, provider)
            // No Connect row shows while closing (S22); one begun anyway is dropped.
            case .closing: return Step(next: state, effects: [.cancel])
            }

        case let .signInReturned(key, provider, otherAccount):
            switch state {
            case .phone(let attempt):
                guard key == attempt else { return Step(next: state, effects: [.cancel]) }
                return Step(next: .opening(Opening(provider: provider, attempt: attempt + 1, connectedAt: attempt + 1, firstConnect: true)),
                            effects: [.keep, .open(attempt: attempt + 1)])
            case .closed(let now):
                if let refused = refuse(state, key: key, provider: provider, otherAccount: otherAccount) { return refused }
                return Step(next: .opening(Opening(provider: now.provider, attempt: now.attempt + 1, connectedAt: now.connectedAt, firstConnect: false)),
                            effects: [.keep, .open(attempt: now.attempt + 1)])
            // The open in flight may have asked with the old grant and would fail asking for a
            // second sign-in: it restarts under the new tokens (owner, design item 3; AC11j).
            case .opening(let now):
                if let refused = refuse(state, key: key, provider: provider, otherAccount: otherAccount) { return refused }
                return Step(next: .opening(Opening(provider: now.provider, attempt: now.attempt + 1, connectedAt: now.connectedAt, firstConnect: now.firstConnect)),
                            effects: [.keep, .open(attempt: now.attempt + 1)])
            case .open(let now):
                if let refused = refuse(state, key: key, provider: provider, otherAccount: otherAccount) { return refused }
                return Step(next: .opening(Opening(provider: now.provider, attempt: now.attempt + 1, connectedAt: now.connectedAt, firstConnect: false)),
                            effects: [.keep, .showPhone, .open(attempt: now.attempt + 1)])
            case .closing: return Step(next: state, effects: [.cancel])
            }

        case let .keepFailed(attempt, problem, onFile):
            switch state {
            case .opening, .open:
                guard state.attempt == attempt else { return stay }
                return keepFailed(state.provider!, attempt: attempt, connectedAt: state.signInKey, problem, onFile: onFile)
            case .phone, .closed, .closing: return stay
            }

        case .openStarted:
            switch state {
            case .closed(let now):
                return Step(next: .opening(Opening(provider: now.provider, attempt: now.attempt + 1, connectedAt: now.connectedAt, firstConnect: false)),
                            effects: [.open(attempt: now.attempt + 1)])
            // Opening: single flight, the open in flight is joined. Open: a foreground re-reads,
            // it never reopens (pinned by testForegroundWithASessionReReadsWithoutReopening).
            case .phone, .opening, .open, .closing: return stay
            }

        case .edited:
            switch state {
            case .opening(var now):
                now.editsSince += 1
                return Step(next: .opening(now))
            case .open(var now):
                now.save = .saving
                return Step(next: .open(now))
            // Closed: the edit waits on the phone, marked pending. Closing: the engine refuses it (Q1).
            case .phone, .closed, .closing: return stay
            }

        case let .opened(attempt, session, at):
            switch state {
            case .opening(let now) where now.attempt == attempt:
                return opened(now, session: session, at: at)
            // A late open: dropped. The engine has closed its session already: a newer open
            // or a close supersedes it (ios/engine/cloud.ts cloudOpen, cloudClose).
            case .phone, .closed, .opening, .open, .closing: return stay
            }

        case let .openFailed(attempt, problem):
            switch state {
            case .opening(let now) where now.attempt == attempt:
                return Step(next: .closed(Closed(provider: now.provider, attempt: attempt, connectedAt: now.connectedAt, problem: problem)))
            case .phone, .closed, .opening, .open, .closing: return stay
            }

        case let .news(session, news, at):
            switch state {
            case .opening(var now):
                switch news {
                case .failed(let problem): now.held.failures[session] = problem
                case .saved, .synced: now.held.failures[session] = nil
                case .changed(let view): now.held.news[session] = view
                case .saving, .other: return stay
                }
                return Step(next: .opening(now))
            case .open(var now) where now.session == session:
                switch news {
                case .saving: now.save = .saving
                // A write landed or the marker cleared: the pending marker decides the words.
                case .saved, .synced: now.save = .clean(at)
                case .failed(let problem): now.save = .failed(problem)
                case .changed(let view): return Step(next: state, effects: [.showCloud(view)])
                case .other: return stay
                }
                return Step(next: .open(now))
            case .phone, .closed, .open, .closing: return stay
            }

        case .syncStarted:
            switch state {
            case .open(var now):
                now.save = .saving
                return Step(next: .open(now))
            case .phone, .closed, .opening, .closing: return stay
            }

        case let .syncEnded(session, outcome, at):
            switch state {
            case .open(var now) where now.session == session:
                switch outcome {
                case .done: now.save = .clean(at)
                case .waiting: return stay
                case .failed(let problem): now.save = .failed(problem)
                }
                return Step(next: .open(now))
            case .phone, .closed, .opening, .open, .closing: return stay
            }

        case let .eraseEnded(session, outcome, at):
            switch state {
            // The erase's own result decides, never news that landed meanwhile (Q2); a failure
            // the save loop already named keeps its words.
            case .open(var now) where now.session == session:
                switch (outcome, now.save) {
                case (.done, _): now.save = .clean(at)
                case (.waiting, _), (.failed, .failed): return stay
                case (.failed(let problem), .clean), (.failed(let problem), .saving): now.save = .failed(problem)
                }
                return Step(next: .open(now))
            case .phone, .closed, .opening, .open, .closing: return stay
            }

        case .disconnectStarted:
            switch state {
            case .closed, .opening, .open:
                return Step(next: .closing(Closing(provider: state.provider!, attempt: state.attempt + 1)))
            // A Disconnect already closing: this one is dropped, and closes nothing (Codex C1).
            case .closing: return Step(next: state, effects: [.cancel])
            case .phone: return stay
            }

        case .disconnectEnded(let attempt):
            switch state {
            case .closing(let now) where now.attempt == attempt: return Step(next: .phone(attempt: attempt))
            case .phone, .closed, .opening, .open, .closing: return stay
            }

        case .closeFailed(let attempt):
            switch state {
            // Nothing was removed: connected as before, as a relaunch reads it. A sign-in begun
            // before the Disconnect is still dropped (a new `connectedAt`).
            case .closing(let now) where now.attempt == attempt:
                return Step(next: .closed(Closed(provider: now.provider, attempt: attempt, connectedAt: attempt)), effects: [.showPhone])
            case .phone, .closed, .opening, .open, .closing: return stay
            }
        }
    }

    // MARK: Cells shared by several states

    /// One cloud at a time (US-25 AC11l): the words name both clouds.
    private static func refuseAnother(_ state: CloudConnection, _ provider: CloudProvider) -> Step {
        let current = state.provider!
        return Step(next: state, effects: [.refuse("Disconnect from \(current.label) first, then connect \(provider.label).")])
    }

    /// A sign-in returning to a connected cloud: another cloud is refused with words, one
    /// begun under an older connection is dropped, and another account is refused (A6).
    private static func refuse(_ state: CloudConnection, key: Int, provider: CloudProvider, otherAccount: Bool) -> Step? {
        if key != state.signInKey {
            // Begun on the phone just before this connection was made, for another cloud: the
            // backstop refuses it with words (AC11l). Begun under a connection a Disconnect
            // ended: dropped silently, whatever cloud is connected now (Codex C3).
            if key == state.signInKey - 1, state.provider != provider { return refuseAnother(state, provider) }
            return Step(next: state, effects: [.cancel])
        }
        if state.provider != provider { return refuseAnother(state, provider) }
        if otherAccount {
            return Step(next: state, effects: [.refuse("That is a different \(provider.label) account from the one this iPhone syncs with. To use it, disconnect first, then connect it.")])
        }
        return nil
    }

    /// Nothing is half-kept: a first connect goes back to the phone with what it kept removed;
    /// a cloud already on file stays connected, closed, with no session behind the screen.
    private static func keepFailed(_ provider: CloudProvider, attempt: Int, connectedAt: Int, _ problem: SyncProblem, onFile: Bool) -> Step {
        guard onFile else { return Step(next: .phone(attempt: attempt), effects: [.unkeep]) }
        return Step(next: .closed(Closed(provider: provider, attempt: attempt, connectedAt: connectedAt, problem: problem)),
                    effects: [.closeSession(attempt: attempt), .showPhone])
    }

    /// The handover: shown when no edit landed while the open ran, with what the session held.
    /// Otherwise the open goes round again under a new attempt, three tries in all, then busy (F3).
    private static func opened(_ now: Opening, session: Int, at: Date) -> Step {
        if now.editsSince == 0 {
            let save = now.held.failures[session].map { Save.failed($0) } ?? .clean(at)
            let open = Open(provider: now.provider, attempt: now.attempt, connectedAt: now.connectedAt, session: session, save: save)
            var effects: [Effect] = []
            if let held = now.held.news[session] { effects.append(.showCloud(held)) }
            effects.append(.remember(now.provider))
            return Step(next: .open(open), effects: effects)
        }
        guard now.tries < 3 else {
            // Edits kept arriving: close the last try's session, so nothing polls behind the
            // phone's record; the next foreground tries again.
            return Step(next: .closed(Closed(provider: now.provider, attempt: now.attempt, connectedAt: now.connectedAt, problem: SyncProblem(kind: .busy))),
                        effects: [.closeSession(attempt: now.attempt)])
        }
        var again = now
        again.attempt += 1
        again.tries += 1
        again.editsSince = 0
        again.firstConnect = false
        return Step(next: .opening(again), effects: [.open(attempt: again.attempt)])
    }
}
