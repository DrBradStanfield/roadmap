import Foundation
import JavaScriptCore

/// Runs health-core, the web's own engine, in JavaScriptCore (ios/architecture.md D2).
/// JSON in, JSON out: the record goes in as text and the plan comes back as text,
/// so the app and the web compute from one source of clinical truth.
final class HealthEngine {
    enum EngineError: LocalizedError {
        case missingBundle
        case loadFailed(String)
        case callFailed(String)

        var errorDescription: String? {
            switch self {
            case .missingBundle: "The engine is missing. Run `node ios/scripts/build-engine.mjs`, then build again."
            case .loadFailed(let why): "The engine failed to load: \(why)"
            case .callFailed(let why): "The engine failed: \(why)"
            }
        }
    }

    private let context: JSContext
    private let planJson: JSValue
    private let sectionsJson: JSValue

    init(bundle: Bundle = .main) throws {
        guard let url = bundle.url(forResource: "health-engine", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext()
        else { throw EngineError.missingBundle }

        // A bare JSContext has no console. The engine may log a warning; drop it,
        // because a log line must never carry a health value.
        context.evaluateScript("var console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };")
        context.evaluateScript(source, withSourceURL: url)
        if let exception = context.exception { throw EngineError.loadFailed(exception.toString()) }

        let engine = context.objectForKeyedSubscript("HealthEngine")
        guard let planJson = engine?.objectForKeyedSubscript("planJson"), !planJson.isUndefined,
              let sectionsJson = engine?.objectForKeyedSubscript("sectionsJson"), !sectionsJson.isUndefined
        else { throw EngineError.loadFailed("HealthEngine.planJson or sectionsJson is not defined") }
        self.context = context
        self.planJson = planJson
        self.sectionsJson = sectionsJson
    }

    /// The plan for a record, as the engine's JSON.
    func plan(recordJSON: String, now: Date, deviceId: String) throws -> String {
        try call(planJson, [recordJSON, now.formatted(Self.iso), deviceId])
    }

    /// The plan's on-screen layout, from the same function the web uses.
    func sections(planJSON: String) throws -> [PlanSection] {
        try JSONDecoder().decode([PlanSection].self, from: Data(sectionsJSON(planJSON: planJSON).utf8))
    }

    /// The layout as the engine's JSON, for the parity test to compare byte for byte.
    func sectionsJSON(planJSON: String) throws -> String {
        try call(sectionsJson, [planJSON])
    }

    /// Calls an engine function that returns text, turning a JavaScript exception into a Swift error.
    private func call(_ function: JSValue, _ arguments: [Any]) throws -> String {
        let result = function.call(withArguments: arguments)
        if let exception = context.exception {
            context.exception = nil
            throw EngineError.callFailed(exception.toString())
        }
        guard let result, result.isString, let text = result.toString() else {
            throw EngineError.callFailed("the engine returned no text")
        }
        return text
    }

    /// The instant format JavaScript's `toISOString` writes, milliseconds included.
    private static let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
}
