import Foundation
import JavaScriptCore

/// Runs health-core, the web's own engine, in JavaScriptCore (ios/architecture.md D2).
/// JSON in, JSON out: the record goes in as text and the plan comes back as text,
/// so the app and the web compute from one source of clinical truth.
/// An actor on its own serial queue: the JSContext is made there and touched only
/// there, so engine work never holds up the main thread (Brad 2026-10-22).
actor HealthEngine {
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

    /// The one queue the engine runs on: its executor, its timers and its network answers.
    nonisolated let queue: DispatchSerialQueue
    nonisolated var unownedExecutor: UnownedSerialExecutor { queue.asUnownedSerialExecutor() }

    private let context: JSContext
    /// The bundle's exports (ios/engine/entry.ts): the plan, My data and the cloud doors.
    private let exports: JSValue
    /// HTTP, timers and the cloud calls the engine reaches Swift through.
    let natives: EngineNatives
    /// Set when this is a downloaded engine on trial (EngineBoot, US-25 AC18).
    @MainActor var trial: EngineTrial?
    /// Whether the App Store storefront is the US (US-61, `AppStoreCountry`): every screen
    /// draw passes it, so the plan's supplement cards show Dr Brad's products to a known adult.
    private(set) var storefrontIsUS = false

    /// The engine shipped in the app. `session`: the URLSession the engine's fetch
    /// runs on (EngineHTTP's own by default); tests pass a stubbed one.
    init(bundle: Bundle = .main, session: URLSession = EngineHTTP.shared) throws {
        guard let url = bundle.url(forResource: "health-engine", withExtension: "js"),
              let source = try? String(contentsOf: url, encoding: .utf8)
        else { throw EngineError.missingBundle }
        try self.init(source: source, sourceURL: url, session: session)
    }

    /// An engine from source text: the bundled one, or a verified download (EngineBoot).
    /// `quarantined`: a self-test context whose natives refuse every request and hold
    /// no token (US-25 AC18).
    init(source: String, sourceURL: URL?, session: URLSession = EngineHTTP.shared, quarantined: Bool = false) throws {
        // Made on the engine's queue, the only one that ever touches it.
        let queue = DispatchSerialQueue(label: "engine", qos: .userInitiated)
        self.queue = queue
        (context, exports, natives) = try queue.sync {
            guard let context = JSContext() else { throw EngineError.missingBundle }

            // A bare JSContext has no console. The engine may log a warning; drop it,
            // because a log line must never carry a health value.
            context.evaluateScript("var console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };")
            // Nor has it `crypto`, and health-core gives every new row a fresh
            // `crypto.randomUUID()` (FHIR rule 5). The phone's own UUID stands in.
            let randomUUID: @convention(block) () -> String = { UUID().uuidString.lowercased() }
            context.setObject(["randomUUID": randomUUID], forKeyedSubscript: "crypto" as NSString)
            // fetch, timers and text coding for the cloud adapters (ios/engine/shim.ts).
            let natives = EngineNatives(session: session, queue: queue, quarantined: quarantined)
            natives.install(in: context)
            context.evaluateScript(source, withSourceURL: sourceURL)
            if let exception = context.exception { throw EngineError.loadFailed(exception.toString()) }

            guard let exports = context.objectForKeyedSubscript("HealthEngine"), !exports.isUndefined
            else { throw EngineError.loadFailed("HealthEngine is not defined") }
            return (context, exports, natives)
        }
    }

    /// The storefront's country changed (US-61): the next draw follows it.
    func useStorefront(isUS: Bool) {
        storefrontIsUS = isUS
    }

    /// Where the engine reaches the phone: tokens and news on the main actor, the
    /// record file and the pending marker as plain files here (US-25 AC11).
    func attach(_ port: CloudPort?, phone: PhoneFiles) {
        natives.cloud = port
        natives.phone = phone
    }

    /// Runs `body` on the engine's queue and answers when it is done, never holding the caller.
    func perform<T: Sendable>(_ body: @Sendable (isolated HealthEngine) throws -> T) rethrows -> T {
        try body(self)
    }

    /// Puts `body` on the engine's queue without waiting. The queue runs in order, so it
    /// runs before any engine call asked for after this one (CloudSync's attach at launch).
    nonisolated func enqueue(_ body: @escaping @Sendable (isolated HealthEngine) -> Void) {
        let run = unsafeBitCast(body, to: (@Sendable (HealthEngine) -> Void).self)
        queue.async { run(self) }
    }

    /// What My data and the Plan tab show for a record, from one engine call (`screenJson`):
    /// one read and one plan, so the two always show the same record (US-25 AC2). The plan
    /// half carries how long the engine took to plan (D2's plan budget). A plan the engine
    /// cannot make never blanks My data; tiles it cannot draw come back empty, never blanking
    /// the plan. My data the engine cannot draw throws the whole call.
    /// `units`: the phone's per-test units as JSON (UnitChoices, US-25 AC17e); "{}" for none.
    func screen(recordJSON: String, now: Date, deviceId: String, units: String = "{}") throws -> Drawn {
        let json = try call("screenJson", [recordJSON, now.formatted(Self.iso), deviceId, units, storefrontIsUS])
        let answer = try JSONDecoder().decode(Drawn.Answer.self, from: Data(json.utf8))
        return Drawn(myData: answer.myData, plan: answer.plan.state)
    }

    /// One record as the screens show it: My data and the plan, from the same engine call.
    struct Drawn: Sendable {
        let myData: MyData
        let plan: PlanState

        fileprivate struct Answer: Decodable {
            let myData: MyData
            let plan: Plan
        }

        /// `{sections, tiles, ms}`, or `{error, planError}` when the record cannot be planned.
        fileprivate struct Plan: Decodable {
            let sections: [PlanSection]?
            let tiles: [StatTile]
            /// The engine's milliseconds from computePlan through the tiles and the layout.
            let ms: Double
            let error: String?
            let planError: Bool
            /// US-61's blocks; one Swift cannot read shows none, never a broken plan.
            let usProducts: USProducts?
            enum CodingKeys: CodingKey { case sections, tiles, ms, error, planError, usProducts }
            /// Sections decode strictly: sections Swift cannot read fail the plan, never My data.
            /// A tile Swift cannot read leaves no tiles, never a blank plan.
            init(from decoder: Decoder) throws {
                let c = try decoder.container(keyedBy: CodingKeys.self)
                tiles = (try? c.decode([StatTile].self, forKey: .tiles)) ?? []
                ms = (try? c.decodeIfPresent(Double.self, forKey: .ms)) ?? 0
                planError = (try? c.decodeIfPresent(Bool.self, forKey: .planError)) == true
                usProducts = (try? c.decodeIfPresent(USProducts.self, forKey: .usProducts)) ?? nil
                do {
                    (sections, error) = (try c.decodeIfPresent([PlanSection].self, forKey: .sections), try c.decodeIfPresent(String.self, forKey: .error))
                } catch {
                    (sections, self.error) = (nil, "the plan could not be read: \(error)")
                }
            }

            var state: PlanState {
                if let sections { return .planned(tiles: tiles, sections: usProducts?.applied(to: sections) ?? sections, ms: ms) }
                if planError { return .needsDetails }
                return .failed(EngineError.callFailed(error ?? "no plan").localizedDescription)
            }
        }
    }

    /// The plan for a record, as the engine's JSON.
    /// `units`: the phone's per-test units as JSON (UnitChoices, US-25 AC17e); "{}" for none.
    func plan(recordJSON: String, now: Date, deviceId: String, units: String = "{}") throws -> String {
        try call("planJson", [recordJSON, now.formatted(Self.iso), deviceId, units])
    }

    /// The layout as the engine's JSON, for the parity test to compare byte for byte.
    func sectionsJSON(planJSON: String) throws -> String {
        try call("sectionsJson", [planJSON])
    }

    /// A first-launch record, as JSON. Units follow the phone's region.
    func newRecord(now: Date, deviceId: String, locale: Locale = .current, timeZone: TimeZone = .current) throws -> String {
        try call("newRecordJson", [now.formatted(Self.iso), deviceId, Self.languageAndRegion(locale), timeZone.identifier])
    }

    /// Applies one edit with health-core's own write rules. The record passed in is not changed.
    func apply(_ edit: RecordEdit, to recordJSON: String, now: Date, deviceId: String, units: String = "{}") throws -> EditOutcome {
        let editJSON = String(decoding: try JSONEncoder().encode(edit), as: UTF8.self)
        let json = try call("applyEditJson", [recordJSON, editJSON, now.formatted(Self.iso), deviceId, units])
        return try JSONDecoder().decode(EditOutcome.self, from: Data(json.utf8))
    }

    /// The values a person entered that belong in Apple Health (US-25 AC14, device-export.ts).
    func healthWrites(recordJSON: String, now: Date, deviceId: String) throws -> [HealthWrite] {
        let json = try call("healthWritesJson", [recordJSON, now.formatted(Self.iso), deviceId])
        return try JSONDecoder().decode([HealthWrite].self, from: Data(json.utf8))
    }

    /// Every value recorded for one metric, newest first, corrections included (US-25 AC9).
    func history(recordJSON: String, metric: String, now: Date, deviceId: String, units: String = "{}") throws -> MetricHistory {
        let json = try call("historyJson", [recordJSON, metric, now.formatted(Self.iso), deviceId, units])
        return try JSONDecoder().decode(MetricHistory.self, from: Data(json.utf8))
    }

    /// A typed value in the other units, by health-core's factors (`convertJson`): onboarding's
    /// unit switches are for entry only (US-54 AC6). `from`, `to`: "si" or "conventional".
    func convert(_ value: Double, metric: String, from: String, to: String) throws -> Conversion {
        let json = try call("convertJson", [metric, value, from, to])
        return try JSONDecoder().decode(Conversion.self, from: Data(json.utf8))
    }

    /// `value` unrounded, for an edit; `text` as the record shows it; `feetInches` for a height.
    struct Conversion: Decodable {
        let value: Double
        let text: String
        let feetInches: MyData.FeetInches?
    }

    /// Calls an engine function that returns text, turning a JavaScript exception into a Swift error.
    func call(_ name: String, _ arguments: [Any]) throws -> String {
        let result = try callValue(name, arguments)
        guard result.isString, let text = result.toString() else {
            throw EngineError.callFailed("the engine returned no text")
        }
        return text
    }

    /// Calls an async door whose Promise settles in the same call, then reads its answer
    /// (`settledJson`) without awaiting. JavaScriptCore runs pending promise work before a
    /// call returns, so the answer is there; "pending" would mean it was not.
    func settled<T: Decodable>(_ type: T.Type, _ name: String, _ arguments: [Any]) throws -> T {
        _ = try call(name, arguments)
        let answer = try JSONDecoder().decode(Settled<T>.self, from: Data(call("settledJson", []).utf8))
        guard answer.ok, let value = answer.value else { throw EngineError.callFailed(answer.message ?? "no answer") }
        return value
    }

    private struct Settled<T: Decodable>: Decodable {
        let ok: Bool
        let value: T?
        let message: String?
    }

    /// Calls an engine function that returns a Promise of text, and waits for it.
    /// A rejection becomes `EngineError.callFailed` with the error's message.
    func callAsync(_ name: String, _ arguments: [Any]) async throws -> String {
        try await settle(callValue(name, arguments))
    }

    /// Calls an engine function that returns a Promise, and answers what `read` makes
    /// of the settled value on the engine's queue (the cloud doors' `stamped`: the
    /// answer's text and the order it resolved in).
    func callAsync<T: Sendable>(_ name: String, _ arguments: [Any], read: @escaping (JSValue) -> T) async throws -> T {
        try await settle(callValue(name, arguments), read: read)
    }

    /// `data` as an ArrayBuffer in this engine's context, for a door that takes bytes.
    func arrayBuffer(_ data: Data) -> JSValue {
        EngineNatives.arrayBuffer(data, in: context)
    }

    /// Runs a script in the engine's context: the self-test reads the bundle's globals
    /// with it, and tests reach the shim directly.
    func evaluate(_ script: String) throws -> JSValue {
        checkJSThread()
        let result = context.evaluateScript(script)
        if let exception = context.exception {
            context.exception = nil
            throw EngineError.callFailed(exception.toString())
        }
        return result ?? JSValue(undefinedIn: context)
    }

    /// Waits for a Promise (or takes a plain value) and answers it as text.
    func settle(_ value: JSValue) async throws -> String {
        try await settle(value) { $0.isUndefined ? "" : $0.toString() }
    }

    /// Waits for a Promise (or takes a plain value) and answers what `read` makes of it.
    func settle<T: Sendable>(_ value: JSValue, read: @escaping (JSValue) -> T) async throws -> T {
        checkJSThread()
        return try await withCheckedThrowingContinuation { (done: CheckedContinuation<T, Error>) in
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
        checkJSThread()
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

    /// Debug builds: JavaScript runs on the engine's queue and never on the main thread
    /// (US-25 AC21b). A `queue.sync` from main would pass the first check but not the second.
    private func checkJSThread() {
        #if DEBUG
        dispatchPrecondition(condition: .onQueue(queue))
        dispatchPrecondition(condition: .notOnQueue(.main))
        #endif
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
