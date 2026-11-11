import Foundation
import HealthKit

/// What US-56 needs from HealthKit, behind a protocol so the tests run on a fake. Reads
/// only: the app writes none of these types (AC2), and asks for them only in its one
/// request (`HealthKitClient.requested`, AC4). Every call runs off the main thread.
protocol LiveHealthStore: Sendable {
    /// False where the device has no Health database (an iPad without Health, AC13).
    var isAvailable: Bool { get }
    /// Whether Apple's sheet would still show for the four types (AC4). Throws when iOS
    /// cannot say (a locked phone, an error): the caller keeps what it knew (adversary R4).
    func needsRequest() async throws -> Bool
    /// One point per `component` (an hour or a day) from `start` to `end`, HealthKit's own
    /// statistics: steps summed; resting heart rate and VO2 max averaged. Not sleep.
    func points(_ metric: LiveMetric, from start: Date, to end: Date, every component: Calendar.Component) async throws -> [LivePoint]
    /// The metric's newest sample, however old: its value and when it ended. Each card
    /// starts from it, so a reading older than a card's trend still shows (Codex R2).
    /// Sleep has no value, only a date.
    func latest(_ metric: LiveMetric) async throws -> (value: Double?, date: Date)?
    /// Sleep samples overlapping `start` to `end`.
    func sleep(from start: Date, to end: Date) async throws -> [SleepSegment]
    /// When the metric's oldest sample began, however old: a page reads back to it (AC7a).
    func earliest(_ metric: LiveMetric) async throws -> Date?
    /// What changed in the metric since `anchor`, HealthKit's anchored query (AC7a): when each
    /// added sample began, sleep's added samples, the ids of deleted ones, and the new anchor.
    /// With no anchor, the samples starting at `start` or later, and the anchor they leave.
    func changes(_ metric: LiveMetric, after anchor: Data?, from start: Date?) async throws -> LiveChanges
}

/// One anchored read (AC7a). `more` says HealthKit had more than `limit` changes to give, so
/// the caller reads everything again instead of applying a part.
struct LiveChanges: Sendable {
    static let limit = 5000
    var added: [Date] = []
    var segments: [SleepSegment] = []
    var deleted: [String] = []
    var anchor: Data?
    var more = false
}

/// One read's view of Health (`LiveHealth.reader`, US-72 AC10): each call runs only while the
/// read's ticket holds, checked before it starts and after it returns, else it throws
/// `CancellationError`, which every reader takes as a cancelled read: nothing kept or drawn.
struct GatedLiveStore: LiveHealthStore {
    let base: any LiveHealthStore
    let holds: @Sendable () async -> Bool

    var isAvailable: Bool { base.isAvailable }

    private func gated<T: Sendable>(_ read: @Sendable () async throws -> T) async throws -> T {
        guard await holds() else { throw CancellationError() }
        let value = try await read()
        guard await holds() else { throw CancellationError() }
        return value
    }

    func needsRequest() async throws -> Bool { try await gated { try await base.needsRequest() } }

    func points(_ metric: LiveMetric, from start: Date, to end: Date, every component: Calendar.Component) async throws -> [LivePoint] {
        try await gated { try await base.points(metric, from: start, to: end, every: component) }
    }

    func latest(_ metric: LiveMetric) async throws -> (value: Double?, date: Date)? {
        try await gated { try await base.latest(metric) }
    }

    func sleep(from start: Date, to end: Date) async throws -> [SleepSegment] {
        try await gated { try await base.sleep(from: start, to: end) }
    }

    func earliest(_ metric: LiveMetric) async throws -> Date? { try await gated { try await base.earliest(metric) } }

    func changes(_ metric: LiveMetric, after anchor: Data?, from start: Date?) async throws -> LiveChanges {
        try await gated { try await base.changes(metric, after: anchor, from: start) }
    }
}

/// The real `LiveHealthStore`, on the app's one `HKHealthStore.app`, read off the main thread. Its calendar
/// anchors the statistics' days and hours: the same one `LiveHealth` buckets and labels
/// with, following the phone's zone as it travels (adversary R2).
final class LiveHealthKitStore: LiveHealthStore {
    private let store = HKHealthStore.app
    let calendar: Calendar

    init(calendar: Calendar = .autoupdatingCurrent) {
        self.calendar = calendar
    }

    /// The four types, and nothing else (AC10). `HealthKitClient.requested` asks for them.
    static let readTypes: Set<HKObjectType> = Set(LiveMetric.allCases.map(type(of:)))

    static func type(of metric: LiveMetric) -> HKObjectType {
        switch metric {
        case .restingHeartRate: HKQuantityType(.restingHeartRate)
        case .sleep: HKCategoryType(.sleepAnalysis)
        case .vo2Max: HKQuantityType(.vo2Max)
        case .steps: HKQuantityType(.stepCount)
        }
    }

    var isAvailable: Bool { HKHealthStore.isHealthDataAvailable() }

    @concurrent
    func needsRequest() async throws -> Bool {
        try await Self.locking { try await store.statusForAuthorizationRequest(toShare: [], read: Self.readTypes) } != .unnecessary
    }

    @concurrent
    func points(_ metric: LiveMetric, from start: Date, to end: Date, every component: Calendar.Component) async throws -> [LivePoint] {
        guard let type = Self.type(of: metric) as? HKQuantityType else { return [] }
        let options: HKStatisticsOptions = switch metric.aggregation {
        case .sum: .cumulativeSum
        case .mean: .discreteAverage
        }
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
                                  value: (metric.aggregation == .sum ? statistics.sumQuantity() : statistics.averageQuantity())?.doubleValue(for: unit))
            if point.value != nil { points.append(point) }
        }
        return points
    }

    @concurrent
    func latest(_ metric: LiveMetric) async throws -> (value: Double?, date: Date)? {
        if metric == .sleep {
            let descriptor = HKSampleQueryDescriptor(predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis))],
                                                     sortDescriptors: [SortDescriptor(\.endDate, order: .reverse)], limit: 1)
            return try await Self.locking { try await descriptor.result(for: store) }.first.map { (nil, $0.endDate) }
        }
        guard let type = Self.type(of: metric) as? HKQuantityType else { return nil }
        let descriptor = HKSampleQueryDescriptor(predicates: [.quantitySample(type: type)],
                                                 sortDescriptors: [SortDescriptor(\.endDate, order: .reverse)], limit: 1)
        let samples = try await Self.locking { try await descriptor.result(for: store) }
        return samples.first.map { ($0.quantity.doubleValue(for: Self.unit(metric)), $0.endDate) }
    }

    @concurrent
    func earliest(_ metric: LiveMetric) async throws -> Date? {
        guard let type = Self.type(of: metric) as? HKSampleType else { return nil }
        let descriptor = HKSampleQueryDescriptor(predicates: [.sample(type: type)],
                                                 sortDescriptors: [SortDescriptor(\.startDate)], limit: 1)
        return try await Self.locking { try await descriptor.result(for: store) }.first?.startDate
    }

    @concurrent
    func changes(_ metric: LiveMetric, after anchor: Data?, from start: Date?) async throws -> LiveChanges {
        guard let type = Self.type(of: metric) as? HKSampleType else { return LiveChanges() }
        let previous = anchor.flatMap { try? NSKeyedUnarchiver.unarchivedObject(ofClass: HKQueryAnchor.self, from: $0) }
        // Sleep's first read takes every sample; every other read stops at the limit.
        let limit = metric == .sleep && anchor == nil ? nil : LiveChanges.limit
        let descriptor = HKAnchoredObjectQueryDescriptor(predicates: [.sample(type: type, predicate: start.map { HKQuery.predicateForSamples(withStart: $0, end: nil) })],
                                                         anchor: previous, limit: limit)
        let result = try await Self.locking { try await descriptor.result(for: store) }
        var changes = LiveChanges()
        changes.added = result.addedSamples.map(\.startDate)
        if metric == .sleep {
            changes.segments = result.addedSamples.compactMap { sample in
                (sample as? HKCategorySample).flatMap { Self.segment($0) }
            }
        }
        changes.deleted = result.deletedObjects.map(\.uuid.uuidString)
        changes.anchor = try? NSKeyedArchiver.archivedData(withRootObject: result.newAnchor, requiringSecureCoding: true)
        changes.more = limit.map { result.addedSamples.count + result.deletedObjects.count >= $0 } ?? false
        return changes
    }

    @concurrent
    func sleep(from start: Date, to end: Date) async throws -> [SleepSegment] {
        let descriptor = HKSampleQueryDescriptor(
            predicates: [.categorySample(type: HKCategoryType(.sleepAnalysis), predicate: HKQuery.predicateForSamples(withStart: start, end: end))],
            sortDescriptors: [SortDescriptor(\.startDate)])
        let samples = try await Self.locking { try await descriptor.result(for: store) }
        return samples.compactMap(Self.segment)
    }

    /// A sleep sample as a segment, with its id so a deletion in Health removes it (AC7a).
    private static func segment(_ sample: HKCategorySample) -> SleepSegment? {
        stage(sample.value).map { SleepSegment(stage: $0, start: sample.startDate, end: sample.endDate, source: sample.sourceRevision.source.bundleIdentifier, uuid: sample.uuid.uuidString) }
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

    static func unit(_ metric: LiveMetric) -> HKUnit {
        switch metric {
        case .restingHeartRate: .count().unitDivided(by: .minute())
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
            throw HealthStoreError.locked
        }
    }
}
