import Foundation
import JavaScriptCore
import os

/// What the engine needs from the main actor to sync (US-25 AC11): tokens and news
/// of what happened. `CloudSync` provides it; ios/engine/cloud.ts `CloudNatives` is
/// its twin. The phone's record file and pending marker are `PhoneFiles`, read and
/// written on the engine's queue.
@MainActor
protocol CloudPort: AnyObject, Sendable {
    /// A current access token; `force` after the provider refused the last one.
    func accessToken(provider: String, force: Bool) async -> TokenAnswer
    /// "saving", "saved", "synced", "failed" (payload: kind and detail) or
    /// "changed" (payload: the record), from engine session `session`. `order`:
    /// the engine's stamp when it was sent (HealthEngine.stamp).
    func notify(_ event: String, _ payload: String, session: Int, order: Int)
}

/// The phone's record file and the marker that says the phone holds changes the
/// cloud lacks: plain files, so the engine reads and writes them on its own queue
/// and never waits on the main thread. `nil` URLs keep them in memory (a quarantined
/// self-test engine, EngineBoot).
final class PhoneFiles: Sendable {
    let record: URL?
    let pending: URL?
    private let memory = OSAllocatedUnfairLock(initialState: (record: String?.none, pending: false))

    init(record: URL?, pending: URL?) {
        self.record = record
        self.pending = pending
    }

    /// The record's text, nil when there is none; throws when it is there but unreadable.
    func read() throws -> String? {
        guard let record else { return memory.withLock { $0.record } }
        guard FileManager.default.fileExists(atPath: record.path(percentEncoded: false)) else { return nil }
        return try String(contentsOf: record, encoding: .utf8)
    }

    func write(_ text: String) throws {
        guard let record else { return memory.withLock { $0.record = text } }
        try RecordStore.write(text, to: record)
    }

    func remove() {
        guard let record else { return memory.withLock { $0.record = nil } }
        try? FileManager.default.removeItem(at: record)
    }

    /// "get", "set" or "clear" the pending marker; answers whether it is set.
    func pending(_ op: String) -> Bool {
        guard let pending else {
            return memory.withLock {
                if op == "set" { $0.pending = true } else if op == "clear" { $0.pending = false }
                return $0.pending
            }
        }
        switch op {
        case "set": try? Data().write(to: pending, options: .atomic)
        case "clear": try? FileManager.default.removeItem(at: pending)
        default: break
        }
        return FileManager.default.fileExists(atPath: pending.path(percentEncoded: false))
    }
}

enum TokenAnswer: Sendable {
    case token(String)
    /// `signIn`: only signing in again fixes it. Otherwise a retry may.
    case failed(String, signIn: Bool)
}

/// The primitives JavaScriptCore lacks, which ios/engine/shim.ts builds the
/// web's fetch, timers and text coding on (architecture.md D2), plus the
/// `CloudPort` and `PhoneFiles` calls. Installed as the global `__native` before the
/// bundle runs. JavaScript runs on the engine's queue only: every answer from
/// URLSession, a timer or the main actor hops there before it touches a JSValue.
/// The queue never waits on the main thread: news goes there with `async`.
/// HTTP goes only where `EngineHTTP` allows, and tokens never reach JavaScript
/// (US-25 AC18): an engine can be updated over the air, the fence cannot.
final class EngineNatives {
    weak var cloud: CloudPort?
    var phone: PhoneFiles?
    private let session: URLSession
    /// The engine's queue (HealthEngine.queue).
    private let queue: DispatchSerialQueue
    /// A self-test context for a downloaded engine (EngineBoot): every request refused.
    private let quarantined: Bool
    private var tasks: [Int: URLSessionTask] = [:]
    /// Requests cancelled before their token arrived.
    private var cancelled: Set<Int> = []
    private var timers: [Int: DispatchWorkItem] = [:]
    private var nextId = 1
    private var stamps = 0
    /// The open session's working copy, as the engine last handed it over (its open,
    /// an edit, or news it brought something in): what a lab summary is taken against.
    var openSession: (id: Int, record: String)?

    init(session: URLSession, queue: DispatchSerialQueue, quarantined: Bool = false) {
        self.session = session
        self.queue = queue
        self.quarantined = quarantined
    }

    func install(in context: JSContext) {
        let http: @convention(block) (String, String, String, JSValue, JSValue) -> Int = { [unowned self] method, url, headers, body, done in
            request(method: method, url: url, headers: headers, body: Self.data(body), done: done)
        }
        let cancelHttp: @convention(block) (Int) -> Void = { [unowned self] id in
            if let task = tasks.removeValue(forKey: id) { task.cancel() } else { cancelled.insert(id) }
        }
        let setTimer: @convention(block) (Double, JSValue) -> Int = { [unowned self] ms, run in
            timer(after: ms, run: run)
        }
        let clearTimer: @convention(block) (Int) -> Void = { [unowned self] id in
            timers.removeValue(forKey: id)?.cancel()
        }
        let utf8Encode: @convention(block) (String) -> JSValue = { text in
            Self.arrayBuffer(Data(text.utf8), in: JSContext.current())
        }
        let utf8Decode: @convention(block) (JSValue) -> String = { bytes in
            String(decoding: Self.data(bytes) ?? Data(), as: UTF8.self)
        }
        var natives: [String: Any] = [
            "http": http, "cancelHttp": cancelHttp, "setTimer": setTimer, "clearTimer": clearTimer,
            "utf8Encode": utf8Encode, "utf8Decode": utf8Decode,
        ]
        natives.merge(cloudNatives()) { first, _ in first }
        context.setObject(natives, forKeyedSubscript: "__native" as NSString)
    }

    // MARK: HTTP

    private func request(method: String, url: String, headers: String, body: Data?, done: JSValue) -> Int {
        let id = nextId
        nextId += 1
        let answer = EngineQueueOnly(done)
        let refuse = { (why: String) in
            self.queue.async { answer.value.call(withArguments: [0, "", "{}", NSNull(), why]) }
        }
        let fields = (try? JSONDecoder().decode([String: String].self, from: Data(headers.utf8))) ?? [:]
        guard !quarantined, let address = URL(string: url),
              case .success(let allowed) = EngineHTTP.check(method: method, url: address, headers: fields)
        else {
            refuse("This app does not send that request.")
            return id
        }
        var request = URLRequest(url: address)
        request.httpMethod = method
        request.httpBody = body
        for (name, value) in allowed.headers { request.setValue(value, forHTTPHeaderField: name) }
        // The real token, from Swift, onto an allowed call for its own provider only.
        let owner = EngineQueueOnly(self)
        let port = cloud
        let wanted = EngineQueueOnly(request)
        let provider = allowed.provider
        token(from: port, provider: provider, force: false) { token in
            let natives = owner.value
            if natives.cancelled.remove(id) != nil { return }
            guard case .token(let value) = token else {
                answer.value.call(withArguments: [0, "", "{}", NSNull(), "Not signed in."])
                return
            }
            var request = wanted.value
            request.setValue("Bearer \(value)", forHTTPHeaderField: "Authorization")
            natives.send(request, id: id, answer: answer)
        }
        return id
    }

    /// Asks the main actor for a token and answers on the engine's queue. The engine
    /// does not wait: the answer arrives as a new job there.
    private func token(from port: CloudPort?, provider: String, force: Bool, then answer: @escaping @Sendable (TokenAnswer) -> Void) {
        let queue = queue
        Task { @MainActor in
            let token = await port?.accessToken(provider: provider, force: force) ?? .failed("Not connected.", signIn: true)
            queue.async { answer(token) }
        }
    }

    private func send(_ request: URLRequest, id: Int, answer: EngineQueueOnly<JSValue>) {
        let owner = EngineQueueOnly(self)
        let queue = queue
        let task = session.dataTask(with: request) { data, response, error in
            queue.async {
                owner.value.tasks.removeValue(forKey: id)
                let done = answer.value
                guard let context = done.context else { return }
                if let error {
                    // A cancel came from JavaScript, which has already settled.
                    if (error as? URLError)?.code == .cancelled { return }
                    done.call(withArguments: [0, "", "{}", NSNull(), error.localizedDescription])
                    return
                }
                let http = response as? HTTPURLResponse
                let status = http?.statusCode ?? 0
                var fields: [String: String] = [:]
                for (name, value) in http?.allHeaderFields ?? [:] {
                    fields[String(describing: name).lowercased()] = String(describing: value)
                }
                let headersJSON = String(decoding: (try? JSONEncoder().encode(fields)) ?? Data("{}".utf8), as: UTF8.self)
                done.call(withArguments: [
                    status, HTTPURLResponse.localizedString(forStatusCode: status), headersJSON,
                    Self.arrayBuffer(data ?? Data(), in: context), NSNull(),
                ])
            }
        }
        task.delegate = NoRedirects.shared
        tasks[id] = task
        task.resume()
    }

    // MARK: Timers

    private func timer(after ms: Double, run: JSValue) -> Int {
        let id = nextId
        nextId += 1
        let job = EngineQueueOnly(run)
        let owner = EngineQueueOnly(self)
        let item = DispatchWorkItem {
            owner.value.timers.removeValue(forKey: id)
            job.value.call(withArguments: [])
        }
        timers[id] = item
        queue.asyncAfter(deadline: .now() + max(0, ms) / 1000, execute: item)
        return id
    }

    // MARK: Cloud

    /// The next stamp for a cloud record handed to Swift (HealthEngine.stamp).
    func stamp() -> Int {
        stamps += 1
        return stamps
    }

    private func cloudNatives() -> [String: Any] {
        // The engine calls these on its own queue only (see the type's comment).
        let owner = EngineQueueOnly(self)
        let accessToken: @convention(block) (String, Bool, JSValue) -> Void = { provider, force, done in
            let answer = EngineQueueOnly(done)
            let natives = owner.value
            natives.token(from: natives.quarantined ? nil : natives.cloud, provider: provider, force: force) { result in
                switch result {
                // The sentinel, never the token: EngineHTTP swaps it on an allowed call.
                case .token: answer.value.call(withArguments: [EngineHTTP.sentinelPrefix + provider, NSNull(), false])
                case .failed(let why, let signIn): answer.value.call(withArguments: [NSNull(), why, signIn])
                }
            }
        }
        let phoneRead: @convention(block) () -> String = {
            do {
                let text = try owner.value.phone?.read()
                return Self.json(["text": text.map { $0 as Any } ?? NSNull()])
            } catch {
                return Self.json(["error": error.localizedDescription])
            }
        }
        // Answers the error's words, or "" when the write landed (JavaScript reads "" as none).
        let phoneWrite: @convention(block) (String) -> String = { text in
            do {
                guard let phone = owner.value.phone else { return "Not connected." }
                try phone.write(text)
                return ""
            } catch {
                return error.localizedDescription
            }
        }
        let phoneRemove: @convention(block) () -> Void = {
            owner.value.phone?.remove()
        }
        let pending: @convention(block) (String) -> Bool = { op in
            owner.value.phone?.pending(op) ?? false
        }
        // In order, never waited for: the engine's queue must not block on the main thread.
        let notify: @convention(block) (String, String, Int) -> Void = { event, payload, session in
            let natives = owner.value
            if event == "changed", natives.openSession?.id == session,
               let view = try? JSONDecoder().decode(HealthEngine.CloudView.self, from: Data(payload.utf8)) {
                natives.openSession = (session, view.record)
            }
            guard let port = natives.cloud else { return }
            let order = natives.stamp()
            DispatchQueue.main.async { port.notify(event, payload, session: session, order: order) }
        }
        return [
            "accessToken": accessToken, "phoneRead": phoneRead, "phoneWrite": phoneWrite,
            "phoneRemove": phoneRemove, "pending": pending, "notify": notify,
        ]
    }

    private static func json(_ object: [String: Any]) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return String(decoding: data, as: UTF8.self)
    }

    // MARK: Bytes

    /// A JavaScript ArrayBuffer holding a copy of `data`, freed by the engine's collector.
    static func arrayBuffer(_ data: Data, in context: JSContext) -> JSValue {
        let count = data.count
        let bytes = UnsafeMutableRawPointer.allocate(byteCount: max(count, 1), alignment: 16)
        data.copyBytes(to: bytes.assumingMemoryBound(to: UInt8.self), count: count)
        let buffer = JSObjectMakeArrayBufferWithBytesNoCopy(context.jsGlobalContextRef, bytes, count, { bytes, _ in bytes?.deallocate() }, nil, nil)
        return JSValue(jsValueRef: buffer, in: context)
    }

    /// The bytes of a JavaScript ArrayBuffer; nil for null, undefined or anything else.
    static func data(_ value: JSValue) -> Data? {
        guard let context = value.context?.jsGlobalContextRef, value.isObject,
              JSValueGetTypedArrayType(context, value.jsValueRef, nil) == kJSTypedArrayTypeArrayBuffer,
              let object = JSValueToObject(context, value.jsValueRef, nil)
        else { return nil }
        let count = JSObjectGetArrayBufferByteLength(context, object, nil)
        guard count > 0, let bytes = JSObjectGetArrayBufferBytesPtr(context, object, nil) else { return Data() }
        return Data(bytes: bytes, count: count)
    }
}

/// Carries a value that is only ever touched on the engine's queue into a closure
/// the compiler must treat as concurrent (URLSession's completion, a work item).
/// JSValue and the natives are not Sendable; this is the one place that says
/// "engine queue only" instead of proving it.
struct EngineQueueOnly<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
