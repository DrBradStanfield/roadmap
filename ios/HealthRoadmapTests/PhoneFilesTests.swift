import XCTest
@testable import HealthRoadmap

/// US-25 AC21, US-09 AC4: the phone's pending marker as a generation (PhoneFiles,
/// ios/engine/cloud.ts `pending`). A session clears only the generation it holds.
final class PhoneFilesTests: XCTestCase {
    private var folder: URL!

    override func setUpWithError() throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Phone Files \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try? FileManager.default.removeItem(at: folder)
    }

    private var marker: URL { folder.appending(path: "sync-pending") }
    private func files() -> PhoneFiles { PhoneFiles(record: folder.appending(path: "health-roadmap.json"), pending: marker) }

    func testAGenerationOnDiskIsRaisedAfterARelaunch() throws {
        try Data("7".utf8).write(to: marker)
        let relaunched = files()
        XCTAssertEqual(relaunched.pending("get"), 7)
        XCTAssertEqual(relaunched.pending("set"), 8)
        XCTAssertEqual(try String(contentsOf: marker, encoding: .utf8), "8")
    }

    func testAnOlderAppsEmptyMarkerReadsAsGenerationOne() throws {
        try Data().write(to: marker)
        let phone = files()
        XCTAssertEqual(phone.pending("get"), 1)
        XCTAssertEqual(phone.pending("clear-if:1"), 0)
        XCTAssertFalse(FileManager.default.fileExists(atPath: marker.path(percentEncoded: false)))
    }

    func testClearIfClearsOnlyTheGenerationItNames() {
        let phone = files()
        XCTAssertEqual(phone.pending("get"), 0)
        let held = phone.pending("set")
        let later = phone.pending("set")
        XCTAssertGreaterThan(later, held)
        XCTAssertEqual(phone.pending("clear-if:\(held)"), later, "a set made after the session's stays")
        XCTAssertEqual(phone.pending("clear-if:\(later)"), 0)
        XCTAssertGreaterThan(phone.pending("set"), later, "a set after a clear is still higher than any before")
    }

    func testTheOldPlainClearIsGone() {
        let phone = files()
        let set = phone.pending("set")
        XCTAssertEqual(phone.pending("clear"), set, "only clear-if clears")
    }

    /// A phone write that fails leaves no marker: none no session could ever hold (adversary R3).
    func testAFailedPhoneWriteSetsNoMarker() throws {
        let engine = try HealthEngine()
        let phone = files()
        let record = try engine.blocking { try $0.newRecord(now: .now, deviceId: "test") }
        let nowhere = folder.appending(path: "missing folder/health-roadmap.json")
        XCTAssertThrowsError(try engine.blocking { try $0.myDataAndWrite(record, units: "{}", to: nowhere, marking: phone, deviceId: "test") })
        XCTAssertEqual(phone.pending("get"), 0)
        // The marker was set before the write was tried (generation 1), then taken back:
        // an app killed after a write that lands is never left with an unmarked edit.
        XCTAssertEqual(phone.pending("set"), 2)
    }

    /// A refused write never takes away a marker that was already there: the edit it
    /// marks still waits for the cloud.
    func testAFailedPhoneWriteKeepsAMarkerAlreadySet() throws {
        let engine = try HealthEngine()
        let phone = files()
        let earlier = phone.pending("set")
        let record = try engine.blocking { try $0.newRecord(now: .now, deviceId: "test") }
        let nowhere = folder.appending(path: "missing folder/health-roadmap.json")
        XCTAssertThrowsError(try engine.blocking { try $0.myDataAndWrite(record, units: "{}", to: nowhere, marking: phone, deviceId: "test") })
        XCTAssertEqual(phone.pending("get"), earlier, "the generation it found is put back")
        XCTAssertEqual(phone.pending("clear-if:\(earlier)"), 0, "so the session holding it can still clear it")
    }

    /// A restore puts back only the generation its own set made: a set that came after it
    /// (another edit's) stays, so that edit still waits for the cloud.
    func testARestoreLeavesALaterSetAlone() {
        let phone = files()
        let mine = phone.pending("set")
        let later = phone.pending("set")
        XCTAssertEqual(later, mine + 1)
        phone.restore(0, ifStill: mine)
        XCTAssertEqual(phone.pending("get"), later, "the later set is not taken back")
    }
}
