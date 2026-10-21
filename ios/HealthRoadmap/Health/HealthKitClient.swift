import Foundation
import HealthKit

/// The real `HealthStoreClient`: HealthKit's types, units and queries, and nothing
/// else. It converts to SI and to `HealthSample`; the engine decides the rest (D6).
@MainActor
final class HealthKitClient: HealthStoreClient {
    /// Our writes carry this prefix in their sync identifier, so they are never read back.
    nonisolated static let syncPrefix = "healthroadmap:"

    private let store = HKHealthStore()
    private var observers: [HKObserverQuery] = []

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    func requestAuthorization() async throws {
        let read = Set(HealthKind.allCases.flatMap(Self.quantityTypes))
        // Height is read, never written (see `save`), so the sheet does not ask to write it.
        let share = Set(HealthKind.allCases.filter { $0 != .height }.flatMap(Self.quantityTypes))
        try await store.requestAuthorization(toShare: share, read: read)
    }

    func samples(of kind: HealthKind, after anchor: Data?) async throws -> HealthBatch {
        let previous = anchor.flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0) }
        let descriptor = HKAnchoredObjectQueryDescriptor(predicates: [Self.predicate(kind)], anchor: previous)
        let result: HKAnchoredObjectQueryDescriptor<HKSample>.Result
        do {
            result = try await descriptor.result(for: store)
        } catch let error as HKError where error.code == .errorDatabaseInaccessible {
            throw HealthStoreError.locked
        }
        // `result.deletedObjects` is ignored on purpose: a reading deleted in Health stays in the record (D6).
        let ownBundle = Bundle.main.bundleIdentifier ?? ""
        let samples = result.addedSamples
            .filter { !Self.isOwn(bundleIdentifier: $0.sourceRevision.source.bundleIdentifier, syncIdentifier: $0.metadata?[HKMetadataKeySyncIdentifier] as? String, ownBundle: ownBundle) }
            .flatMap { Self.readings(from: $0, kind: kind) }
        let data = try NSKeyedArchiver.archivedData(withRootObject: result.newAnchor, requiringSecureCoding: true)
        return HealthBatch(samples: samples, anchor: data)
    }

    func deleteOwnSamples() async throws {
        // Ours by source, which every sample we saved carries; each with a
        // `healthroadmap:` sync id (D6). A kind never allowed for writing holds none.
        let mine = HKQuery.predicateForObjects(from: HKSource.default())
        for kind in HealthKind.allCases where kind != .height && canWrite(kind) {
            for type in Self.quantityTypes(kind) {
                _ = try await store.deleteObjects(of: type, predicate: mine)
            }
        }
    }

    func canWrite(_ kind: HealthKind) -> Bool {
        Self.quantityTypes(kind).allSatisfy { store.authorizationStatus(for: $0) == .sharingAuthorized }
    }

    func save(_ write: HealthWrite) async throws {
        guard let kind = write.kind, let date = write.date() else { return }
        let metadata: [String: Any] = [
            HKMetadataKeySyncIdentifier: Self.syncPrefix + write.syncId,
            HKMetadataKeySyncVersion: NSNumber(value: write.version),
        ]
        let object: HKObject
        switch kind {
        case .weight, .waist:
            let metric = kind == .weight ? "weight" : "waist"
            guard let value = write.values[metric] else { return }
            object = HKQuantitySample(type: HKQuantityType(Self.identifier(kind)), quantity: HKQuantity(unit: Self.unit(kind), doubleValue: value), start: date, end: date, metadata: metadata)
        case .bloodPressure:
            guard let systolic = write.values["systolic_bp"], let diastolic = write.values["diastolic_bp"] else { return }
            let mmHg = HKUnit.millimeterOfMercury()
            let halves: Set<HKSample> = [
                HKQuantitySample(type: HKQuantityType(.bloodPressureSystolic), quantity: HKQuantity(unit: mmHg, doubleValue: systolic), start: date, end: date),
                HKQuantitySample(type: HKQuantityType(.bloodPressureDiastolic), quantity: HKQuantity(unit: mmHg, doubleValue: diastolic), start: date, end: date),
            ]
            object = HKCorrelation(type: HKCorrelationType(.bloodPressure), start: date, end: date, objects: halves, metadata: metadata)
        case .height:
            return // Not written: the profile has no source, so an imported height would echo (D6).
        }
        do {
            try await store.save(object)
        } catch let error as HKError where error.code == .errorDatabaseInaccessible {
            throw HealthStoreError.locked
        }
    }

    func observe(_ kinds: [HealthKind], onChange: @escaping @MainActor () async -> Void) {
        for kind in kinds {
            let type = Self.sampleType(kind)
            // Background delivery wakes the app when Health gets data; it needs the
            // background-delivery entitlement, and fails quietly without it.
            store.enableBackgroundDelivery(for: type, frequency: .immediate) { _, _ in }
            let query = HKObserverQuery(sampleType: type, predicate: nil) { _, completion, error in
                guard error == nil else { completion(); return }
                // HealthKit's completion may be called from any thread; it tells iOS the
                // background work is done, so it waits until the import has saved.
                nonisolated(unsafe) let completion = completion
                Task { @MainActor in
                    await onChange()
                    completion()
                }
            }
            store.execute(query)
            observers.append(query)
        }
    }

    // MARK: Pure parts (tested)

    /// A sample this app wrote, on this phone or another of the person's (Health syncs
    /// between them): our bundle, or our sync-identifier prefix.
    nonisolated static func isOwn(bundleIdentifier: String?, syncIdentifier: String?, ownBundle: String) -> Bool {
        bundleIdentifier == ownBundle || syncIdentifier?.hasPrefix(syncPrefix) == true
    }

    // MARK: HealthKit types

    private static func identifier(_ kind: HealthKind) -> HKQuantityTypeIdentifier {
        switch kind {
        case .weight: .bodyMass
        case .height: .height
        case .waist: .waistCircumference
        case .bloodPressure: .bloodPressureSystolic
        }
    }

    private static func unit(_ kind: HealthKind) -> HKUnit {
        switch kind {
        case .weight: .gramUnit(with: .kilo)
        case .height, .waist: .meterUnit(with: .centi)
        case .bloodPressure: .millimeterOfMercury()
        }
    }

    /// What permission is asked for: blood pressure is asked as its two halves,
    /// because iOS does not authorise correlation types.
    private static func quantityTypes(_ kind: HealthKind) -> [HKQuantityType] {
        kind == .bloodPressure
            ? [HKQuantityType(.bloodPressureSystolic), HKQuantityType(.bloodPressureDiastolic)]
            : [HKQuantityType(identifier(kind))]
    }

    /// What is queried: blood pressure as the correlation, so both halves come together.
    private static func sampleType(_ kind: HealthKind) -> HKSampleType {
        kind == .bloodPressure ? HKCorrelationType(.bloodPressure) : HKQuantityType(identifier(kind))
    }

    private static func predicate(_ kind: HealthKind) -> HKSamplePredicate<HKSample> {
        kind == .bloodPressure
            ? .sample(type: HKCorrelationType(.bloodPressure))
            : .sample(type: HKQuantityType(identifier(kind)))
    }

    /// One Health sample as the record's readings: one, or two for a blood pressure,
    /// each half keeping its own UUID so each row has its own `externalId`.
    private static func readings(from sample: HKSample, kind: HealthKind) -> [HealthSample] {
        if let correlation = sample as? HKCorrelation {
            let mmHg = HKUnit.millimeterOfMercury()
            return correlation.objects.compactMap { $0 as? HKQuantitySample }.compactMap { half in
                let metric: String? = switch half.quantityType {
                case HKQuantityType(.bloodPressureSystolic): "systolic_bp"
                case HKQuantityType(.bloodPressureDiastolic): "diastolic_bp"
                default: nil
                }
                guard let metric else { return nil }
                return HealthSample(id: half.uuid, metric: metric, value: half.quantity.doubleValue(for: mmHg), at: correlation.startDate, timeZone: zone(of: correlation), pairId: correlation.uuid)
            }
        }
        guard let quantity = sample as? HKQuantitySample else { return [] }
        let metric = switch kind {
        case .weight: "weight"
        case .height: "height"
        case .waist: "waist"
        case .bloodPressure: ""
        }
        guard !metric.isEmpty else { return [] }
        return [HealthSample(id: quantity.uuid, metric: metric, value: quantity.quantity.doubleValue(for: unit(kind)), at: quantity.startDate, timeZone: zone(of: quantity))]
    }

    /// The zone the reading was taken in, when its writer recorded one (the Health app
    /// and many scales do), else the phone's: a first import of years of history run
    /// while travelling must not move every reading onto another day, for good.
    private static func zone(of sample: HKSample) -> TimeZone {
        (sample.metadata?[HKMetadataKeyTimeZone] as? String).flatMap(TimeZone.init(identifier:)) ?? .current
    }
}
