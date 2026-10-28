import Foundation

/// Per-test display units (US-25 AC17e), the web's per-field unit chips: a test shown
/// in the other units than the record's. Like the web's, this is the device's own
/// preference, never written to the record, and the master Metric/US switch clears it.
/// The engine reads it (ios/engine/unit-choices.ts) to show and to read typed values.
struct UnitChoices: Equatable {
    private var byMetric: [String: String] = [:] {
        didSet { json = Self.encode(byMetric) }
    }
    /// The choices as the engine takes them: kept, not rebuilt on every render.
    private(set) var json = "{}"

    var isEmpty: Bool { byMetric.isEmpty }

    /// The units `metric` shows: its choice, else the record's.
    func system(for metric: String, record: String) -> String { byMetric[metric] ?? record }

    /// With `metric` set to `system`, or its choice dropped when `system` is nil.
    func setting(_ metric: String, to system: String?) -> UnitChoices {
        var next = self
        next.byMetric[metric] = system
        return next
    }

    private static func encode(_ byMetric: [String: String]) -> String {
        String(decoding: (try? JSONSerialization.data(withJSONObject: byMetric, options: .sortedKeys)) ?? Data("{}".utf8), as: UTF8.self)
    }

    private static let key = "unitChoices.v1"

    static func saved(_ defaults: UserDefaults = .app) -> UnitChoices {
        var choices = UnitChoices()
        choices.byMetric = (defaults.dictionary(forKey: key) as? [String: String]) ?? [:]
        return choices
    }

    func save(_ defaults: UserDefaults = .app) {
        if byMetric.isEmpty { defaults.removeObject(forKey: Self.key) } else { defaults.set(byMetric, forKey: Self.key) }
    }
}
