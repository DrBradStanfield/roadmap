// Generated from ios/engine/contract.ts by `npx tsx ios/scripts/gen-contract.ts`. Never edit it:
// ios/engine/contract-drift.test.ts fails when it differs from what the contract generates.
// contractHash: feb576c1d7928941

import Foundation

extension EngineRelease {
    /// The native bridge this binary serves: the first 16 hex digits of the SHA-256 of
    /// ios/engine/bridge-contract.json (generated from contract.ts).
    static let bridge = "40fc97db4ca12547"
    /// The first 16 hex digits of the SHA-256 of ios/engine/contract.schema.json.
    static let contractHash = "feb576c1d7928941"
    /// Every door the engine must have (the contract's doors), checked by the self-test.
    static let doors = [
        "applyEditJson", "chatContextJson", "chatDeleteJson", "chatEditsJson", "chatListJson", "chatMessagesJson",
        "chatRecordExchangeJson", "cloudClose", "cloudEdit", "cloudErase", "cloudFlush", "cloudHidden",
        "cloudLabImport", "cloudOpen", "cloudRefresh", "cloudVisible", "convertJson", "documentSave",
        "erasePhoneJson", "fileNamesJson", "healthWritesJson", "historyJson", "labReviewJson", "labSaveSummaryJson",
        "mergeJson", "newRecordJson", "numberJson", "planJson", "remindersJson", "screenJson",
        "sectionsJson", "settledJson",
    ]
}

struct ChatMedicationRow: Codable, Equatable, Hashable, Sendable {
    let medicationKey: String
    let drugName: String
    let doseValue: Double?
    let doseUnit: String?
}

struct EditOutcome: Codable, Equatable, Hashable, Sendable {
    let ok: Bool
    let record: String?
    let reason: String?
    let message: String?
    let existingId: String?
    let erase: String?
    let healthRecords: HealthRecordCounts?
}

enum EngineEdit: Encodable, Equatable, Sendable {
    case profile(sex: String? = nil, birthYear: Double? = nil, birthMonth: Double? = nil, height: Double? = nil, heightFeet: Double? = nil, heightInches: Double? = nil)
    case bloodPressure(systolic: Double, diastolic: Double, day: String, replace: Bool? = nil, seenIds: [String]? = nil)
    case units(unitSystem: String)
    case alcohol(alcohol: String?)
    case lpaUnit(unit: String)
    case add(metric: String, value: Double, day: String? = nil)
    case correct(id: String, value: Double)
    case medication(medicationKey: String, drugName: String, doseValue: Double? = nil, doseUnit: String? = nil)
    case supplement(supplementKey: String, supplementName: String, doseValue: Double? = nil, doseUnit: String? = nil, status: String, startedAt: String? = nil)
    case appleHealth(samples: [HealthSample])
    case healthRecords(records: [HealthRecord])
    case medicationField(field: String, value: String)
    case screening(key: String, value: String)
    case customSupplement(name: String)
    case labImport(extractionJson: String, refs: [String], reportDay: String)
    case labAdd(series: String, value: Double, day: String? = nil, unit: String? = nil)
    case labAddName(name: String, value: Double, unit: String, day: String? = nil)
    case chatEdits(part: String, edits: OpaqueJSON, today: String, seen: OpaqueJSON? = nil)
    case chatUndo(medications: [ChatMedicationRow])

    private enum Key: String, CodingKey {
        case kind, sex, birthYear, birthMonth, height, heightFeet, heightInches, systolic, diastolic, day, replace, seenIds, unitSystem, alcohol, unit, metric, value, id, medicationKey, drugName, doseValue, doseUnit, supplementKey, supplementName, status, startedAt, samples, records, field, key, name, extractionJson, refs, reportDay, series, part, edits, today, seen, medications
    }

    func encode(to encoder: Encoder) throws {
        var json = encoder.container(keyedBy: Key.self)
        switch self {
        case .profile(let sex, let birthYear, let birthMonth, let height, let heightFeet, let heightInches):
            try json.encode("profile", forKey: .kind)
            try json.encodeIfPresent(sex, forKey: .sex)
            try json.encodeIfPresent(birthYear, forKey: .birthYear)
            try json.encodeIfPresent(birthMonth, forKey: .birthMonth)
            try json.encodeIfPresent(height, forKey: .height)
            try json.encodeIfPresent(heightFeet, forKey: .heightFeet)
            try json.encodeIfPresent(heightInches, forKey: .heightInches)
        case .bloodPressure(let systolic, let diastolic, let day, let replace, let seenIds):
            try json.encode("bloodPressure", forKey: .kind)
            try json.encode(systolic, forKey: .systolic)
            try json.encode(diastolic, forKey: .diastolic)
            try json.encode(day, forKey: .day)
            try json.encodeIfPresent(replace, forKey: .replace)
            try json.encodeIfPresent(seenIds, forKey: .seenIds)
        case .units(let unitSystem):
            try json.encode("units", forKey: .kind)
            try json.encode(unitSystem, forKey: .unitSystem)
        case .alcohol(let alcohol):
            try json.encode("alcohol", forKey: .kind)
            try json.encode(alcohol, forKey: .alcohol)
        case .lpaUnit(let unit):
            try json.encode("lpaUnit", forKey: .kind)
            try json.encode(unit, forKey: .unit)
        case .add(let metric, let value, let day):
            try json.encode("add", forKey: .kind)
            try json.encode(metric, forKey: .metric)
            try json.encode(value, forKey: .value)
            try json.encodeIfPresent(day, forKey: .day)
        case .correct(let id, let value):
            try json.encode("correct", forKey: .kind)
            try json.encode(id, forKey: .id)
            try json.encode(value, forKey: .value)
        case .medication(let medicationKey, let drugName, let doseValue, let doseUnit):
            try json.encode("medication", forKey: .kind)
            try json.encode(medicationKey, forKey: .medicationKey)
            try json.encode(drugName, forKey: .drugName)
            try json.encode(doseValue, forKey: .doseValue)
            try json.encode(doseUnit, forKey: .doseUnit)
        case .supplement(let supplementKey, let supplementName, let doseValue, let doseUnit, let status, let startedAt):
            try json.encode("supplement", forKey: .kind)
            try json.encode(supplementKey, forKey: .supplementKey)
            try json.encode(supplementName, forKey: .supplementName)
            try json.encode(doseValue, forKey: .doseValue)
            try json.encode(doseUnit, forKey: .doseUnit)
            try json.encode(status, forKey: .status)
            try json.encodeIfPresent(startedAt, forKey: .startedAt)
        case .appleHealth(let samples):
            try json.encode("appleHealth", forKey: .kind)
            try json.encode(samples, forKey: .samples)
        case .healthRecords(let records):
            try json.encode("healthRecords", forKey: .kind)
            try json.encode(records, forKey: .records)
        case .medicationField(let field, let value):
            try json.encode("medicationField", forKey: .kind)
            try json.encode(field, forKey: .field)
            try json.encode(value, forKey: .value)
        case .screening(let key, let value):
            try json.encode("screening", forKey: .kind)
            try json.encode(key, forKey: .key)
            try json.encode(value, forKey: .value)
        case .customSupplement(let name):
            try json.encode("customSupplement", forKey: .kind)
            try json.encode(name, forKey: .name)
        case .labImport(let extractionJson, let refs, let reportDay):
            try json.encode("labImport", forKey: .kind)
            try json.encode(extractionJson, forKey: .extractionJson)
            try json.encode(refs, forKey: .refs)
            try json.encode(reportDay, forKey: .reportDay)
        case .labAdd(let series, let value, let day, let unit):
            try json.encode("labAdd", forKey: .kind)
            try json.encode(series, forKey: .series)
            try json.encode(value, forKey: .value)
            try json.encodeIfPresent(day, forKey: .day)
            try json.encodeIfPresent(unit, forKey: .unit)
        case .labAddName(let name, let value, let unit, let day):
            try json.encode("labAddName", forKey: .kind)
            try json.encode(name, forKey: .name)
            try json.encode(value, forKey: .value)
            try json.encode(unit, forKey: .unit)
            try json.encodeIfPresent(day, forKey: .day)
        case .chatEdits(let part, let edits, let today, let seen):
            try json.encode("chatEdits", forKey: .kind)
            try json.encode(part, forKey: .part)
            try json.encode(edits, forKey: .edits)
            try json.encode(today, forKey: .today)
            try json.encodeIfPresent(seen, forKey: .seen)
        case .chatUndo(let medications):
            try json.encode("chatUndo", forKey: .kind)
            try json.encode(medications, forKey: .medications)
        }
    }
}

struct HealthRecord: Codable, Equatable, Hashable, Sendable {
    let sourceId: String
    let resourceType: String
    let fhirVersion: String
    let json: String
}

struct HealthRecordCounts: Codable, Equatable, Hashable, Sendable {
    let added: Int
    let corrected: Int
    let withdrawn: Int
    let alreadyInRecord: Int
    let notRead: Int
}

struct HealthSample: Codable, Equatable, Hashable, Sendable {
    let externalId: String
    let metricType: String
    let value: Double
    let measuredAt: String
    let pairId: String?
}

struct HeightFeetInches: Codable, Equatable, Hashable, Sendable {
    let feet: Int
    let inches: Int
}

struct UnitConversion: Codable, Equatable, Hashable, Sendable {
    let value: Double
    let text: String
    let feetInches: HeightFeetInches?
}
