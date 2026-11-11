import Foundation

/// What the app needs from HealthKit, behind a protocol so tests run on a fake
/// (AppleHealthSyncTests) and the sync logic never touches HealthKit types.
/// The real one is `HealthKitClient`.
@MainActor
protocol HealthStoreClient: AnyObject {
    /// False where the device has no Health database.
    var isAvailable: Bool { get }
    /// Where Health Records works (US-72 AC1): `HKHealthStore.supportsHealthRecords()`.
    var supportsHealthRecords: Bool { get }
    /// Shows Apple's permission sheet for reading and writing the D6 kinds, and reading
    /// US-56's five and, where `supportsHealthRecords`, lab results: the app's only Health
    /// request (`HealthKitClient.requested`). True when it asked for lab results HealthKit
    /// had not asked about before, so Health showed their sheet (AC13).
    func requestAuthorization() async throws -> Bool
    /// Lab results alone, where `supportsHealthRecords`, for a person connected before they
    /// were asked for (US-72 AC1), once (`HealthSyncMemory.labResultsAsked`): asks only when HealthKit
    /// says a request is needed, and is then true (Health showed its sheet, AC13).
    func requestLabResults() async throws -> Bool
    /// Readings added since `anchor` (nil: all of them), our own writes left out.
    /// Deletions are not returned: the record is append-only (D6).
    func samples(of kind: HealthKind, after anchor: Data?) async throws -> HealthBatch
    /// Lab results from Health Records added since `anchor` (nil: all of them), US-72.
    /// Deletions are not returned: an amended or withdrawn result arrives as a new version.
    func labResults(after anchor: Data?) async throws -> HealthRecordBatch
    /// Whether the person let the app write this kind. iOS never reveals read permission.
    func canWrite(_ kind: HealthKind) -> Bool
    /// Saves one value, replacing our earlier sample with the same sync id and a lower version.
    func save(_ write: HealthWrite) async throws
    /// Calls `onChange` whenever Health gets new data of these kinds, and new lab results
    /// where `supportsHealthRecords`, in the background too.
    func observe(_ kinds: [HealthKind], onChange: @escaping @MainActor () async -> Void)
    /// An erase disconnected Apple Health (US-72 AC10): stops every observer query and background delivery.
    func stopObserving()
    /// "Delete all my data" (US-25 AC16): deletes every sample this app wrote to Health.
    /// Readings other apps and devices wrote stay: they are not ours to delete.
    func deleteOwnSamples() async throws
    /// Another device's erase (US-72 AC10): deletes the samples with these sync ids, the ones
    /// this phone remembers writing (`HealthSyncMemory.writtenIds`), and only where this app
    /// is their source: never a query by source alone.
    func deleteSamples(syncIds: [String]) async throws
    /// Sex and birth month and year for onboarding to preselect (US-54 AC3); `.none`
    /// when not allowed or not set. Read on demand, never stored by this call.
    func characteristics() -> HealthCharacteristics
}

enum HealthStoreError: LocalizedError {
    /// The phone is locked: Health's database is encrypted until it is unlocked.
    case locked

    var errorDescription: String? { "Apple Health can be read once the iPhone is unlocked." }
}
