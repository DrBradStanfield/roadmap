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
    /// The bundle's exports: planJson, sectionsJson, newRecordJson, myDataJson, applyEditJson, numberJson (ios/engine/entry.ts).
    private let exports: JSValue

    init(bundle: Bundle = .main) throws {
        guard let url = bundle.url(forResource: "health-engine", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8),
              let context = JSContext()
        else { throw EngineError.missingBundle }

        // A bare JSContext has no console. The engine may log a warning; drop it,
        // because a log line must never carry a health value.
        context.evaluateScript("var console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };")
        // Nor has it `crypto`, and health-core gives every new row a fresh
        // `crypto.randomUUID()` (FHIR rule 5). The phone's own UUID stands in.
        let randomUUID: @convention(block) () -> String = { UUID().uuidString.lowercased() }
        context.setObject(["randomUUID": randomUUID], forKeyedSubscript: "crypto" as NSString)
        context.evaluateScript(source, withSourceURL: url)
        if let exception = context.exception { throw EngineError.loadFailed(exception.toString()) }

        guard let exports = context.objectForKeyedSubscript("HealthEngine"), !exports.isUndefined
        else { throw EngineError.loadFailed("HealthEngine is not defined") }
        self.context = context
        self.exports = exports
    }

    /// The plan for a record, as the engine's JSON.
    func plan(recordJSON: String, now: Date, deviceId: String) throws -> String {
        try call("planJson", [recordJSON, now.formatted(Self.iso), deviceId])
    }

    /// The plan's on-screen layout, from the same function the web uses.
    func sections(planJSON: String) throws -> [PlanSection] {
        try JSONDecoder().decode([PlanSection].self, from: Data(sectionsJSON(planJSON: planJSON).utf8))
    }

    /// The layout as the engine's JSON, for the parity test to compare byte for byte.
    func sectionsJSON(planJSON: String) throws -> String {
        try call("sectionsJson", [planJSON])
    }

    /// A first-launch record, as JSON. Units follow the phone's region.
    func newRecord(now: Date, deviceId: String, locale: Locale = .current, timeZone: TimeZone = .current) throws -> String {
        try call("newRecordJson", [now.formatted(Self.iso), deviceId, Self.languageAndRegion(locale), timeZone.identifier])
    }

    /// What the My data tab shows for a record.
    func myData(recordJSON: String, now: Date, deviceId: String) throws -> MyData {
        let json = try call("myDataJson", [recordJSON, now.formatted(Self.iso), deviceId])
        return try JSONDecoder().decode(MyData.self, from: Data(json.utf8))
    }

    /// Applies one edit with health-core's own write rules. The record passed in is not changed.
    func apply(_ edit: RecordEdit, to recordJSON: String, now: Date, deviceId: String) throws -> EditOutcome {
        let editJSON = String(decoding: try JSONEncoder().encode(edit), as: UTF8.self)
        let json = try call("applyEditJson", [recordJSON, editJSON, now.formatted(Self.iso), deviceId])
        return try JSONDecoder().decode(EditOutcome.self, from: Data(json.utf8))
    }

    /// A typed number, read by the web's rule (health-core's `parseLocalisedNumber`):
    /// either decimal mark, and nil for anything that is not a plain decimal.
    func number(from text: String) throws -> Double? {
        let json = try call("numberJson", [text])
        return try JSONDecoder().decode(Double?.self, from: Data(json.utf8))
    }

    /// Calls an engine function that returns text, turning a JavaScript exception into a Swift error.
    private func call(_ name: String, _ arguments: [Any]) throws -> String {
        guard let function = exports.objectForKeyedSubscript(name), !function.isUndefined else {
            throw EngineError.callFailed("HealthEngine.\(name) is not defined")
        }
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

    /// "en-US": the language and region only. The full identifier can end in a keyword
    /// (24-hour time adds `-u-hc-h23`), which health-core's `detectUnitSystem` would
    /// read as the country, and a US phone would start in metric.
    private static func languageAndRegion(_ locale: Locale) -> String {
        let language = locale.language.languageCode?.identifier ?? "en"
        guard let region = locale.region?.identifier else { return language }
        return "\(language)-\(region)"
    }

    /// The instant format JavaScript's `toISOString` writes, milliseconds included.
    private static let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
}
