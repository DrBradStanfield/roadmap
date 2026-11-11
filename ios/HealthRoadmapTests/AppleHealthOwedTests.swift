import XCTest
@testable import HealthRoadmap

/// US-72 AC16: the delete an erase owes Apple Health counts the pays in a row that deleted none of
/// it, and Settings' Apple Health footer says so from the second. `Owed` is one stored value whose
/// one rule (nothing owed, no failed pays) lives in its init. HealthKit is faked (FakeHealthStore).
@MainActor
final class AppleHealthOwedTests: XCTestCase {
    private var folder: URL!
    private var suite: String!
    private var defaults: UserDefaults!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Apple Health Owed \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        suite = "AppleHealthOwedTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        defaults.removePersistentDomain(forName: suite)
    }

    private var memory: HealthSyncMemory { HealthSyncMemory(defaults: defaults) }

    // MARK: The count

    /// Every pay outcome from every starting count: a pay that takes any id off the list starts
    /// the count again; one that leaves every id owed adds one; nothing owed is always 0.
    func testEachPayOutcomeByStartingCount_US72_AC16() {
        let two: [String: Int64] = ["a": 1, "b": 1]
        for start in 0...2 {
            let owed = Owed(ids: two, failedPays: start)
            XCTAssertEqual(owed.failedPays, start)
            XCTAssertEqual(owed.paying(two), Owed(), "all leave, from \(start)")
            XCTAssertEqual(owed.paying(["a": 1]), Owed(ids: ["b": 1], failedPays: 0), "some leave, from \(start)")
            XCTAssertEqual(owed.paying([:]), Owed(ids: two, failedPays: start + 1), "none leave, from \(start)")
            XCTAssertEqual(owed.paying(["a": 0]), Owed(ids: two, failedPays: start + 1), "a newer version saved meanwhile stays: none leave, from \(start)")
            let nothing = Owed(ids: [:], failedPays: start)
            XCTAssertEqual(nothing.failedPays, 0, "nothing owed is 0, from \(start)")
            XCTAssertEqual(nothing.paying([:]), Owed(), "nothing owed stays 0, from \(start)")
        }
    }

    /// An id Health deleted while a newer version of it was saved (a late save landing during the
    /// pay) stays owed at that version, so the pay counts as failed: after one refused pay the
    /// footer shows. The next pay deletes that version and clears it, as a pass never writes an
    /// owed id again (only a save already in flight can land late).
    func testAReVersionedPayCountsAsFailedAndTheNextPayClearsIt_US72_AC16() {
        let refusedOnce = Owed(ids: ["a": 1], failedPays: 1)
        let reVersioned = refusedOnce.owing(2, for: "a").paying(["a": 1])
        XCTAssertEqual(reVersioned, Owed(ids: ["a": 2], failedPays: 2))
        XCTAssertTrue(reVersioned.showsFooter, "shown until the next pay")
        XCTAssertEqual(reVersioned.paying(["a": 2]), Owed(), "the next pay clears it")
    }

    /// A new erase starts the count again; a save owed after it keeps it.
    func testANewEraseResetsTheCountAndASaveKeepsIt_US72_AC16() {
        let stuck = Owed(ids: ["a": 1], failedPays: 2)
        XCTAssertEqual(stuck.owingWritten(["a": 3, "b": 1]), Owed(ids: ["a": 3, "b": 1], failedPays: 0))
        XCTAssertEqual(stuck.owingWritten([:]), Owed(ids: ["a": 1], failedPays: 0), "an erase with nothing new written resets too")
        XCTAssertEqual(stuck.owing(3, for: "c"), Owed(ids: ["a": 1, "c": 3], failedPays: 2))
        XCTAssertEqual(stuck.owing(0, for: "a"), stuck, "the newer version is kept")

        // The same through the phone's memory, stored as one value.
        let memory = memory
        memory.owe(1, for: "a")
        memory.paid([:])
        memory.paid([:])
        XCTAssertEqual(memory.owed, Owed(ids: ["a": 1], failedPays: 2))
        memory.owe(2, for: "b")
        XCTAssertEqual(memory.owed.failedPays, 2, "owe keeps the count")
        memory.setWritten(4, for: "c")
        memory.oweWritten()
        XCTAssertEqual(memory.owed, Owed(ids: ["a": 1, "b": 2, "c": 4], failedPays: 0))
        memory.paid(["a": 1, "b": 2, "c": 4])
        XCTAssertNil(defaults.object(forKey: "appleHealth.owed"), "the last id gone removes the key")
    }

    // MARK: The footer

    func testTheFooterShowsFromTheSecondFailedPayWhileAnythingIsOwed_US72_AC16() {
        let table: [(Owed, Bool)] = [
            (Owed(), false),
            (Owed(ids: [:], failedPays: 5), false),
            (Owed(ids: ["a": 1], failedPays: 0), false),
            (Owed(ids: ["a": 1], failedPays: 1), false),
            (Owed(ids: ["a": 1], failedPays: 2), true),
            (Owed(ids: ["a": 1, "b": 2], failedPays: 7), true),
        ]
        for (owed, shows) in table { XCTAssertEqual(owed.showsFooter, shows, "\(owed)") }
    }

    /// The line in Settings: it appears at the second pay in a row Health refuses and goes
    /// once nothing is owed. One fixed sentence, with no count and no reading.
    func testTheFooterLineAppearsAtTheSecondFailureAndGoesWhenPaid_US72_AC16() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let health = FakeHealthStore()
        memory.owe(1, for: "a")
        let sync = AppleHealthSync(store: store, engine: engine, client: health, memory: memory)
        XCTAssertFalse(sync.owedFooter)

        health.deleteRefusal = CocoaError(.fileWriteNoPermission)
        await sync.foreground()
        XCTAssertEqual(health.deleteAttempts, 1)
        XCTAssertFalse(sync.owedFooter, "one failed pay says nothing")
        await sync.foreground()
        XCTAssertEqual(health.deleteAttempts, 2)
        XCTAssertTrue(sync.owedFooter, "the second in a row shows the line")
        XCTAssertTrue(AppleHealthSync(store: store, engine: engine, client: health, memory: memory).owedFooter, "a relaunch still shows it")

        health.deleteRefusal = nil
        await sync.foreground()
        XCTAssertTrue(memory.owed.ids.isEmpty)
        XCTAssertFalse(sync.owedFooter, "nothing owed: the line goes")

        XCTAssertFalse(EraseText.healthOwed.contains(where: \.isNumber), "no count, no reading")
    }

    /// Brad's text (2026-11-12): the footer and the erase's words name the same Settings path,
    /// built in one place (`LiveFooter.healthPath`), and the system's button label, curly quotes and all.
    func testTheFooterAndTheEraseWordsNameOneSettingsPathAndTheButton_US72_AC16() {
        let steps = "open \(LiveFooter.healthPath), tap Data from “Health Roadmap”, then Delete All Data from “Health Roadmap”"
        XCTAssertEqual(EraseText.healthOwed, "Some readings this app wrote to Apple Health could not be deleted. The app tries again each time you open it. To delete them yourself, \(steps). This removes everything this app wrote to Apple Health.")
        XCTAssertEqual(EraseText.healthNotErased, " The readings this app wrote to Apple Health could not be deleted. To delete them yourself, \(steps).")
        if #available(iOS 18, *) {
            XCTAssertTrue(EraseText.healthOwed.contains("open Settings › Apps › Health › Data Access & Devices › Health Roadmap, tap"))
        }
        // LiveCards' own words are unchanged.
        XCTAssertEqual(LiveFooter.access, "To change what Health Roadmap can read: \(LiveFooter.healthPath).")
        XCTAssertEqual(LiveFooter.healthSettings, "The Apple Health settings for this app are in \(LiveFooter.healthPath).")
    }

    // MARK: What a build before AC16 stored

    /// The old value, the ids alone as a dictionary, reads as those ids with no failed pays.
    func testTheOldStoredIdsAreReadWithACountOfZero_US72_AC16() {
        defaults.set(["a": NSNumber(value: 1), "b": NSNumber(value: 2)], forKey: "appleHealth.owed")
        XCTAssertEqual(memory.owed, Owed(ids: ["a": 1, "b": 2], failedPays: 0))
        XCTAssertFalse(memory.owedUnreadable)

        // An entry whose version is not a number keeps its id, at version 0.
        defaults.set(["a": NSNumber(value: 1), "b": "two"], forKey: "appleHealth.owed")
        XCTAssertEqual(memory.owed, Owed(ids: ["a": 1, "b": 0], failedPays: 0))
        memory.paid([:])
        XCTAssertEqual(memory.owed, Owed(ids: ["a": 1, "b": 0], failedPays: 1), "written back in the new form")
        memory.paid(["a": 1, "b": 0])
        XCTAssertTrue(memory.owed.ids.isEmpty)

        // A value whose ids can be read keeps them, a missing count read as 0.
        defaults.set(Data(#"{"ids":{"c":5}}"#.utf8), forKey: "appleHealth.owed")
        XCTAssertEqual(memory.owed, Owed(ids: ["c": 5], failedPays: 0))
        XCTAssertFalse(memory.owedUnreadable)
    }

    /// A value no build wrote is never taken as nothing owed: the first write moves it aside,
    /// and the next erase deletes this app's samples by source, connected or not.
    func testAnUnreadableValueIsKeptUntilAnEraseDeletesBySource_US72_AC16() async throws {
        defaults.set(Data("not json".utf8), forKey: "appleHealth.owed")
        XCTAssertTrue(memory.owed.ids.isEmpty, "no id can be read")
        XCTAssertTrue(memory.owedUnreadable)

        memory.owe(3, for: "c")
        XCTAssertEqual(memory.owed, Owed(ids: ["c": 3], failedPays: 0))
        XCTAssertTrue(memory.owedUnreadable, "the unreadable value is kept aside, not overwritten")
        memory.paid(["c": 3])
        XCTAssertTrue(memory.owed.ids.isEmpty)
        XCTAssertTrue(memory.owedUnreadable, "paying what could be read does not drop it")

        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let health = FakeHealthStore()
        let sync = AppleHealthSync(store: store, engine: engine, client: health, memory: memory)
        health.deleteFails = true
        _ = await sync.erased(wasConnected: false)
        XCTAssertTrue(memory.owedUnreadable, "a failed delete by source keeps it")
        health.deleteFails = false
        _ = await sync.erased(wasConnected: false)
        XCTAssertEqual(health.ownDeletes, 1, "deleted by source though Health was not connected")
        XCTAssertFalse(memory.owedUnreadable)

        defaults.set("a string", forKey: "appleHealth.owed")
        XCTAssertTrue(memory.owedUnreadable, "any other type is unreadable too")
    }

    /// Review F3: a second unreadable value never overwrites one already kept aside.
    func testAnOlderUnreadableValueKeptAsideIsNeverOverwritten_US72_AC16() {
        let first = Data("first".utf8)
        defaults.set(first, forKey: "appleHealth.owed")
        memory.owe(1, for: "a")
        defaults.set("second", forKey: "appleHealth.owed")
        memory.owe(2, for: "b")
        XCTAssertEqual(defaults.data(forKey: "appleHealth.owedUnreadable"), first)
        XCTAssertEqual(memory.owed, Owed(ids: ["b": 2], failedPays: 0))
    }

    /// Review F2, accepted: a refused delete already running when an erase lands counts toward the
    /// new erase's attempts, so the erase's own refused pay is the second and shows the line.
    func testAPayInFlightAcrossAnEraseCountsTowardItsAttempts_US72_AC16() async throws {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let health = FakeHealthStore()
        let memory = memory
        memory.owe(1, for: "a")
        // The kind of "a" is not known and waist cannot be written: Health leaves it, a failed pay.
        health.writable = [.weight, .bloodPressure]
        health.deleteBegin = { try? await Task.sleep(for: .milliseconds(400)) }
        let sync = AppleHealthSync(store: store, engine: engine, client: health, memory: memory)

        let running = Task { await sync.foreground() }
        for _ in 0..<300 where health.deleteAttempts == 0 { try? await Task.sleep(for: .milliseconds(10)) }
        XCTAssertEqual(health.deleteAttempts, 1, "a pay is in flight")
        let erased = await sync.erased(wasConnected: false)
        XCTAssertFalse(erased)
        await running.value

        XCTAssertEqual(health.deleteAttempts, 2, "the erase paid its own after the one in flight")
        XCTAssertEqual(memory.owed.failedPays, 2, "the pay in flight counts after the erase's reset")
        XCTAssertTrue(sync.owedFooter)
    }
}
