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
    /// The bundle's exports (ios/engine/entry.ts): the plan, My data and the cloud doors.
    private let exports: JSValue
    /// HTTP, timers and the cloud calls the engine reaches Swift through.
    let natives: EngineNatives

    /// `session`: the URLSession the engine's fetch runs on; tests pass a stubbed one.
    init(bundle: Bundle = .main, session: URLSession = .shared) throws {
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
        // fetch, timers and text coding for the cloud adapters (ios/engine/shim.ts).
        natives = EngineNatives(session: session)
        natives.install(in: context)
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

    /// The values a person entered that belong in Apple Health (US-25 AC14, device-export.ts).
    func healthWrites(recordJSON: String, now: Date, deviceId: String) throws -> [HealthWrite] {
        let json = try call("healthWritesJson", [recordJSON, now.formatted(Self.iso), deviceId])
        return try JSONDecoder().decode([HealthWrite].self, from: Data(json.utf8))
    }

    /// Every value recorded for one metric, newest first, corrections included (US-25 AC9).
    func history(recordJSON: String, metric: String, now: Date, deviceId: String) throws -> MetricHistory {
        let json = try call("historyJson", [recordJSON, metric, now.formatted(Self.iso), deviceId])
        return try JSONDecoder().decode(MetricHistory.self, from: Data(json.utf8))
    }

    /// A typed number, read by the web's rule (health-core's `parseLocalisedNumber`):
    /// either decimal mark, and nil for anything that is not a plain decimal.
    func number(from text: String) throws -> Double? {
        let json = try call("numberJson", [text])
        return try JSONDecoder().decode(Double?.self, from: Data(json.utf8))
    }

    /// Calls an engine function that returns text, turning a JavaScript exception into a Swift error.
    func call(_ name: String, _ arguments: [Any]) throws -> String {
        let result = try callValue(name, arguments)
        guard result.isString, let text = result.toString() else {
            throw EngineError.callFailed("the engine returned no text")
        }
        return text
    }

    /// Calls an engine function that returns a Promise of text, and waits for it.
    /// A rejection becomes `EngineError.callFailed` with the error's message.
    @MainActor
    func callAsync(_ name: String, _ arguments: [Any]) async throws -> String {
        try await settle(callValue(name, arguments))
    }

    /// Calls an engine function that returns a Promise of something other than
    /// text (an object holding an ArrayBuffer), and answers what `read` makes of it.
    @MainActor
    func callAsync<T: Sendable>(_ name: String, _ arguments: [Any], read: @escaping (JSValue) -> T) async throws -> T {
        try await settle(callValue(name, arguments), read: read)
    }

    /// Runs a script in the engine's context; tests use it to reach the shim directly.
    func evaluate(_ script: String) throws -> JSValue {
        let result = context.evaluateScript(script)
        if let exception = context.exception {
            context.exception = nil
            throw EngineError.callFailed(exception.toString())
        }
        return result ?? JSValue(undefinedIn: context)
    }

    /// Waits for a Promise (or takes a plain value) and answers it as text.
    @MainActor
    func settle(_ value: JSValue) async throws -> String {
        try await settle(value) { $0.isUndefined ? "" : $0.toString() }
    }

    /// Waits for a Promise (or takes a plain value) and answers what `read` makes of it.
    @MainActor
    func settle<T: Sendable>(_ value: JSValue, read: @escaping (JSValue) -> T) async throws -> T {
        try await withCheckedThrowingContinuation { (done: CheckedContinuation<T, Error>) in
            let fulfilled: @convention(block) (JSValue) -> Void = { done.resume(returning: read($0)) }
            let rejected: @convention(block) (JSValue) -> Void = { error in
                let message = error.isObject ? error.objectForKeyedSubscript("message")?.toString() : nil
                done.resume(throwing: EngineError.callFailed(message ?? error.toString()))
            }
            let promise = context.objectForKeyedSubscript("Promise").invokeMethod("resolve", withArguments: [value])
            promise?.invokeMethod("then", withArguments: [unsafeBitCast(fulfilled, to: AnyObject.self), unsafeBitCast(rejected, to: AnyObject.self)])
        }
    }

    private func callValue(_ name: String, _ arguments: [Any]) throws -> JSValue {
        guard let function = exports.objectForKeyedSubscript(name), !function.isUndefined else {
            throw EngineError.callFailed("HealthEngine.\(name) is not defined")
        }
        let result = function.call(withArguments: arguments)
        if let exception = context.exception {
            context.exception = nil
            throw EngineError.callFailed(exception.toString())
        }
        return result ?? JSValue(undefinedIn: context)
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
    static let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
}
