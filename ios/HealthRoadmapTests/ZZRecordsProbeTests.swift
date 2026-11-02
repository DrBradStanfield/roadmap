import XCTest
@testable import HealthRoadmap

/// TEMPORARY simulator probe for US-66 (delete before commit). Prints counts, sources, codes and units only.
@MainActor
final class ZZRecordsProbeTests: XCTestCase {
    func testWhatTheSimulatorHolds() async throws {
        let client = HealthKitClient()
        print("PROBE supports", client.supportsHealthRecords)
        let batch = try await client.labResults(after: nil)
        print("PROBE records", batch.records.count)
        print("PROBE sources", Set(batch.records.map(\.sourceId)))
        print("PROBE types", Set(batch.records.map { "\($0.resourceType) \($0.fhirVersion)" }))
        var codes: [String: Int] = [:]
        for record in batch.records {
            let obj = (try? JSONSerialization.jsonObject(with: Data(record.json.utf8))) as? [String: Any] ?? [:]
            let coding = ((obj["code"] as? [String: Any])?["coding"] as? [[String: Any]])?.map { "\($0["system"] ?? "")#\($0["code"] ?? "")" }.joined(separator: ",") ?? "none"
            let q = obj["valueQuantity"] as? [String: Any]
            let key = "\(coding) unit=\(q?["unit"] ?? "nil") code=\(q?["code"] ?? "nil") status=\(obj["status"] ?? "nil") eff=\(obj["effectiveDateTime"] != nil) cmp=\(q?["comparator"] != nil)"
            codes[key, default: 0] += 1
            print("PROBE keys", obj.keys.sorted(), "effectiveKeys", obj.keys.filter { $0.lowercased().contains("effective") || $0 == "issued" }.map { k in "\(k):\(type(of: obj[k]!))" })
        }
        for (k, v) in codes.sorted(by: { $0.key < $1.key }) { print("PROBE code", v, k) }
        let engine = try HealthEngine()
        let records = batch.records
        let outcome = try engine.blocking { e in
            let record = try e.newRecord(now: .now, deviceId: "probe")
            return try e.apply(.healthRecords(records), to: record, now: .now, deviceId: "probe")
        }
        print("PROBE outcome ok", outcome.ok, outcome.reason ?? "", outcome.healthRecords.map { "\($0)" } ?? "nil")
    }
}
