import Foundation

/// What the app needs from HealthKit, behind a protocol so tests run on a fake
/// (AppleHealthSyncTests) and the sync logic never touches HealthKit types.
/// The real one is `HealthKitClient`.
@MainActor
protocol HealthStoreClient: AnyObject {
    /// False where the device has no Health database.
    var isAvailable: Bool { get }
    /// Shows Apple's permission sheet for reading and writing the D6 kinds.
    func requestAuthorization() async throws
    /// Readings added since `anchor` (nil: all of them), our own writes left out.
    /// Deletions are not returned: the record is append-only (D6).
    func samples(of kind: HealthKind, after anchor: Data?) async throws -> HealthBatch
    /// Whether the person let the app write this kind. iOS never reveals read permission.
    func canWrite(_ kind: HealthKind) -> Bool
    /// Saves one value, replacing our earlier sample with the same sync id and a lower version.
    func save(_ write: HealthWrite) async throws
    /// Calls `onChange` whenever Health gets new data of these kinds, in the background too.
    func observe(_ kinds: [HealthKind], onChange: @escaping @MainActor () async -> Void)
}

enum HealthStoreError: LocalizedError {
    /// The phone is locked: Health's database is encrypted until it is unlocked.
    case locked

    var errorDescription: String? { "Apple Health can be read once the iPhone is unlocked." }
}
