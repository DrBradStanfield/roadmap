import Foundation

/// The part of the engine's plan the app reads. The engine owns the full shape
/// (`Plan` in packages/health-core/src/plan.ts); fields not listed here are ignored.
struct Plan: Decodable {
    /// One suggestion, as the engine writes it (`Suggestion` in packages/health-core/src/types.ts).
    struct Suggestion: Decodable, Identifiable {
        let id: String
        /// nutrition, exercise, bloodwork, blood_pressure, general, sleep, medication, screening, supplements, skin
        let category: String
        /// urgent, attention or info
        let priority: String
        let title: String
        let description: String
    }

    struct Results: Decodable {
        let suggestions: [Suggestion]
    }

    /// The plan's calendar day, YYYY-MM-DD, in the phone's time zone.
    let today: String
    let results: Results
}
