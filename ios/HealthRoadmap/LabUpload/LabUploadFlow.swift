import Foundation

/// The upload sheet's one named state (US-52 AC8c; CLAUDE.md, a mode is one named state): the
/// sources, the shared upload's page, or a pick the reader refused. Moved only by `transition`;
/// LabUploadFlowTests holds the table. The upload's own phases are the engine's, drawn from its view.
enum LabUploadFlow {
    enum Step: Equatable {
        case choose
        /// The shared upload's one review page owns the screen; its phase, consent included, is
        /// the engine's, not this step's.
        case shared
        case failed(String)
        /// Done on the page: the sheet closes.
        case finished
    }

    enum Event {
        /// A source picked; only the sources take one, so a double tap starts one upload.
        case sharedPicked
        case failed(String)
        case restart
        case done
    }

    static func transition(_ step: Step, _ event: Event) -> Step {
        switch (step, event) {
        case (.choose, .sharedPicked): .shared
        case (_, .failed(let message)): .failed(message)
        case (_, .restart): .choose
        case (_, .done): .finished
        default: step
        }
    }
}
