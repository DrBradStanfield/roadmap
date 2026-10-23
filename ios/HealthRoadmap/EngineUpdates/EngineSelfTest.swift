import Foundation

/// Proves a downloaded engine's doors work before the app trusts it (US-25 AC18):
/// run in a quarantined context (no network, no token, an in-memory phone file).
/// It catches accidents, a broken build or a door that drifted, not malice: a
/// hostile engine could pass it. The signature is what keeps hostile engines out.
enum EngineSelfTest {
    struct Failure: Error, Equatable {
        let step: String
    }

    private static let now = try! Date("2026-10-21T08:00:00.000Z", strategy: HealthEngine.iso)
    private static let device = "self-test"

    /// Throws `Failure` naming the first step that did not hold.
    static func run(_ engine: isolated HealthEngine, version: Int, schemaVersion: Int) throws {
        func check(_ ok: Bool, _ step: String) throws { if !ok { throw Failure(step: step) } }
        func value(_ name: String) -> Int? { try? engine.evaluate("HealthEngine.\(name)").toNumber()?.intValue }

        try check(value("engineVersion") == version, "version")
        try check(value("schemaVersion") == schemaVersion, "schema")
        for door in EngineRelease.doors {
            try check((try? engine.evaluate("typeof HealthEngine.\(door)").toString()) == "function", "door \(door)")
        }

        // A record, values in through edits, My data and the plan out.
        var record = try engine.newRecord(now: now, deviceId: device, locale: Locale(identifier: "en-NZ"), timeZone: TimeZone(identifier: "Pacific/Auckland")!)
        for edit: RecordEdit in [.profile(sex: "male", birthYear: 1970, birthMonth: 6, height: 178), .add(metric: "weight", value: 81, day: "2026-10-19"), .add(metric: "weight", value: 80, day: "2026-10-20")] {
            let outcome = try engine.apply(edit, to: record, now: now, deviceId: device)
            try check(outcome.ok, "edit")
            record = try outcome.record ?? { throw Failure(step: "edit") }()
        }
        let data = try engine.myData(recordJSON: record, now: now, deviceId: device)
        let weight = data.vitals.first { $0.metric == "weight" }?.latest
        try check(weight?.value == "80.0" && weight?.day == "2026-10-20", "my data")
        let plan = try engine.plan(recordJSON: record, now: now, deviceId: device)
        try check((try? JSONSerialization.jsonObject(with: Data(plan.utf8))) is [String: Any], "plan")
        _ = try engine.planView(record: record, units: "{}", now: now, deviceId: device)

        try merges(engine, record)
    }

    /// Merge goldens: no row lost or invented, entered-in-error stays sticky, the
    /// higher eraseEpoch wins, whichever side is local.
    private static func merges(_ engine: isolated HealthEngine, _ a: String) throws {
        func check(_ ok: Bool, _ step: String) throws { if !ok { throw Failure(step: step) } }
        guard let first = rows(a, "measurements")?.first(where: { $0["recordedAt"] as? String ?? "" < "2026-10-20" }),
              let firstId = first["id"] as? String
        else { throw Failure(step: "merge setup") }
        let corrected = try engine.apply(.correct(id: firstId, value: 82), to: a, now: now, deviceId: device)
        guard let b = corrected.record else { throw Failure(step: "merge setup") }

        let ids = Set(((rows(a, "measurements") ?? []) + (rows(b, "measurements") ?? [])).compactMap { $0["id"] as? String })
        for (local, remote) in [(a, b), (b, a)] {
            let merged = try engine.call("mergeJson", [local, remote, now.formatted(HealthEngine.iso), device])
            let out = rows(merged, "measurements") ?? []
            try check(Set(out.compactMap { $0["id"] as? String }) == ids && out.count == ids.count, "merge rows")
            try check(out.first { $0["id"] as? String == firstId }?["status"] as? String == "entered-in-error", "merge entered-in-error")
        }

        guard var erased = try JSONSerialization.jsonObject(with: Data(a.utf8)) as? [String: Any],
              var meta = erased["meta"] as? [String: Any]
        else { throw Failure(step: "merge setup") }
        meta["eraseEpoch"] = 1
        meta["erasedAt"] = now.formatted(HealthEngine.iso)
        erased["meta"] = meta
        let e = String(decoding: try JSONSerialization.data(withJSONObject: erased), as: UTF8.self)
        for (local, remote) in [(b, e), (e, b)] {
            let merged = try engine.call("mergeJson", [local, remote, now.formatted(HealthEngine.iso), device])
            let epoch = (try JSONSerialization.jsonObject(with: Data(merged.utf8)) as? [String: Any])?["meta"] as? [String: Any]
            try check(epoch?["eraseEpoch"] as? Int == 1, "merge eraseEpoch")
        }
    }

    private static func rows(_ json: String, _ key: String) -> [[String: Any]]? {
        (try? JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])?[key] as? [[String: Any]]
    }
}
