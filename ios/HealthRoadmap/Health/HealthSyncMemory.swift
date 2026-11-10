import Foundation

/// What the Apple Health sync remembers between launches, kept OUT of the record
/// (ios/architecture.md D6): it is this phone's bookkeeping, not health data, and
/// another device reading the record must not inherit it.
/// - whether the person connected Apple Health (iOS never says whether reading is allowed);
/// - one HealthKit query anchor per kind, and one for lab results (US-72), so each launch
///   reads only what is new, with the lab results rules version that anchor was read under;
/// - when Health's lab results sheet was last shown, so coming on screen asks only once (US-72 AC1);
/// - the version of each value already written to Health, so it is written once;
/// - the last record erase this phone saw, and on which record (US-72 AC10, `EraseGate`).
struct HealthSyncMemory {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .app) {
        self.defaults = defaults
    }

    var connected: Bool {
        get { defaults.bool(forKey: "appleHealth.connected") }
        nonmutating set { defaults.set(newValue, forKey: "appleHealth.connected") }
    }

    func anchor(for kind: HealthKind) -> Data? {
        defaults.data(forKey: "appleHealth.anchor.\(kind.rawValue)")
    }

    func setAnchor(_ anchor: Data?, for kind: HealthKind) {
        defaults.set(anchor, forKey: "appleHealth.anchor.\(kind.rawValue)")
    }

    /// Lab results' anchor (US-72): nil until a batch brought one in.
    var labResultsAnchor: Data? {
        get { defaults.data(forKey: "appleHealth.anchor.labResults") }
        nonmutating set { defaults.set(newValue, forKey: "appleHealth.anchor.labResults") }
    }

    /// Bumped when the engine starts reading lab results it used to refuse (a new code or
    /// unit): a phone whose anchor was kept under an older version reads every result again.
    /// 2: results dated by `issued`, the MDRD eGFR and the import winning a conflict (US-72).
    static let labResultsRulesVersion = 2

    /// The rules version the lab results anchor was kept under; 0 before this was stored.
    var labResultsRules: Int {
        get { defaults.integer(forKey: "appleHealth.labResultsRules") }
        nonmutating set { defaults.set(newValue, forKey: "appleHealth.labResultsRules") }
    }

    /// When the app last showed Health's lab results sheet (US-72 AC1, AC14): on connect, on
    /// coming on screen or from Settings' row; nil: never. Once set, coming on screen never asks.
    var labResultsAsked: Date? {
        get { defaults.object(forKey: "appleHealth.labResultsAsked") as? Date }
        nonmutating set { defaults.set(newValue, forKey: "appleHealth.labResultsAsked") }
    }

    /// The record erase the sync last saw, with its source: one value, written in one step.
    var eraseSeen: EraseSeen? {
        get { defaults.data(forKey: "appleHealth.eraseSeen").flatMap { try? JSONDecoder().decode(EraseSeen.self, from: $0) } }
        nonmutating set { defaults.set(newValue.flatMap { try? JSONEncoder().encode($0) }, forKey: "appleHealth.eraseSeen") }
    }

    /// The sync ids of every value this app wrote to Health (US-72 AC10: what a remote erase deletes).
    var writtenIds: [String] {
        defaults.dictionary(forKey: "appleHealth.written").map { Array($0.keys) } ?? []
    }

    func writtenVersion(_ syncId: String) -> Int64 {
        (defaults.dictionary(forKey: "appleHealth.written")?[syncId] as? NSNumber)?.int64Value ?? 0
    }

    /// After an erase deleted our samples from Health: nothing is written any more.
    func forgetWritten() {
        defaults.removeObject(forKey: "appleHealth.written")
    }

    func setWritten(_ version: Int64, for syncId: String) {
        var written = defaults.dictionary(forKey: "appleHealth.written") ?? [:]
        written[syncId] = NSNumber(value: version)
        defaults.set(written, forKey: "appleHealth.written")
    }
}

/// A record erase (its `eraseEpoch`) and the record it was on: "phone", or the cloud's name.
struct EraseSeen: Codable, Equatable {
    let epoch: Int
    let source: String
}

/// What the Apple Health sync does about the record's erase (US-72 AC10): a newer erase
/// on the record it saw before disconnects Apple Health; a first look, a new record source,
/// or an erase while not connected is taken as seen and never disconnects (a fresh
/// Connect after a reinstall keeps its rows). Anything else keeps.
enum EraseGate: Equatable {
    case keep, disconnect, adopt

    static func decide(connected: Bool, seen: EraseSeen?, recordErase: Int, recordSource: String) -> EraseGate {
        guard let seen, seen.source == recordSource else { return .adopt }
        guard recordErase > seen.epoch else { return .keep }
        return connected ? .disconnect : .adopt
    }
}
