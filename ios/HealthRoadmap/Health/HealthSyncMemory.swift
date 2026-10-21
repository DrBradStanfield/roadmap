import Foundation

/// What the Apple Health sync remembers between launches, kept OUT of the record
/// (ios/architecture.md D6): it is this phone's bookkeeping, not health data, and
/// another device reading the record must not inherit it.
/// - whether the person connected Apple Health (iOS never says whether reading is allowed);
/// - one HealthKit query anchor per kind, so each launch reads only what is new;
/// - the version of each value already written to Health, so it is written once.
struct HealthSyncMemory {
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
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
