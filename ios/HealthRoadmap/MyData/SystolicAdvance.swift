import Foundation

/// The blood pressure sheet's move from systolic to diastolic (US-02 AC6, AC6b, AC6c, AC12):
/// one named state, changed only by `transition`. The rule is health-core's `bpSysAdvance`,
/// read through the engine (`HealthEngine.bpSysAdvance`), never copied here: each systolic
/// typed is asked about (`asking`); "advance" moves the focus at once, "defer" starts the
/// pause (`pausing`), anything else, or an engine without the door, moves nothing. A pause
/// moves only if the systolic has the focus when it ends: leaving and coming back first still
/// moves, as on the web (AC6b). A new systolic cancels a pause or a question (AC6c): an answer
/// or a pause's end for any other text is ignored. The web twin is `useAutoAdvance`.
enum SystolicAdvance: Equatable {
    case idle
    case asking(systolic: String, diastolic: String)
    case pausing(systolic: String)

    /// The engine's word (health-core `BpAdvance`).
    enum Word: String { case advance, `defer`, stay }

    enum Event: Equatable {
        /// The systolic changed; `diastolic` is the diastolic's text at that moment.
        case typed(systolic: String, diastolic: String)
        /// The engine's word for that pair; nil from an engine without the door.
        case judged(systolic: String, diastolic: String, word: Word?)
        /// The pause for `systolic` ran out; `focused`: the systolic has the focus now.
        case pauseEnded(systolic: String, focused: Bool)
    }

    /// The web's pause (`useAutoAdvance`, 800 ms).
    static let pause = Duration.milliseconds(800)

    /// The state that follows, and whether the focus moves to the diastolic now.
    static func transition(_ state: Self, _ event: Event) -> (state: Self, moves: Bool) {
        switch (state, event) {
        case (_, .typed(let systolic, let diastolic)):
            return (.asking(systolic: systolic, diastolic: diastolic), false)
        case (.asking(let s, let d), .judged(let systolic, let diastolic, let word)) where s == systolic && d == diastolic:
            switch word {
            case .advance: return (.idle, true)
            case .`defer`: return (.pausing(systolic: systolic), false)
            case .stay, nil: return (.idle, false)
            }
        case (.pausing(let s), .pauseEnded(let systolic, let focused)) where s == systolic:
            return (.idle, focused)
        case (.idle, _), (.asking, _), (.pausing, _):
            return (state, false)
        }
    }
}
