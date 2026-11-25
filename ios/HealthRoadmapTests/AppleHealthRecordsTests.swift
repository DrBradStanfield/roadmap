import HealthKit
import UIKit
import XCTest
@testable import HealthRoadmap

/// US-72 (ios/architecture.md D6): lab results from Health Records come in through the
/// vitals' path. Asked only where Apple offers them, sent to the engine as they came in
/// one `healthRecords` edit, the anchor kept until a batch brings results and moved only
/// after the record is saved, and two fixed Clarity words. HealthKit is faked.
@MainActor
final class AppleHealthRecordsTests: XCTestCase {
    private var folder: URL!
    private var defaults: UserDefaults!
    private var suite: String!

    override func setUp() async throws {
        folder = FileManager.default.temporaryDirectory.appending(path: "Health Records \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        suite = "AppleHealthRecordsTests-\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)
    }

    override func tearDown() async throws {
        try? FileManager.default.removeItem(at: folder)
        defaults.removePersistentDomain(forName: suite)
    }

    private final class FakeSDK: AnalyticsSDK {
        var events: [String] = []
        func mask(_ view: UIView) {}
        func start(projectId: String) -> Bool { true }
        func screen(_ name: String) {}
        func event(_ name: String) { events.append(name) }
    }

    private var memory: HealthSyncMemory { HealthSyncMemory(defaults: defaults) }

    /// The parts, with Clarity started on a fake so the events can be read.
    private func parts(_ health: FakeHealthStore) throws -> (RecordStore, AppleHealthSync, FakeSDK) {
        let engine = try HealthEngine()
        let store = try RecordStore(folder: folder, engine: engine, deviceId: "test")
        let sync = AppleHealthSync(store: store, engine: engine, client: health, memory: memory)
        let sdk = FakeSDK()
        let analytics = Analytics(sdk: sdk, projectId: "abc", testing: false)
        analytics.start(in: UIWindow())
        sync.analytics = analytics
        return (store, sync, sdk)
    }

    /// An R4 HbA1c result as a provider sends it (LOINC 4548-4, NGSP %), drawn 2026-10-01.
    private static func hba1c(id: String = "obs-1", version: String = "1", status: String = "final", value: Double = 5.6) -> HealthRecord {
        let json = """
        {"resourceType":"Observation","id":"\(id)","meta":{"versionId":"\(version)"},"status":"\(status)",\
        "code":{"coding":[{"system":"http://loinc.org","code":"4548-4","display":"Hemoglobin A1c"}]},\
        "effectiveDateTime":"2026-10-01T09:00:00Z",\
        "valueQuantity":{"value":\(value),"unit":"%","system":"http://unitsofmeasure.org","code":"%"}}
        """
        return HealthRecord(sourceId: "com.apple.health.clinical.test|Test Hospital", resourceType: "Observation", fhirVersion: "4.0.1", json: json)
    }

    /// A DSTU2 panel as a US lab sends it: one DiagnosticReport, its HbA1c and LDL contained
    /// (no meta of their own), referenced from `result`. Synthetic values.
    private static func panel() -> HealthRecord {
        let json = """
        {"resourceType":"DiagnosticReport","id":"panel-1","status":"final","meta":{"lastUpdated":"2026-10-02T09:00:00Z"},\
        "effectiveDateTime":"2026-10-01T09:00:00Z","issued":"2026-10-02T09:00:00Z",\
        "contained":[\
        {"resourceType":"Observation","id":"r1","status":"final","code":{"coding":[{"system":"http://loinc.org","code":"4548-4"}]},\
        "effectiveDateTime":"2026-10-01T09:00:00Z","valueQuantity":{"value":5.6,"unit":"%"}},\
        {"resourceType":"Observation","id":"r2","status":"final","code":{"coding":[{"system":"http://loinc.org","code":"13457-7"}]},\
        "effectiveDateTime":"2026-10-01T09:00:00Z","valueQuantity":{"value":100,"unit":"mg/dL"}}],\
        "result":[{"reference":"#r1"},{"reference":"#r2"}]}
        """
        return HealthRecord(sourceId: "com.apple.health.clinical.test|Test Hospital", resourceType: "DiagnosticReport", fhirVersion: "1.0.2", json: json)
    }

    /// A result HealthKit took out of a panel, as it hands one over (AC17). Synthetic values.
    private static func fromPanel(_ id: String, loinc: String, value: Double, unit: String) -> HealthRecord {
        let json = """
        {"resourceType":"Observation","id":"DiagnosticReport/panel-1#\(id)","status":"final",\
        "meta":{"profile":["http://fhir.org/guides/argonaut/StructureDefinition/argo-observationresults"]},\
        "code":{"coding":[{"system":"http://loinc.org","code":"\(loinc)"}]},\
        "effectiveDateTime":"2026-10-01T09:00:00Z","valueQuantity":{"value":\(value),"unit":"\(unit)"}}
        """
        return HealthRecord(sourceId: "com.apple.health.clinical.test|Test Hospital", resourceType: "Observation", fhirVersion: "1.0.2", json: json)
    }

    private func rows(_ store: RecordStore, source: String = "health_records") throws -> [[String: Any]] {
        let record = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(store.recordJSON.utf8)) as? [String: Any])
        let measurements = record["measurements"] as? [[String: Any]] ?? []
        // Every result is a lab row, a core test's included (one blood-test table): none in measurements.
        XCTAssertFalse(measurements.contains { $0["source"] as? String == "health_records" })
        return (measurements + (record["labValues"] as? [[String: Any]] ?? [])).filter { $0["source"] as? String == source }
    }

    // MARK: AC1, AC13: asked only where it works, in the one request

    func testWhereRecordsWorkTheOneRequestAsksAndSaysSo_US72_AC1_AC13() async throws {
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        let (_, sync, sdk) = try parts(health)
        await sync.connect()
        XCTAssertEqual(health.requests, 1, "one request, lab results inside it (D6, D12)")
        XCTAssertEqual(sdk.events, ["Health Records asked"])

        // Asked again later (a second connect): HealthKit says no sheet is needed, so no event.
        await sync.connect()
        XCTAssertEqual(sdk.events, ["Health Records asked"])
    }

    func testWhereRecordsDoNotWorkNothingAsksOrReadsThem_US72_AC1() async throws {
        let health = FakeHealthStore()
        health.pendingRecords = [Self.hba1c()]
        let (store, sync, sdk) = try parts(health)
        await sync.connect()
        XCTAssertTrue(sdk.events.isEmpty)
        XCTAssertEqual(health.recordReads, 0, "never read where Apple does not offer Health Records")
        XCTAssertNil(memory.labResultsAnchor)
        XCTAssertTrue(try rows(store).isEmpty)
    }

    /// AC1 on the real client: lab results are read-only and never in the app's write set,
    /// and the base request still holds exactly the vitals and US-56's types.
    func testLabResultsAreReadOnlyAndOnlyAddedWhereSupported_US72_AC1() {
        XCTAssertEqual(HealthKitClient.labResults, HKClinicalType(.labResultRecord))
        XCTAssertFalse(HealthKitClient.requested.share.contains(HealthKitClient.labResults))
        XCTAssertFalse(HealthKitClient.requested.read.contains(HealthKitClient.labResults), "added only when supportsHealthRecords")
    }

    // MARK: AC1, AC13: asked once on coming forward

    /// Connected before this build: coming on screen asks for lab results once when
    /// HealthKit says a request is needed, then imports.
    func testAnAlreadyConnectedPersonIsAskedOnceOnForeground_US72_AC1_AC13() async throws {
        memory.connected = true
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        let (store, sync, sdk) = try parts(health)
        await sync.foreground()
        XCTAssertEqual(health.labRequests, 1)
        XCTAssertEqual(health.requests, 0, "only lab results, not the whole sheet again")
        XCTAssertEqual(sdk.events, ["Health Records asked", "Health Records imported"])
        XCTAssertEqual(try rows(store).count, 1)

        await sync.foreground()
        XCTAssertEqual(health.labRequests, 1, "asked once")
    }

    /// Austin's report (TestFlight 2026-11-09): with no Health Records account, or after
    /// closing the sheet, HealthKit keeps saying a request is needed. Coming on screen
    /// asks once, ever: not on the next return, not after a relaunch.
    func testAPersonHealthKitKeepsAskingAboutIsAskedOnlyOnce_US72_AC1() async throws {
        memory.connected = true
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.recordsStayDue = true
        let (_, sync, sdk) = try parts(health)
        await sync.foreground()
        await sync.foreground()
        XCTAssertEqual(health.labRequests, 1)
        XCTAssertEqual(sdk.events, ["Health Records asked"])
        XCTAssertNotNil(memory.labResultsAsked)

        let (_, relaunched, _) = try parts(health)
        await relaunched.foreground()
        XCTAssertEqual(health.labRequests, 1, "remembered across launches")
    }

    /// Connect showed the lab results sheet already: coming on screen never asks again,
    /// even while HealthKit still says a request is needed.
    func testConnectingCountsAsTheOneAsk_US72_AC1() async throws {
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.recordsStayDue = true
        let (_, sync, sdk) = try parts(health)
        await sync.connect()
        await sync.foreground()
        XCTAssertEqual(health.requests, 1)
        XCTAssertEqual(health.labRequests, 0)
        XCTAssertEqual(sdk.events.filter { $0 == "Health Records asked" }.count, 1)
    }

    func testForegroundAsksNothingWhereRecordsDoNotWorkOrHealthIsNotConnected_US72_AC1() async throws {
        let unsupported = FakeHealthStore()
        memory.connected = true
        let (_, connectedSync, connectedSdk) = try parts(unsupported)
        await connectedSync.foreground()
        XCTAssertEqual(unsupported.labRequests, 0)
        XCTAssertTrue(connectedSdk.events.isEmpty)

        memory.connected = false
        let notConnected = FakeHealthStore()
        notConnected.supportsHealthRecords = true
        let (_, sync, sdk) = try parts(notConnected)
        await sync.foreground()
        XCTAssertEqual(notConnected.labRequests, 0)
        XCTAssertTrue(sdk.events.isEmpty)
    }

    func testForegroundAsksNothingWhenHealthKitSaysNoRequestIsNeeded_US72_AC1_AC13() async throws {
        memory.connected = true
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.recordsNotYetAsked = false
        let (_, sync, sdk) = try parts(health)
        await sync.foreground()
        XCTAssertEqual(health.labRequests, 0)
        XCTAssertFalse(sdk.events.contains("Health Records asked"))
        XCTAssertNil(memory.labResultsAsked, "no sheet showed, so nothing is remembered")

        health.recordsNotYetAsked = true
        await sync.foreground()
        XCTAssertEqual(health.labRequests, 1, "a later need still gets its one ask")
    }

    /// A request that fails shows no sheet: nothing is remembered and the next return asks.
    func testAFailedRequestIsNotTheOneAsk_US72_AC1() async throws {
        memory.connected = true
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.labRequestError = HealthStoreError.locked
        let (_, sync, sdk) = try parts(health)
        await sync.foreground()
        XCTAssertNil(memory.labResultsAsked)
        XCTAssertFalse(sdk.events.contains("Health Records asked"))

        health.labRequestError = nil
        await sync.foreground()
        XCTAssertEqual(health.labRequests, 1)
        XCTAssertNotNil(memory.labResultsAsked)
    }

    // MARK: AC14: Settings' "Share new lab results" row

    /// "Ask Before Sharing" with new results: after the one automatic ask, a tap on the row
    /// shows Health's sheet again, counts the ask and imports what was shared.
    func testTheRowAsksAgainAndImports_US72_AC14() async throws {
        memory.connected = true
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        let (store, sync, sdk) = try parts(health)
        await sync.foreground()
        XCTAssertEqual(health.labRequests, 1)
        await sync.refresh()
        XCTAssertTrue(sync.offersLabResults)

        health.recordsNotYetAsked = true
        await sync.foreground()
        XCTAssertEqual(health.labRequests, 1, "coming forward has had its one ask")
        XCTAssertTrue(try rows(store).isEmpty)
        health.pendingRecords = [Self.hba1c()]
        await sync.shareNewLabResults()
        XCTAssertEqual(health.labRequests, 2)
        XCTAssertEqual(sdk.events, ["Health Records asked", "Health Records asked", "Health Records imported"])
        XCTAssertEqual(try rows(store).count, 1)
    }

    /// Nothing for HealthKit to ask about: the tap shows nothing, counts nothing, reads nothing.
    func testTheRowDoesNothingWhenNoRequestIsNeeded_US72_AC14() async throws {
        memory.connected = true
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.recordsNotYetAsked = false
        let (_, sync, sdk) = try parts(health)
        await sync.refresh()
        let reads = health.recordReads
        await sync.shareNewLabResults()
        XCTAssertEqual(health.labRequests, 0)
        XCTAssertEqual(health.recordReads, reads)
        XCTAssertFalse(sdk.events.contains("Health Records asked"))
        XCTAssertNil(memory.labResultsAsked)
    }

    /// Offered only when connected where Health Records works.
    func testTheRowIsOfferedOnlyWhenConnectedWhereRecordsWork_US72_AC14() async throws {
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        let (_, notConnected, _) = try parts(health)
        XCTAssertFalse(notConnected.offersLabResults)

        memory.connected = true
        let unsupported = FakeHealthStore()
        let (_, elsewhere, _) = try parts(unsupported)
        await elsewhere.refresh()
        XCTAssertFalse(elsewhere.offersLabResults)
        await elsewhere.shareNewLabResults()
        XCTAssertEqual(unsupported.labRequests, 0)
    }

    /// A background wake (an observer delivery) imports, and never asks: no sheet can show.
    func testABackgroundDeliveryNeverAsks_US72_AC1() async throws {
        memory.connected = true
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        let (store, sync, _) = try parts(health)
        sync.start()
        await health.onChange?()
        XCTAssertEqual(health.labRequests, 0)
        XCTAssertEqual(try rows(store).count, 1, "it still imports")
    }

    // MARK: The rules version

    /// A build that reads results the last one refused reads every result again: the
    /// stored rules version differs, so the lab results anchor is dropped once.
    func testANewRulesVersionReadsEveryResultAgain_US72() async throws {
        memory.connected = true
        memory.labResultsAnchor = Data("older build".utf8)
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        let (store, sync, _) = try parts(health)
        await sync.refresh()
        XCTAssertEqual(health.recordAnchors, [nil], "read from the start")
        XCTAssertEqual(memory.labResultsRules, HealthSyncMemory.labResultsRulesVersion)
        XCTAssertEqual(try rows(store).count, 1)

        await sync.refresh()
        XCTAssertEqual(health.recordAnchors.count, 2)
        XCTAssertNotNil(health.recordAnchors[1], "once: the next read starts from the anchor")
    }

    /// A US lab's panel (a DiagnosticReport of contained results) lands each result as a row.
    func testAPanelOfContainedResultsLandsEachResult_US72() async throws {
        memory.connected = true
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.panel()]
        let (store, sync, _) = try parts(health)
        await sync.refresh()
        XCTAssertEqual(Set(try rows(store).compactMap { $0["metricName"] as? String }), ["hba1c", "ldl"])
        XCTAssertNotNil(memory.labResultsAnchor)
    }

    /// What HealthKit hands over for a US lab's panel (AC17): each result its own Observation,
    /// its id `DiagnosticReport/<report>#<result>`. Each lands as a row.
    func testAResultTakenOutOfAPanelLands_US72_AC17() async throws {
        memory.connected = true
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.fromPanel("r1", loinc: "4548-4", value: 5.6, unit: "%"), Self.fromPanel("r2", loinc: "13457-7", value: 100, unit: "mg/dL")]
        let (store, sync, _) = try parts(health)
        await sync.refresh()
        XCTAssertEqual(Set(try rows(store).compactMap { $0["metricName"] as? String }), ["hba1c", "ldl"])
        XCTAssertNotNil(memory.labResultsAnchor)
    }

    /// Rules version 4 (a result HealthKit took out of a panel now lands, AC17): a phone whose
    /// anchor was kept under version 3, past every such result it refused, reads every result again.
    func testAnAnchorKeptUnderRulesVersion3IsReadAgain_US72() async throws {
        XCTAssertEqual(HealthSyncMemory.labResultsRulesVersion, 4)
        memory.connected = true
        memory.labResultsAnchor = Data("version 3 build".utf8)
        memory.labResultsRules = 3
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        let (_, sync, _) = try parts(health)
        await sync.refresh()
        XCTAssertEqual(health.recordAnchors, [nil], "read from the start")
        XCTAssertEqual(memory.labResultsRules, 4)
    }

    // MARK: AC2, AC5: the edit sent

    /// The engine's door (my-data.ts `healthRecords`): each result as it came, Swift parsing nothing.
    func testTheBatchGoesToTheEngineAsItCame_US72_AC2_AC5() throws {
        let record = HealthRecord(sourceId: "src|Clinic", resourceType: "Observation", fhirVersion: "1.0.2", json: #"{"id":"a"}"#)
        let sent = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(RecordEdit.healthRecords([record]))) as? [String: Any])
        XCTAssertEqual(sent["kind"] as? String, "healthRecords")
        let records = try XCTUnwrap(sent["records"] as? [[String: String]])
        XCTAssertEqual(records, [["sourceId": "src|Clinic", "resourceType": "Observation", "fhirVersion": "1.0.2", "json": #"{"id":"a"}"#]])
    }

    /// The engine's counts come back beside the record, and decode.
    func testTheEnginesCountsDecode_US72_AC13() throws {
        let json = #"{"ok":true,"record":"{}","healthRecords":{"added":1,"corrected":0,"withdrawn":2,"alreadyInRecord":3,"notRead":4}}"#
        let outcome = try JSONDecoder().decode(EditOutcome.self, from: Data(json.utf8))
        XCTAssertEqual(outcome.healthRecords, HealthRecordCounts(added: 1, corrected: 0, withdrawn: 2, alreadyInRecord: 3, notRead: 4))
        XCTAssertTrue(outcome.healthRecords?.landed == true)
        XCTAssertFalse(HealthRecordCounts(added: 0, corrected: 0, withdrawn: 1, alreadyInRecord: 5, notRead: 2).landed, "a withdrawal lands no row")
        XCTAssertNil(try JSONDecoder().decode(EditOutcome.self, from: Data(#"{"ok":true,"record":"{}"}"#.utf8)).healthRecords)
    }

    // MARK: Through the engine: rows, anchor, events

    func testAResultLandsAsAHealthRecordsRowAndSaysImported_US72_AC2_AC13() async throws {
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        let (store, sync, sdk) = try parts(health)
        await sync.connect()

        let landed = try rows(store)
        XCTAssertEqual(landed.count, 1)
        XCTAssertEqual(landed.first?["metricName"] as? String, "hba1c", "a core row in labValues (one blood-test table)")
        XCTAssertEqual(landed.first?["core"] as? Bool, true)
        XCTAssertEqual((landed.first?["recordedAt"] as? String)?.prefix(10), "2026-10-01", "the draw, not the download (AC3)")
        XCTAssertEqual(memory.labResultsAnchor, health.recordsAnchorData(), "the anchor moved once the record was saved")
        XCTAssertEqual(sdk.events, ["Health Records asked", "Health Records imported"])
        // On disk, not only on screen.
        XCTAssertEqual(try String(contentsOf: RecordStore.file(in: folder), encoding: .utf8), store.recordJSON)
        guard case .upToDate = sync.status else { return XCTFail("status \(sync.status)") }
    }

    /// AC5, AC13: the same version again lands nothing, and says nothing.
    func testTheSameResultAgainLandsNothingAndSendsNoEvent_US72_AC5_AC13() async throws {
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        let (store, sync, sdk) = try parts(health)
        await sync.connect()
        health.pendingRecords = [Self.hba1c()]
        await sync.refresh()
        XCTAssertEqual(try rows(store).count, 1)
        XCTAssertEqual(sdk.events.filter { $0 == "Health Records imported" }.count, 1)
    }

    /// AC6 through the app: an amended version replaces the row as a correction; the event says imported.
    func testAnAmendedResultCorrectsTheRow_US72_AC6() async throws {
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        let (store, sync, sdk) = try parts(health)
        await sync.connect()
        health.pendingRecords = [Self.hba1c(version: "2", status: "amended", value: 5.9)]
        await sync.refresh()
        let all = try rows(store)
        XCTAssertEqual(all.filter { $0["status"] as? String == "active" }.count, 1)
        XCTAssertEqual(all.filter { $0["status"] as? String == "entered-in-error" }.count, 1)
        XCTAssertNotNil(all.first { $0["status"] as? String == "active" }?["correctsId"])
        XCTAssertEqual(sdk.events.filter { $0 == "Health Records imported" }.count, 2)
    }

    // MARK: The anchor (D6's rules)

    /// iOS answers a refused read with nothing. Keeping that anchor would skip every result
    /// already in Health once the person allows lab results in Settings.
    func testNoAnchorIsKeptUntilABatchBringsResults_US72() async throws {
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        let (store, sync, sdk) = try parts(health)
        await sync.connect()
        XCTAssertEqual(health.recordReads, 1)
        XCTAssertNil(memory.labResultsAnchor)
        XCTAssertFalse(sdk.events.contains("Health Records imported"))

        health.pendingRecords = [Self.hba1c()]
        await sync.refresh()
        XCTAssertNotNil(memory.labResultsAnchor)
        XCTAssertEqual(try rows(store).count, 1)
    }

    /// A record the app cannot read refuses the batch: the anchor stays, so it comes again.
    func testARefusedSaveKeepsTheAnchor_US72() async throws {
        try "not json".write(to: RecordStore.file(in: folder), atomically: true, encoding: .utf8)
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        let (_, sync, sdk) = try parts(health)
        await sync.connect()
        XCTAssertNil(memory.labResultsAnchor)
        XCTAssertFalse(sdk.events.contains("Health Records imported"))
        guard case .failed = sync.status else { return XCTFail("status \(sync.status)") }
    }

    func testALockedPhoneWaitsAndKeepsTheAnchor_US72() async throws {
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.pendingRecords = [Self.hba1c()]
        health.locked = true
        let (store, sync, _) = try parts(health)
        await sync.connect()
        XCTAssertEqual(sync.status, .waitingForUnlock)
        XCTAssertNil(memory.labResultsAnchor)

        health.locked = false
        health.pendingRecords = [Self.hba1c()]
        await sync.refresh()
        XCTAssertEqual(try rows(store).count, 1)
        XCTAssertNotNil(memory.labResultsAnchor)
    }

    /// The import waits its turn in the store's one line: a typed save asked for meanwhile
    /// lands too, and neither overwrites the other.
    func testAnImportAndATypedSaveNeverOverlap_US72() async throws {
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        let (store, sync, _) = try parts(health)
        await sync.connect()
        health.pendingRecords = [Self.hba1c()]
        async let imported: Void = sync.refresh()
        async let typed = store.apply(.add(metric: "weight", value: 80, day: "2026-10-20"))
        let (_, result) = await (imported, typed)
        XCTAssertEqual(result, .saved())
        XCTAssertEqual(try rows(store).count, 1)
        XCTAssertEqual(try rows(store, source: "manual").count, 1, "the typed weight")
    }

    /// Lab results alone count as access: the section never says Health isn't connected.
    func testResultsWithoutVitalsAreUpToDate_US72() async throws {
        let health = FakeHealthStore()
        health.supportsHealthRecords = true
        health.writable = []
        health.pendingRecords = [Self.hba1c()]
        let (_, sync, _) = try parts(health)
        await sync.connect()
        guard case .upToDate = sync.status else { return XCTFail("status \(sync.status)") }
    }
}
