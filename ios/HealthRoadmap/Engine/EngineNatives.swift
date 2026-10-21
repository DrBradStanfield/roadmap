import Foundation
import JavaScriptCore

/// What the engine needs from the phone to sync (US-25 AC11): tokens, the
/// phone's record file, the pending marker and news of what happened.
/// `CloudSync` provides it; ios/engine/cloud.ts `CloudNatives` is its twin.
@MainActor
protocol CloudPort: AnyObject, Sendable {
    /// A current access token; `force` after the provider refused the last one.
    func accessToken(provider: String, force: Bool) async -> TokenAnswer
    /// The phone's record: its text, nil when there is none; throws when unreadable.
    func phoneRead() throws -> String?
    func phoneWrite(_ text: String) throws
    /// "get", "set" or "clear" the marker that says the phone holds changes the cloud lacks.
    func pending(_ op: String) -> Bool
    /// "saving", "saved", "synced", "failed" (payload: kind and detail) or
    /// "changed" (payload: the record), from engine session `session`.
    func notify(_ event: String, _ payload: String, session: Int)
}

enum TokenAnswer: Sendable {
    case token(String)
    /// `signIn`: only signing in again fixes it. Otherwise a retry may.
    case failed(String, signIn: Bool)
}

/// The primitives JavaScriptCore lacks, which ios/engine/shim.ts builds the
/// web's fetch, timers and text coding on (architecture.md D2), plus the
/// `CloudPort` calls. Installed as the global `__native` before the bundle runs.
/// JavaScript runs on the main queue only: every answer from URLSession or a
/// timer hops there before it touches a JSValue.
final class EngineNatives {
    weak var cloud: CloudPort?
    private let session: URLSession
    private var tasks: [Int: URLSessionTask] = [:]
    private var timers: [Int: DispatchWorkItem] = [:]
    private var nextId = 1

    init(session: URLSession) {
        self.session = session
    }

    func install(in context: JSContext) {
        let http: @convention(block) (String, String, String, JSValue, JSValue) -> Int = { [unowned self] method, url, headers, body, done in
            request(method: method, url: url, headers: headers, body: Self.data(body), done: done)
        }
        let cancelHttp: @convention(block) (Int) -> Void = { [unowned self] id in
            tasks.removeValue(forKey: id)?.cancel()
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
        let answer = MainQueueOnly(done)
        guard let address = URL(string: url) else {
            DispatchQueue.main.async { answer.value.call(withArguments: [0, "", "{}", NSNull(), "Not a web address."]) }
            return id
        }
        var request = URLRequest(url: address)
        request.httpMethod = method
        request.httpBody = body
        let fields = (try? JSONDecoder().decode([String: String].self, from: Data(headers.utf8))) ?? [:]
        for (name, value) in fields { request.setValue(value, forHTTPHeaderField: name) }
        let owner = MainQueueOnly(self)
        let task = session.dataTask(with: request) { data, response, error in
            DispatchQueue.main.async {
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
        tasks[id] = task
        task.resume()
        return id
    }

    // MARK: Timers

    private func timer(after ms: Double, run: JSValue) -> Int {
        let id = nextId
        nextId += 1
        let job = MainQueueOnly(run)
        let owner = MainQueueOnly(self)
        let item = DispatchWorkItem {
            owner.value.timers.removeValue(forKey: id)
            job.value.call(withArguments: [])
        }
        timers[id] = item
        DispatchQueue.main.asyncAfter(deadline: .now() + max(0, ms) / 1000, execute: item)
        return id
    }

    // MARK: Cloud

    private func cloudNatives() -> [String: Any] {
        // The engine calls these on the main queue only (see the type's comment).
        let owner = MainQueueOnly(self)
        let accessToken: @convention(block) (String, Bool, JSValue) -> Void = { provider, force, done in
            let answer = MainQueueOnly(done)
            let port = owner.value.cloud
            Task { @MainActor in
                let result = await port?.accessToken(provider: provider, force: force) ?? .failed("Not connected.", signIn: true)
                switch result {
                case .token(let token): answer.value.call(withArguments: [token, NSNull(), false])
                case .failed(let why, let signIn): answer.value.call(withArguments: [NSNull(), why, signIn])
                }
            }
        }
        let phoneRead: @convention(block) () -> String = {
            MainActor.assumeIsolated {
                do {
                    let text = try owner.value.cloud?.phoneRead()
                    return Self.json(["text": text.map { $0 as Any } ?? NSNull()])
                } catch {
                    return Self.json(["error": error.localizedDescription])
                }
            }
        }
        // Answers the error's words, or "" when the write landed (JavaScript reads "" as none).
        let phoneWrite: @convention(block) (String) -> String = { text in
            MainActor.assumeIsolated {
                do {
                    guard let cloud = owner.value.cloud else { return "Not connected." }
                    try cloud.phoneWrite(text)
                    return ""
                } catch {
                    return error.localizedDescription
                }
            }
        }
        let pending: @convention(block) (String) -> Bool = { op in
            MainActor.assumeIsolated { owner.value.cloud?.pending(op) ?? false }
        }
        let notify: @convention(block) (String, String, Int) -> Void = { event, payload, session in
            MainActor.assumeIsolated { owner.value.cloud?.notify(event, payload, session: session) }
        }
        return [
            "accessToken": accessToken, "phoneRead": phoneRead, "phoneWrite": phoneWrite,
            "pending": pending, "notify": notify,
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

/// Carries a value that is only ever touched on the main queue into a closure
/// the compiler must treat as concurrent (URLSession's completion, a work item).
/// JSValue and the natives are not Sendable; this is the one place that says
/// "main queue only" instead of proving it.
struct MainQueueOnly<Value>: @unchecked Sendable {
    let value: Value
    init(_ value: Value) { self.value = value }
}
