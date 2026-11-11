import Foundation
import HealthKit

/// The real `HealthStoreClient`: HealthKit's types, units and queries, and nothing
/// else. It converts to SI and to `HealthSample`; the engine decides the rest (D6).
@MainActor
final class HealthKitClient: HealthStoreClient {
    /// Our writes carry this prefix in their sync identifier, so they are never read back.
    nonisolated static let syncPrefix = "healthroadmap:"

    private let store = HKHealthStore.app
    private var observers: [HKObserverQuery] = []

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    /// Apple's own check: the phone's region, or records already downloaded (US-72 AC1).
    var supportsHealthRecords: Bool { store.supportsHealthRecords() }

    func requestAuthorization() async throws -> Bool {
        let (share, read) = Self.requested
        // Lab results only where Health Records works (US-72 AC1): elsewhere the sheet offers nothing.
        guard supportsHealthRecords else {
            try await store.requestAuthorization(toShare: share, read: read)
            return false
        }
        // Asked first: once the request is answered, Health no longer says it was needed (AC13).
        let asking = try await store.statusForAuthorizationRequest(toShare: [], read: [Self.labResults]) == .shouldRequest
        try await store.requestAuthorization(toShare: share, read: read.union([Self.labResults]))
        return asking
    }

    func requestLabResults() async throws -> Bool {
        guard try await store.statusForAuthorizationRequest(toShare: [], read: [Self.labResults]) == .shouldRequest else { return false }
        try await store.requestAuthorization(toShare: [], read: [Self.labResults])
        return true
    }

    /// Everything the app asks Apple Health for, in one request (Brad 2026-10-26: "just do it
    /// in one step"): the D6 kinds, sex and date of birth for onboarding to preselect (US-54
    /// AC3), and US-56's four live types, read only (AC4). iOS shows only the types not yet asked.
    static let requested: (share: Set<HKSampleType>, read: Set<HKObjectType>) = {
        let characteristics: Set<HKObjectType> = [HKCharacteristicType(.biologicalSex), HKCharacteristicType(.dateOfBirth)]
        let read = Set<HKObjectType>(HealthKind.allCases.flatMap(quantityTypes)).union(characteristics).union(LiveHealthKitStore.readTypes)
        // Height is read, never written (see `save`), so the sheet does not ask to write it.
        let share = Set<HKSampleType>(HealthKind.allCases.filter { $0 != .height }.flatMap(quantityTypes))
        return (share, read)
    }()

    func samples(of kind: HealthKind, after anchor: Data?) async throws -> HealthBatch {
        let (added, data) = try await addedSamples(Self.predicate(kind), after: anchor)
        // Deletions are ignored on purpose: a reading deleted in Health stays in the record (D6).
        let ownBundle = Bundle.main.bundleIdentifier ?? ""
        let samples = added
            .filter { !Self.isOwn(bundleIdentifier: $0.sourceRevision.source.bundleIdentifier, syncIdentifier: $0.metadata?[HKMetadataKeySyncIdentifier] as? String, ownBundle: ownBundle) }
            .flatMap { Self.readings(from: $0, kind: kind) }
        return HealthBatch(samples: samples, anchor: data)
    }

    func labResults(after anchor: Data?) async throws -> HealthRecordBatch {
        let (added, data) = try await addedSamples(.clinicalRecord(type: Self.labResults), after: anchor)
        // Deletions ignored, as for vitals (D6): the engine decides what an amendment does.
        let records = added.compactMap { sample -> HealthRecord? in
            guard let resource = sample.fhirResource, let json = String(data: resource.data, encoding: .utf8) else { return nil }
            // AC5: the source is the bundle id alone (`com.apple.public.health.clinical.<UUID>`),
            // one per institution account (Apple: a FHIR id is unique only within a resource type
            // and its source). The institution's name stays out of the record, and a renamed
            // institution is not a new source.
            return HealthRecord(sourceId: sample.sourceRevision.source.bundleIdentifier,
                                resourceType: resource.resourceType.rawValue, fhirVersion: resource.fhirVersion.stringRepresentation, json: json)
        }
        return HealthRecordBatch(records: records, anchor: data)
    }

    /// One anchored query: what was added since `anchor`, and the anchor to keep. A locked phone throws `.locked`.
    private func addedSamples<Sample: HKSample>(_ predicate: HKSamplePredicate<Sample>, after anchor: Data?) async throws -> (added: [Sample], anchor: Data) {
        let previous = anchor.flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0) }
        let descriptor = HKAnchoredObjectQueryDescriptor(predicates: [predicate], anchor: previous)
        let result: HKAnchoredObjectQueryDescriptor<Sample>.Result
        do {
            result = try await descriptor.result(for: store)
        } catch let error as HKError where error.code == .errorDatabaseInaccessible {
            throw HealthStoreError.locked
        }
        return (result.addedSamples, try NSKeyedArchiver.archivedData(withRootObject: result.newAnchor, requiringSecureCoding: true))
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

    func deleteSamples(syncIds: [String]) async throws -> [String] {
        guard !syncIds.isEmpty else { return [] }
        // Weight and waist samples carry the sync ids, a blood pressure's correlation does and
        // its halves go with it. A kind whose write access is off is not asked: its ids stay.
        let ours = Self.deletePredicate(syncIds: syncIds)
        let types: [(HealthKind, HKSampleType)] = [(.weight, HKQuantityType(.bodyMass)), (.waist, HKQuantityType(.waistCircumference)),
                                                   (.bloodPressure, HKCorrelationType(.bloodPressure))]
        var deleted: Set<String> = []
        var blocked = false
        do {
            for (kind, type) in types {
                guard canWrite(kind) else { blocked = true; continue }
                var found: [HKObject] = []
                for sample in try await HKSampleQueryDescriptor(predicates: [.sample(type: type, predicate: ours)], sortDescriptors: []).result(for: store) {
                    found.append(sample)
                    if let pair = sample as? HKCorrelation { found += pair.objects }
                }
                if !found.isEmpty { try await store.delete(found) }
                deleted.formUnion(found.compactMap { ($0.metadata?[HKMetadataKeySyncIdentifier] as? String)?.dropFirst(Self.syncPrefix.count) }.map(String.init))
            }
        } catch let error as HKError where error.code == .errorDatabaseInaccessible {
            throw HealthStoreError.locked
        }
        // With a kind not asked, an id not found may be that kind's: it stays owed.
        return blocked ? syncIds.filter { !deleted.contains($0) } : []
    }

    /// What a remote erase deletes (US-72 AC10): our sync ids AND this app as the source, so a
    /// sample another app saved with a matching id stays.
    static func deletePredicate(syncIds: [String]) -> NSPredicate {
        NSCompoundPredicate(andPredicateWithSubpredicates: [
            HKQuery.predicateForObjects(withMetadataKey: HKMetadataKeySyncIdentifier, allowedValues: syncIds.map { syncPrefix + $0 }),
            HKQuery.predicateForObjects(from: HKSource.default()),
        ])
    }

    func characteristics() -> HealthCharacteristics {
        // Each throws when not allowed; iOS never says which.
        let sex = (try? store.biologicalSex().biologicalSex).map { value -> String in
            switch value {
            case .female: "female"
            case .male: "male"
            case .other: "other"
            default: "notSet"
            }
        }
        return HealthCharacteristics(sex: sex, birth: try? store.dateOfBirthComponents())
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

    /// Once per process: the launch registers first (`observeAtLaunch`), and the
    /// sync's own `start` then keeps those queries rather than adding a second set.
    func observe(_ kinds: [HealthKind], onChange: @escaping @MainActor () async -> Void) {
        guard observers.isEmpty else { return }
        // Lab results too, where Health Records works (US-72). If background delivery is refused
        // for them, the observer still runs while the app is open, and unlock and coming to the
        // foreground refresh as for vitals.
        for type in Self.observedTypes(kinds, labResults: supportsHealthRecords) {
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

    func stopObserving() {
        observers.forEach(store.stop)
        observers = []
        store.disableAllBackgroundDelivery { _, _ in }
    }

    // MARK: Pure parts (tested)

    /// A sample this app wrote, on this phone or another of the person's (Health syncs
    /// between them): our bundle, or our sync-identifier prefix.
    nonisolated static func isOwn(bundleIdentifier: String?, syncIdentifier: String?, ownBundle: String) -> Bool {
        bundleIdentifier == ownBundle || syncIdentifier?.hasPrefix(syncPrefix) == true
    }

    // MARK: HealthKit types

    /// Lab results, the one Health Records type the app reads (US-72): read-only by Apple's rule.
    nonisolated static let labResults = HKClinicalType(.labResultRecord)

    private nonisolated static func identifier(_ kind: HealthKind) -> HKQuantityTypeIdentifier {
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
    nonisolated static func quantityTypes(_ kind: HealthKind) -> [HKQuantityType] {
        kind == .bloodPressure
            ? [HKQuantityType(.bloodPressureSystolic), HKQuantityType(.bloodPressureDiastolic)]
            : [HKQuantityType(identifier(kind))]
    }

    /// What is observed: blood pressure as its two halves, because Apple refuses
    /// `HKCorrelationType` for background delivery. One reading fires both observers;
    /// `AppleHealthSync.refresh` folds the second into the run already going.
    nonisolated static func observedTypes(_ kinds: [HealthKind], labResults: Bool) -> [HKSampleType] {
        let vitals: [HKSampleType] = kinds.flatMap(quantityTypes)
        return labResults ? vitals + [Self.labResults] : vitals
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

extension HKHealthStore {
    /// The app's one Health store, as Apple recommends: `HealthKitClient`, `LiveHealthKitStore`
    /// and the DEBUG seed share it.
    static let app = HKHealthStore()
}
