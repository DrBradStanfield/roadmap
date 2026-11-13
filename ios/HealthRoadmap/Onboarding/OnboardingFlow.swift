import Foundation

/// The new-user flow's one named state (US-54 AC5, iPhone survey S6): starting while
/// begin() reads the record, connecting while Apple Health answers Allow, a page with
/// its save, or finished with the last page still drawn. Changed only by `transition`, which names the effects the
/// view runs (OnboardingView+Flow.swift); OnboardingFlowTests has the table.
///
/// A page's save is the sheets' own machine (`SheetSave`), so a tap claims it in the same
/// turn and a second tap waits (S6 bug E). "Replace it" carries today's row and the weight
/// typed, already in the record's units, so nothing is read again, and it is taken from
/// asking or declined, in whichever order SwiftUI dismisses the dialog (bug B). An answer
/// it cannot write says so (bug C). A second Allow starts no second connect, and nothing
/// finishes twice (bugs D, E). An event a mode does not list leaves it as it is.
@MainActor
enum OnboardingFlow {
    /// The page shown. `fromSummary`: opened from the summary's Edit, so its answer returns there (AC3b).
    struct Page: Equatable {
        var step: OnboardingStep
        var fromSummary = false
    }

    /// Today's weight row a typed weight would replace, and that weight in the record's units (AC5).
    struct Replace: SheetHeld {
        let id: String
        let value: Double
        var isEmpty: Bool { id.isEmpty }
    }

    typealias Save = SheetSave.State<Replace>

    enum Mode: Equatable {
        case starting
        case connecting
        case page(Page, Save)
        /// Done, holding the last page, so the cover slides down with it drawn (S6 review F1);
        /// nil when there was none (an unreadable record).
        case finished(Page?)

        /// The step drawn: the Apple Health page while connecting, the last page once finished,
        /// none while starting.
        var step: OnboardingStep? { page?.step }
        /// The page drawn, its Back included; once finished, the last one, whose taps change nothing.
        var page: Page? {
            switch self {
            case .starting: nil
            case .connecting: Page(step: .health)
            case .page(let page, _), .finished(let page?): page
            case .finished(nil): nil
            }
        }
        var save: Save? { if case .page(_, let save) = self { save } else { nil } }
        /// The screen's pin is held: taken when the first page shows, given back on finishing.
        var pinned: Bool {
            switch self {
            case .connecting, .page: true
            case .starting, .finished: false
            }
        }
    }

    enum Event {
        /// begin() read the record: the first page, or nil when there is nothing to ask
        /// (an unreadable record: My data says why, review R13).
        case began(Page?)
        case allowTapped
        /// Apple Health answered: the step after its page, nil when there is none.
        case connected(next: OnboardingStep?)
        /// Continue, or a sex choice.
        case tapped
        /// What a save or a replace came to, and the step after this one, nil when there is none.
        case landed(Landing, next: OnboardingStep?)
        /// "Replace it", carrying what its dialog asked about.
        case confirmed(Replace)
        case declined
        /// The person typed or switched units: the engine's words no longer fit.
        case wordsStale
        /// Back, or a summary line's Edit.
        case moved(Page)
        /// After a restart: the first page for the record now shown; nil when it cannot be read.
        case replanned(Page?)
        /// The summary's Continue.
        case reviewAccepted
    }

    enum Effect: Equatable {
        case pin, repin, unpin, connect, finish
        /// The record moved under the page: take it, then plan the flow again from it (US-54 AC5d).
        case restart
        case save(OnboardingStep)
        case replace(Replace)
    }

    static func transition(_ mode: Mode, _ event: Event) -> (Mode, [Effect]) {
        switch mode {
        case .starting:
            switch event {
            case .began(let page?): return (.page(page, .editing(message: nil)), [.pin])
            // Never pinned, so nothing to give back.
            case .began(nil): return (.finished(nil), [.finish])
            case .allowTapped, .connected, .tapped, .landed, .confirmed, .declined, .wordsStale, .moved, .replanned, .reviewAccepted:
                return (mode, [])
            }
        case .connecting:
            switch event {
            case .connected(let next): return advance(from: Page(step: .health), next: next)
            // A second tap on Allow starts no second connect (bug D).
            case .began, .allowTapped, .tapped, .landed, .confirmed, .declined, .wordsStale, .moved, .replanned, .reviewAccepted:
                return (mode, [])
            }
        case .page(let page, let save):
            switch event {
            case .began, .connected:
                return (mode, [])
            case .allowTapped:
                return page.step == .health ? (.connecting, [.connect]) : (mode, [])
            case .tapped:
                guard OnboardingStep.questions.contains(page.step) else { return (mode, []) }
                return claim(page, save, .tapped, .save(page.step))
            case .confirmed(let replace):
                return claim(page, save, .confirmed(replace), .replace(replace))
            case .declined:
                return (.page(page, SheetSave.transition(save, .declined)), [])
            case .wordsStale:
                return (.page(page, SheetSave.transition(save, .wordsStale)), [])
            case .landed(let landing, let next):
                guard save == .saving else { return (mode, []) }
                switch landing {
                case .advance: return advance(from: page, next: next)
                // The record may have moved on (an erase, a unit change elsewhere): the next
                // try is checked against the record now shown.
                case .words(let words): return (.page(page, .editing(message: words)), [.repin])
                // Nothing reached the engine: the pin stays (US-25 AC11g, S6 review F2).
                case .unwritten(let words): return (.page(page, .editing(message: words)), [])
                case .askReplace(let replace): return (.page(page, .asking(replace)), [])
                // The record moved under the page: it waits, words kept, while the flow is planned
                // again from the record now shown, so no tap saves into a record it never showed and
                // a page with no Back is never refused for good.
                case .restart(let words): return (.page(page, .findingRows(words: words)), [.restart])
                }
            case .replanned(let to):
                guard case .findingRows(let words) = save else { return (mode, []) }
                guard let to else { return (.finished(page), [.unpin, .finish]) }
                return (.page(to, .editing(message: words)), [])
            case .moved(let to):
                return save.busy ? (mode, []) : (.page(to, .editing(message: nil)), [.repin])
            case .reviewAccepted:
                return page.step == .review ? (.finished(page), [.unpin, .finish]) : (mode, [])
            }
        case .finished:
            switch event {
            // A late connect or a second Continue never finishes again (bugs D, E).
            case .began, .allowTapped, .connected, .tapped, .landed, .confirmed, .declined, .wordsStale, .moved, .replanned, .reviewAccepted:
                return (mode, [])
            }
        }
    }

    /// The next page: back to the summary for an answer opened from it (AC3b), else the next
    /// step, else done.
    private static func advance(from page: Page, next: OnboardingStep?) -> (Mode, [Effect]) {
        if page.fromSummary { return (.page(Page(step: .review), .editing(message: nil)), [.repin]) }
        guard let next else { return (.finished(page), [.unpin, .finish]) }
        return (.page(Page(step: next), .editing(message: nil)), [.repin])
    }

    /// The save's own machine moves; `effect` runs only when this event moved it into saving.
    private static func claim(_ page: Page, _ save: Save, _ event: SheetSave.Event<Replace>, _ effect: Effect) -> (Mode, [Effect]) {
        let next = SheetSave.transition(save, event)
        return (.page(page, next), next == .saving && save != .saving ? [effect] : [])
    }

    // MARK: Landing

    /// What a save came to: nothing it could write (`stay`), nothing new (`unchanged`), the
    /// engine's answer to its edit (`typed`: the weight typed, in the record's units), or to "Replace it".
    enum SaveOutcome: Equatable {
        case stay, unchanged
        case applied(RecordStore.ApplyResult, typed: Double? = nil)
        case replaced(RecordStore.ApplyResult)
    }

    /// What the page shows after a save: the next step, the engine's words (the record now
    /// shown is taken), words for an answer that never reached the engine (`unwritten`: the pin
    /// stays), the replace question, or a refusal on a record that moved under the page (`restart`).
    enum Landing: Equatable { case advance, words(String), unwritten(String), askReplace(Replace), restart(String) }

    /// The words for an answer the page cannot write (bug C); the engine's own fallback words.
    static let couldNotSave = "That could not be saved."

    /// `moved`: the record the page pinned is no longer the one shown (`RecordStore.pinStillShown`,
    /// the store's own guard). The one place a refusal becomes a restart.
    static func landing(_ outcome: SaveOutcome, step: OnboardingStep, moved: Bool = false) -> Landing {
        switch outcome {
        case .stay:
            return .unwritten(couldNotSave)
        case .unchanged:
            return .advance
        // Today already holds a weight: ask before replacing it with the one typed (AC5, US-25 AC5).
        // Apple Health's year-old weight, confirmed, was never typed: its import never names a row.
        case .applied(.refused(_, let id?), let typed?) where step == .weight:
            return .askReplace(Replace(id: id, value: typed))
        // Refused, and the record moved under the page (an erase, a sync turned on or off): plan again.
        case .applied(.refused(let words, _), _) where moved, .replaced(.refused(let words, _)) where moved:
            return .restart(words)
        case .applied(let result, _), .replaced(let result):
            switch result {
            case .saved: return .advance
            case .refused(let words, _): return .words(words)
            }
        }
    }
}
