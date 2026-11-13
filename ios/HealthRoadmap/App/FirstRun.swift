import Foundation

/// What covers the tabs on a first run (US-25 AC10, US-54; iPhone survey S9): one named state,
/// changed only by `transition`, which names the effect RootView runs. Decided once at launch,
/// so the cover stays until the person finishes even as answers fill the record. Finishing
/// runs once: a second finish, from any source, does nothing (S9). FirstRunTests has the table.
enum Cover: Equatable {
    /// Before launch has read the keys: nothing covers the tabs yet.
    case deciding
    case welcome
    case questions(Run)
    /// No cover: the tabs.
    case none

    /// Why the questions run. `onlyMissing`: after "I already use Health Roadmap", only what the
    /// cloud record lacks (Codex re-check R1). `afterErase`: after "Delete all my data", the record
    /// keeps the units the erase kept, so the phone's region never overrides them (Codex R1).
    enum Run: Equatable { case fresh, onlyMissing, afterErase }

    /// The keys as launch read them, once (FirstRunKeys.launch).
    struct Launch: Equatable {
        var welcomed = false
        var onboarded = false
        /// Not finished, with a record that lacks sex, birth year or height, or a run already begun.
        var needsQuestions = false
        /// The record was erased on another device since its count was taken (US-54 AC7).
        var erasedElsewhere = false
        var run = Run.fresh
    }

    enum Event: Equatable {
        case launched(Launch)
        /// The welcome screen's Start; `needs`: the record needs the questions, nil while it is unread.
        case started(needs: Bool?)
        /// The welcome screen connected a cloud that holds the person's record.
        case connected(needs: Bool?)
        /// The questions ended, or there was nothing to ask them with.
        case finished
        /// "Delete all my data", here or on another device.
        case erased
    }

    enum Effect: Equatable {
        /// The questions are done: count the record, the tour starts (RootView.finished).
        case finish
        /// The questions come back after an erase, not the welcome screen (US-54 AC7): the
        /// person is already in, and a connected cloud stays connected.
        case startOver
    }

    /// The welcome screen or the questions are on screen.
    var shown: Bool {
        switch self {
        case .welcome, .questions: true
        case .deciding, .none: false
        }
    }

    static func transition(_ cover: Cover, _ event: Event) -> (Cover, Effect?) {
        switch cover {
        case .deciding:
            switch event {
            // A launch mid-questions resumes them (AC7); a skipped user lands in needsQuestions.
            case .launched(let l) where l.welcomed && l.onboarded && l.erasedElsewhere: return (.questions(.afterErase), .startOver)
            case .launched(let l) where !l.welcomed: return (.welcome, nil)
            case .launched(let l): return (l.needsQuestions ? .questions(l.run) : .none, nil)
            case .started, .connected, .finished, .erased: return (cover, nil)
            }
        case .welcome:
            switch event {
            // An unread record is not a full one: the cover closes unfinished, so `onboarded` stays
            // false and the next launch decides again (S42). The questions would finish at once.
            case .started(nil), .connected(nil): return (.none, nil)
            // A record that needs nothing finishes here, so its saves count toward the backup offer (S34).
            case .started(let needs?): return needs ? (.questions(.fresh), nil) : (.none, .finish)
            case .connected(let needs?): return needs ? (.questions(.onlyMissing), nil) : (.none, .finish)
            case .launched, .finished, .erased: return (cover, nil)
            }
        case .questions:
            switch event {
            case .finished: return (.none, .finish)
            case .launched, .started, .connected, .erased: return (cover, nil)
            }
        case .none:
            switch event {
            case .erased: return (.questions(.afterErase), .startOver)
            // A late or second finish never finishes again (S9).
            case .launched, .started, .connected, .finished: return (cover, nil)
            }
        }
    }
}

/// The backup offer after the person's third save (US-57 AC8; iPhone survey S16): idle, the
/// prompt on screen (`backUp`: its Back up was tapped), or Sync open after it. Back up opens
/// Sync only once the prompt has gone, so two sheets never overlap.
enum Offer: Hashable {
    case idle
    case offering(backUp: Bool)
    case sync

    enum Event: Hashable {
        /// The offer is due at a quiet moment (RootView.offerCloud's guards passed).
        case due
        case backUpTapped
        case promptClosed
        case syncClosed
    }

    /// The prompt is on screen: not once Back up has closed it.
    var prompting: Bool { self == .offering(backUp: false) }

    static func transition(_ offer: Offer, _ event: Event) -> Offer {
        switch (offer, event) {
        case (.idle, .due): .offering(backUp: false)
        case (.offering, .backUpTapped): .offering(backUp: true)
        case (.offering(let backUp), .promptClosed): backUp ? .sync : .idle
        case (.sync, .syncClosed): .idle
        case (.idle, .backUpTapped), (.idle, .promptClosed), (.idle, .syncClosed),
             (.offering, .due), (.offering, .syncClosed),
             (.sync, .due), (.sync, .backUpTapped), (.sync, .promptClosed):
            offer
        }
    }
}

/// The first run's keys: settings, not health data. The same names as ever, so an update or a
/// downgrade decides as before. `persist` is the one writer of the cover's keys; the record's
/// erase count and source (`onboardedEpoch`, `onboardedSource`) stay with RootView.takeCount.
struct FirstRunKeys {
    var defaults: UserDefaults = .app

    /// Set once the welcome screen is done.
    var welcomed: Bool { defaults.bool(forKey: "welcomed") }
    /// Set once the new-user questions are done (US-54); never shown again after.
    var onboarded: Bool { defaults.bool(forKey: "onboarded") }

    /// A phone that has not finished the questions, with a record that lacks sex, birth year or
    /// height (`needsFlow`), or one that began them (quit at weight resumes there; review R2, AC7).
    /// OnboardingView sets `onboardingHealthAsked` when the first question screen is reached.
    func needsQuestions(needsFlow: Bool) -> Bool {
        !onboarded && (defaults.bool(forKey: "onboardingHealthAsked") || needsFlow)
    }

    func launch(needsFlow: Bool, erasedElsewhere: Bool) -> Cover.Launch {
        let run: Cover.Run = defaults.bool(forKey: "onboardingOnlyMissing") ? .onlyMissing
            : defaults.bool(forKey: "onboardingAfterErase") ? .afterErase : .fresh
        return .init(welcomed: welcomed, onboarded: onboarded, needsQuestions: needsQuestions(needsFlow: needsFlow),
                     erasedElsewhere: erasedElsewhere, run: run)
    }

    /// Writes what a transition came to. Past the welcome screen it is done; a run writes why it
    /// runs, so a relaunch resumes it the same way. Finishing forgets the run (S9 fault 2); an erase
    /// starts it again. Only finish and startOver touch what OnboardingView also writes, and its
    /// last write lands before it calls finish.
    func persist(_ cover: Cover, _ effect: Cover.Effect?) {
        switch cover {
        case .deciding, .welcome: break
        case .questions(let run):
            defaults.set(true, forKey: "welcomed")
            defaults.set(run == .onlyMissing, forKey: "onboardingOnlyMissing")
            defaults.set(run == .afterErase, forKey: "onboardingAfterErase")
        case .none: defaults.set(true, forKey: "welcomed")
        }
        guard let effect else { return }
        defaults.set(effect == .finish, forKey: "onboarded")
        defaults.set(false, forKey: "onboardingHealthAsked")
        // Which questions Apple Health answered, by name (US-54 AC3b): forgotten with the run.
        defaults.set("", forKey: "onboardingFromHealth")
        if effect == .finish {
            defaults.set(false, forKey: "onboardingOnlyMissing")
            defaults.set(false, forKey: "onboardingAfterErase")
        }
    }
}
