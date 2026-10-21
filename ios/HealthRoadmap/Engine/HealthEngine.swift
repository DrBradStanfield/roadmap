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

        guard let planJson = context.objectForKeyedSubscript("HealthEngine")?.objectForKeyedSubscript("planJson"),
              !planJson.isUndefined
        else { throw EngineError.loadFailed("HealthEngine.planJson is not defined") }
        self.context = context
        self.planJson = planJson
    }

    /// The plan for a record, as the engine's JSON.
    func plan(recordJSON: String, now: Date, deviceId: String) throws -> String {
        let result = planJson.call(withArguments: [recordJSON, now.formatted(Self.iso), deviceId])
        if let exception = context.exception {
            context.exception = nil
            throw EngineError.callFailed(exception.toString())
        }
        guard let result, result.isString, let json = result.toString() else {
            throw EngineError.callFailed("planJson returned no text")
        }
        return json
    }

    /// The instant format JavaScript's `toISOString` writes, milliseconds included.
    private static let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
}
