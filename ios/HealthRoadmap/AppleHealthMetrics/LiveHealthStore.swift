import Foundation
import HealthKit

/// What US-56 needs from HealthKit, behind a protocol so the tests run on a fake. Reads
/// only: the app writes none of these types (AC2). Every call runs off the main thread.
protocol LiveHealthStore: Sendable {
    /// False where the device has no Health database (an iPad without Health, AC13).
    var isAvailable: Bool { get }
    /// Whether Apple's sheet would still show for the five types (AC4).
    func needsRequest() async -> Bool
    /// Shows Apple's sheet for reading exactly the five types (AC10).
    func requestAccess() async throws
    /// One point per `component` (an hour or a day) from `start` to `end`, HealthKit's own
    /// statistics: steps summed; heart rate lowest, highest and average; resting heart rate
    /// and VO2 max averaged. Not sleep.
    func points(_ metric: LiveMetric, from start: Date, to end: Date, every component: Calendar.Component) async throws -> [LivePoint]
    /// The newest heart rate sample, for its card.
    func latestHeartRate() async throws -> (value: Double, date: Date)?
    /// Sleep samples overlapping `start` to `end`.
    func sleep(from start: Date, to end: Date) async throws -> [SleepSegment]
}

enum LiveHealthError: Error, Equatable {
    /// The phone is locked: Health's database is encrypted until it is unlocked (AC13).
    case locked
}

/// The real `LiveHealthStore`. Its own `HKHealthStore`, apart from `HealthKitClient`, so
/// US-54's six types and this story's five never share a request (AC4).
final class LiveHealthKitStore: LiveHealthStore {
    private let store = HKHealthStore()

    /// The five types, and nothing else (AC10).
    static var readTypes: Set<HKObjectType> {
        Set(LiveMetric.allCases.map(type(of:)))
    }

    static func type(of metric: LiveMetric) -> HKObjectType {
        switch metric {
        case .heartRate: HKQuantityType(.heartRate)
        case .restingHeartRate: HKQuantityType(.restingHeartRate)
        case .sleep: HKCategoryType(.sleepAnalysis)
        case .vo2Max: HKQuantityType(.vo2Max)
        case .steps: HKQuantityType(.stepCount)
        }
    }

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    @concurrent
    func needsRequest() async -> Bool {
        // An error (unknown) shows the card: tapping it is harmless.
        let status = try? await store.statusForAuthorizationRequest(toShare: [], read: Self.readTypes)
        return status != .unnecessary
    }

    @concurrent
    func requestAccess() async throws {
        try await store.requestAuthorization(toShare: [], read: Self.readTypes)
    }

    @concurrent
    func points(_ metric: LiveMetric, from start: Date, to end: Date, every component: Calendar.Component) async throws -> [LivePoint] {
        guard metric != .sleep, let type = Self.type(of: metric) as? HKQuantityType else { return [] }
        let options: HKStatisticsOptions = switch metric {
        case .steps: .cumulativeSum
        case .heartRate: [.discreteMin, .discreteMax, .discreteAverage]
        default: .discreteAverage
        }
        let calendar = Calendar.current
        let anchor = calendar.dateInterval(of: component, for: start)?.start ?? start
        var interval = DateComponents()
        interval.setValue(1, for: component)
        let descriptor = HKStatisticsCollectionQueryDescriptor(
            predicate: .quantitySample(type: type, predicate: HKQuery.predicateForSamples(withStart: start, end: end)),
            options: options, anchorDate: anchor, intervalComponents: interval)
        let collection = try await Self.locking { try await descriptor.result(for: store) }
        let unit = Self.unit(metric)
        var points: [LivePoint] = []
        collection.enumerateStatistics(from: start, to: end) { statistics, _ in
            let point = LivePoint(start: statistics.startDate,
                                  value: (metric == .steps ? statistics.sumQuantity() : statistics.averageQuantity())?.doubleValue(for: unit),
                                  low: statistics.minimumQuantity()?.doubleValue(for: unit),
                                  high: statistics.maximumQuantity()?.doubleValue(for: unit))
            if point.value != nil || point.low != nil { points.append(point) }
        }
        return points
    }

    @concurrent
    func latestHeartRate() async throws -> (value: Double, date: Date)? {
        let descriptor = HKSampleQueryDescriptor(predicates: [.quantitySample(type: HKQuantityType(.heartRate))],
                                                 sortDescriptors: [SortDescriptor(\.endDate, order: .reverse)], limit: 1)
        let samples = try await Self.locking { try await descriptor.result(for: store) }
        return samples.first.map { ($0.quantity.doubleValue(for: Self.unit(.heartRate)), $0.endDate) }
    }

    @concurrent
    func sleep(from start: Date, to end: Date) async throws -> [SleepSegment] {
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: HKQuery.predicateForSamples(withStart: start, end: end))],
            sortDescriptors: [SortDescriptor(\.startDate)])
        let samples = try await Self.locking { try await descriptor.result(for: store) }
        return samples.compactMap { sample in
            Self.stage(sample.value).map { SleepSegment(stage: $0, start: sample.startDate, end: sample.endDate, source: sample.sourceRevision.source.bundleIdentifier) }
        }
    }

    // MARK: Pure parts

    static func stage(_ value: Int) -> SleepStage? {
        switch HKCategoryValueSleepAnalysis(rawValue: value) {
        case .inBed: .inBed
        case .awake: .awake
        case .asleepREM: .rem
        case .asleepCore: .core
        case .asleepDeep: .deep
        case .asleepUnspecified: .asleep
        default: nil
        }
    }

    private static func unit(_ metric: LiveMetric) -> HKUnit {
        switch metric {
        case .heartRate, .restingHeartRate: .count().unitDivided(by: .minute())
        case .vo2Max: .literUnit(with: .milli).unitDivided(by: .gramUnit(with: .kilo).unitMultiplied(by: .minute()))
        case .steps, .sleep: .count()
        }
    }

    /// HealthKit's locked-phone error as ours. A refused read is not an error: iOS answers
    /// it with no data, so a refused metric and an empty one look the same (AC4).
    private static func locking<T>(_ read: () async throws -> T) async throws -> T {
        do {
            return try await read()
        } catch let error as HKError where error.code == .errorDatabaseInaccessible {
            throw LiveHealthError.locked
        }
    }
}
