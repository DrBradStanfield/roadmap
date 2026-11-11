import SwiftUI

/// What a sheet holds while it asks "replace it?": nothing held is never asked about.
protocol SheetHeld: Equatable { var isEmpty: Bool { get } }
/// A blood pressure's day: the active rows the user saw.
extension Array: SheetHeld where Element: Equatable {}

/// A sheet's save, with the engine off the main thread (US-25 AC21). One named state
/// (US-25 AC21e, iPhone survey S5), changed only by `transition`: editing (with the
/// engine's last words), saving, finding the day's rows after a refusal names one,
/// asking to replace them, done. A sheet closes only on a save; otherwise the engine's
/// words show. An edit made outside a sheet shows them in `refusalAlert`.
///
/// `tapped` is the synchronous claim: it moves editing to saving in the same turn as the
/// tap, so a second tap sees saving before the sheet redraws (US-25 AC21d); no ref or
/// flag is added beside it. Save, Cancel and swipe-down wait while `busy`. Rows that
/// cannot be read show the engine's words, so a replace never names no rows. `done` is
/// terminal: a closed sheet ignores every later event; a save that leaves its screen open
/// (`closes: false`) goes back to editing instead. "Replace it" sends `confirmed` with the
/// rows it was shown, so it is taken from asking, or from editing(nil) when the dialog's
/// dismissal (`declined`) landed first: no order of the two drops the tap. An event a
/// state does not list leaves it as it is.
@MainActor
enum SheetSave {
    enum State<Held: SheetHeld>: Equatable {
        case editing(message: String?)
        case saving
        /// A refusal named the day's row; its rows are being read, its words kept for a miss.
        case findingRows(words: String)
        case asking(Held)
        case done

        /// Save, Cancel and swipe-down wait.
        var busy: Bool {
            switch self {
            case .saving, .findingRows: true
            default: false
            }
        }
        /// The engine's words, shown under the fields.
        var message: String? { if case .editing(let words) = self { words } else { nil } }
        /// What the "replace it?" question is about.
        var held: Held? { if case .asking(let held) = self { held } else { nil } }
    }

    /// What a refusal naming the day's row leads to.
    enum Asks<Held> {
        /// Show the words (a replace already sent, or a sheet that never asks).
        case never
        /// Read the day's rows, then ask (blood pressure).
        case findRows
        /// Ask about the named row at once (a value sheet holds its id and number).
        case holding((String) -> Held)
    }

    enum Event<Held: SheetHeld> {
        case tapped
        /// `closes`: a save closes its sheet (done); a screen that stays open (a "Taking again")
        /// goes back to editing.
        case landed(RecordStore.ApplyResult, closes: Bool, asks: Asks<Held>)
        case rowsFound(Held?)
        /// "Replace it", carrying the rows its dialog showed (only that button sends it).
        case confirmed(Held)
        case declined
        /// The engine's words no longer fit: the user typed, or dismissed the alert showing them.
        case wordsStale
        case unitChosen
        case unitLanded(String?)
    }

    /// For a save that never asks.
    enum NoHeld: SheetHeld { var isEmpty: Bool { true } }

    nonisolated static func transition<Held>(_ state: State<Held>, _ event: Event<Held>) -> State<Held> {
        switch (state, event) {
        case (.editing, .tapped), (.editing, .unitChosen), (.asking, .confirmed), (.editing(message: nil), .confirmed): return .saving
        case (.editing, .wordsStale), (.asking, .declined): return .editing(message: nil)
        case (.saving, .landed(.saved, let closes, _)): return closes ? .done : .editing(message: nil)
        case (.saving, .landed(.refused(let words, let row), _, let asks)):
            guard let row else { return .editing(message: words) }
            switch asks {
            case .never: return .editing(message: words)
            case .findRows: return .findingRows(words: words)
            case .holding(let hold): return asking(hold(row), else: words)
            }
        case (.saving, .unitLanded(let words)): return .editing(message: words)
        case (.findingRows(let words), .rowsFound(let held)): return asking(held, else: words)
        default: return state
        }
    }

    private nonisolated static func asking<Held>(_ held: Held?, else words: String) -> State<Held> {
        if let held, !held.isEmpty { .asking(held) } else { .editing(message: words) }
    }

    /// Moves `state` by `event`; true when this moved it into saving, so the caller starts its work now.
    @discardableResult
    static func send<Held>(_ state: inout State<Held>, _ event: Event<Held>) -> Bool {
        let was = state
        state = transition(was, event)
        return state == .saving && was != .saving
    }
}

extension View {
    /// "Not saved" with the engine's words, for an edit made outside a sheet (a picker,
    /// a menu, a quick add); dismissing it clears `refusal`.
    func refusalAlert(_ refusal: Binding<String?>) -> some View { messageAlert("Not saved", refusal) }
}
