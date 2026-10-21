import Foundation

/// The kinds of Apple Health data the app reads and writes (ios/architecture.md D6).
/// Blood pressure is one reading in Health (a correlation) and two rows in the record.
enum HealthKind: String, CaseIterable, Sendable {
    case weight, height, waist, bloodPressure
}

/// One reading handed to the engine (`DeviceSample` in packages/health-core/src/device-import.ts).
/// Swift does no clinical work on it: the engine decides whether it lands.
struct HealthSample: Encodable, Equatable, Sendable {
    /// The HealthKit sample UUID: the row's `externalId`, so a reading is taken once.
    let externalId: String
    /// The record's metric: weight, waist, systolic_bp, diastolic_bp, or height.
    let metricType: String
    /// SI: kg, cm, mmHg.
    let value: Double
    /// The instant, as JavaScript's `toISOString` writes it: compared with the record's erase.
    let measuredAt: String
    /// The phone's wall clock, `YYYY-MM-DDTHH:mm:ss`, Gregorian: its day is the record's slot.
    let localTime: String

    init(id: UUID, metric: String, value: Double, at date: Date, timeZone: TimeZone = .current) {
        externalId = id.uuidString
        metricType = metric
        self.value = value
        measuredAt = date.formatted(Self.iso)
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let p = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        localTime = String(format: "%04d-%02d-%02dT%02d:%02d:%02d", p.year ?? 0, p.month ?? 0, p.day ?? 0, p.hour ?? 0, p.minute ?? 0, p.second ?? 0)
    }

    /// The instant again.
    var date: Date { (try? Date(measuredAt, strategy: Self.iso)) ?? .distantPast }

    private static let iso = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
}

/// One value the engine says to write to Apple Health (`DeviceWrite` in device-export.ts).
struct HealthWrite: Codable, Equatable, Sendable {
    /// The root id of the row's correction chain: the same for every correction of one value.
    let syncId: String
    /// Rises with each correction (the active row's write time, in ms), so Health replaces our sample.
    let version: Int64
    /// YYYY-MM-DD
    let day: String
    /// SI values by metric: one metric, or both halves of a blood pressure.
    let values: [String: Double]

    var kind: HealthKind? {
        if values["systolic_bp"] != nil, values["diastolic_bp"] != nil { return .bloodPressure }
        if values["weight"] != nil { return .weight }
        if values["waist"] != nil { return .waist }
        return nil
    }

    /// A typed value has a day, not a time: Health gets noon of that day in the phone's
    /// zone, the moment least likely to fall on another day in Health's own views.
    func date(timeZone: TimeZone = .current) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12))
    }
}

/// New readings of one kind since an anchor, and the anchor to keep once they are saved.
struct HealthBatch: Sendable {
    let samples: [HealthSample]
    let anchor: Data?
}
