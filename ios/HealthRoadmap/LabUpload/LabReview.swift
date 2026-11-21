import Foundation

/// The engine's words for a save it refused.
struct LabRefusal: Error, Equatable {
    let message: String
}
