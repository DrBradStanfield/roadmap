import Foundation

/// What the Apple Health sync remembers between launches, kept OUT of the record
/// (ios/architecture.md D6): it is this phone's bookkeeping, not health data, and
/// another device reading the record must not inherit it.
/// - whether the person connected Apple Health (iOS never says whether reading is allowed);
/// - one HealthKit query anchor per kind, and one for lab results (US-72), so each launch
///   reads only what is new, with the lab results rules version that anchor was read under;
/// - when Health's lab results sheet was last shown, so coming on screen asks only once (US-72 AC1);
/// - the version of each value already written to Health, so it is written once, and the
///   delete an erase still owes (US-72 AC10);
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

    /// The version of each value this app wrote to Health while connected.
    func writtenVersion(_ syncId: String) -> Int64 {
        versions("appleHealth.written")[syncId] ?? 0
    }

    func setWritten(_ version: Int64, for syncId: String) {
        var written = versions("appleHealth.written")
        written[syncId] = version
        set(written, "appleHealth.written")
    }

    /// The delete still owed (US-72 AC10), by sync id and version: what an erase found written
    /// (`oweWritten`) and any save that landed after it. Never a live sample: a Connect that
    /// comes before the delete succeeds starts a new written list beside it (edge 1).
    /// A pass never writes an owed id; it is written again once its delete is paid.
    var owed: [String: Int64] { versions("appleHealth.owed") }

    /// An erase disconnected Apple Health: every value written is owed.
    func oweWritten() {
        for (syncId, version) in versions("appleHealth.written") { owe(version, for: syncId) }
        set([:], "appleHealth.written")
    }

    /// A save that landed after an erase disconnected Health; the newer version is kept.
    func owe(_ version: Int64, for syncId: String) {
        var owed = owed
        owed[syncId] = max(owed[syncId] ?? 0, version)
        set(owed, "appleHealth.owed")
    }

    /// After a delete of `deleted`: each entry leaves unless a newer version of it was saved
    /// meanwhile, which stays owed (Codex C-R1: a correction keeps its sync id).
    func paid(_ deleted: [String: Int64]) {
        var owed = owed
        for (syncId, version) in deleted where owed[syncId] == version { owed[syncId] = nil }
        set(owed, "appleHealth.owed")
    }

    /// The kind of each value the record lists for Health, and of each id still owed (lead H29):
    /// an owed id Health did not find under a kind it could write is gone, not owed. Nil: not known
    /// (written before this was kept), so it stays owed while any kind is unwritable.
    func kind(_ syncId: String) -> HealthKind? {
        (defaults.dictionary(forKey: "appleHealth.kinds")?[syncId] as? String).flatMap(HealthKind.init)
    }

    /// Each pass: the kinds of `writes`, and those of the ids still owed (an erase empties the record).
    func learnKinds(_ writes: [HealthWrite]) {
        let stored = defaults.dictionary(forKey: "appleHealth.kinds") as? [String: String] ?? [:]
        let owed = owed
        let kinds = stored.filter { owed[$0.key] != nil }.merging(writes.compactMap { write in write.kind.map { (write.syncId, $0.rawValue) } }) { $1 }
        guard kinds != stored else { return }
        defaults.set(kinds.isEmpty ? nil : kinds, forKey: "appleHealth.kinds")
    }

    private func versions(_ key: String) -> [String: Int64] {
        (defaults.dictionary(forKey: key) ?? [:]).compactMapValues { ($0 as? NSNumber)?.int64Value }
    }

    /// The last entry gone removes the key.
    private func set(_ versions: [String: Int64], _ key: String) {
        defaults.set(versions.isEmpty ? nil : versions.mapValues { NSNumber(value: $0) }, forKey: key)
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
