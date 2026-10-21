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
    /// The instant in the zone it was taken in, with that zone's offset, Gregorian:
    /// `2026-10-21T08:30:00+13:00`. Its date is the record's slot (the day the person lived).
    let measuredAt: String
    /// The two halves of one blood pressure share it (the correlation's UUID): they land together.
    let pairId: String?

    init(id: UUID, metric: String, value: Double, at date: Date, timeZone: TimeZone = .current, pairId: UUID? = nil) {
        externalId = id.uuidString
        metricType = metric
        self.value = value
        self.pairId = pairId?.uuidString
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let p = calendar.dateComponents([.year, .month, .day, .hour, .minute, .second], from: date)
        let offset = timeZone.secondsFromGMT(for: date) / 60
        measuredAt = String(
            format: "%04d-%02d-%02dT%02d:%02d:%02d%@%02d:%02d",
            p.year ?? 0, p.month ?? 0, p.day ?? 0, p.hour ?? 0, p.minute ?? 0, p.second ?? 0,
            offset < 0 ? "-" : "+", abs(offset) / 60, abs(offset) % 60)
    }
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
    /// zone, the moment least likely to fall on another day in Health's own views, or
    /// now if noon today has not come yet (a sample in the future may be refused).
    func date(timeZone: TimeZone = .current, now: Date = .now) -> Date? {
        let parts = day.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: 12)).map { min($0, now) }
    }
}

/// New readings of one kind since an anchor, and the anchor to keep once they are saved.
struct HealthBatch: Sendable {
    let samples: [HealthSample]
    let anchor: Data?
}
