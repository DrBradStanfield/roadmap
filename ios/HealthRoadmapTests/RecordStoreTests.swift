import XCTest
@testable import HealthRoadmap

/// US-25 AC4: the record lives in one file on the phone. A write reaches the
/// disk before the screen shows it, a refused write changes nothing, and a
/// record the app cannot read is never overwritten.
@MainActor
final class RecordStoreTests: XCTestCase {
    private var folder: URL!

    override func setUp() async throws {
        // A space in the name, as in "Application Support", where the app keeps the record:
        // a percent-encoded path once made the app miss its own file and start a new one.
        folder = FileManager.default.temporaryDirectory.appending(path: "Record Store \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private var file: URL { folder.appending(path: "health-roadmap.json") }

    private func store() throws -> RecordStore {
        try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "test")
    }

    func testFirstLaunchWritesAnEmptyRecord() throws {
        let store = try store()
        let onDisk = try String(contentsOf: file, encoding: .utf8)
        XCTAssertEqual(onDisk, store.recordJSON)
        XCTAssertTrue(onDisk.contains("\"measurements\":[]"))
        XCTAssertNotNil(store.myData)
        // Staged beside the record, then moved: nothing else is left behind.
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: folder.path(percentEncoded: false)), ["health-roadmap.json"])
    }

    func testAnAddedValueIsOnDiskAndSurvivesARelaunch() throws {
        let first = try store()
        XCTAssertEqual(first.apply(.add(metric: "weight", value: 80, day: "2026-10-20")), .saved)
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), first.recordJSON)

        let relaunched = try store()
        XCTAssertEqual(relaunched.myData?.vitals.first?.latest?.day, "2026-10-20")
    }

    func testARefusedEditLeavesTheFileUntouched() throws {
        let store = try store()
        let before = try Data(contentsOf: file)
        guard case .refused(let message, _) = store.apply(.add(metric: "systolic_bp", value: 400, day: "2026-10-20")) else {
            return XCTFail("a systolic of 400 must be refused")
        }
        XCTAssertFalse(message.isEmpty)
        XCTAssertEqual(try Data(contentsOf: file), before)
    }

    func testAHeldDayNamesItsRowSoTheAppCanAskBeforeCorrecting() throws {
        let store = try store()
        XCTAssertEqual(store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")), .saved)
        guard case .refused(_, let existingId?) = store.apply(.add(metric: "weight", value: 82, day: "2026-10-20")) else {
            return XCTFail("a second weight for the day must name the row that holds it")
        }
        XCTAssertEqual(store.apply(.correct(id: existingId, value: 82)), .saved)
        XCTAssertEqual(store.myData?.vitals.first?.latest?.value, "82.0")
    }

    func testThePlanFollowsTheStoredRecord() throws {
        let store = try store()
        let engine = try HealthEngine()
        XCTAssertThrowsError(try engine.plan(recordJSON: store.recordJSON, now: .now, deviceId: "test"), "an empty record has no height or sex")

        XCTAssertEqual(store.apply(.profile(sex: "male", birthYear: 1975, birthMonth: 6, height: 178)), .saved)
        XCTAssertEqual(store.apply(.add(metric: "systolic_bp", value: 150, day: "2026-10-20")), .saved)
        XCTAssertEqual(store.apply(.add(metric: "diastolic_bp", value: 95, day: "2026-10-20")), .saved)
        let sections = try engine.sections(planJSON: engine.plan(recordJSON: store.recordJSON, now: .now, deviceId: "test"))
        let ids = sections.flatMap(\.cards).flatMap(\.suggestions).map(\.id)
        XCTAssertTrue(ids.contains { $0.hasPrefix("bp-") }, "a 150/95 reading must reach the plan: \(ids)")
    }

    func testTheRecordIsKeptOutOfBackups() throws {
        // Brad 2026-10-21: the record is left out of backups. The mark is on the folder,
        // because every save replaces the file; so the file must sit in that folder.
        let store = try RecordStore(folder: RecordStore.appFolder(in: folder), engine: HealthEngine(), deviceId: "test")
        var holder = store.file.deletingLastPathComponent()
        holder.removeAllCachedResourceValues()
        XCTAssertEqual(try holder.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)
    }

    func testJSONThatIsNotARecordIsNeverOverwritten() throws {
        // Adversary R4: the engine's migration turned `null` into an empty record.
        try Data("null".utf8).write(to: file)
        let store = try store()
        XCTAssertNotNil(store.problem)
        if case .saved = store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) {
            XCTFail("an edit must not write over a file that is not a record")
        }
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "null")
    }

    func testAnUnreadableRecordIsNeverOverwritten() throws {
        try Data("not a record".utf8).write(to: file)
        let store = try store()
        XCTAssertNil(store.myData)
        XCTAssertNotNil(store.problem)
        if case .saved = store.apply(.add(metric: "weight", value: 80, day: "2026-10-20")) {
            XCTFail("an edit must not write over a record the app cannot read")
        }
        XCTAssertEqual(try String(contentsOf: file, encoding: .utf8), "not a record")
    }
}
