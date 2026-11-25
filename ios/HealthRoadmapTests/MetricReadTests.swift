import XCTest
@testable import HealthRoadmap

/// US-58 AC4b, AC4c (iPhone survey S25, 2026-11-13): a metric page's read is one state, changed
/// only by `MetricRead.transition`. A failed read is failed, never empty, and always offers Try
/// again; a landing for another revision changes nothing.
final class MetricReadTests: XCTestCase {
    typealias Read = MetricRead.Read

    /// A chart from a history with these values.
    static func chart(_ values: [String]) throws -> ChartData {
        let rows = values.enumerated().map { #"{"id":"r\#($0.offset)","value":"\#($0.element)","day":"2026-09-0\#($0.offset + 1)","status":"active","current":false,"correction":false}"# }
        let json = #"{"metric":"ldl","label":"LDL","unit":"mmol/L","excluded":false,"rows":[\#(rows.joined(separator: ","))]}"#
        return ChartData(try JSONDecoder().decode(MetricHistory.self, from: Data(json.utf8)))
    }

    /// A state as text, so a table row can name what it expects: ChartData is not Equatable.
    static func named(_ read: Read) -> String {
        switch read {
        case .reading(let revision): "reading(\(revision))"
        case .empty(let revision): "empty(\(revision))"
        case .failed(let revision): "failed(\(revision))"
        case .chart(let revision, let chart): "chart(\(revision), \(chart.history.rows.map(\.value).joined(separator: " ")))"
        }
    }

    /// Every cell: the four states at revision 1, each with every event. A landing for revision 1
    /// is current; one for revision 2 is stale (a read asked before the record moved, or after).
    func testEveryStateAndEventHasItsCell_US58_AC4c() throws {
        let kept = try Self.chart(["3.1"])
        let rows = try Self.chart(["3.4", "3.2"])
        let none = try Self.chart([])
        let states: [Read] = [.reading(revision: 1), .empty(revision: 1), .failed(revision: 1), .chart(revision: 1, kept)]
        let table: [(Read, String, MetricRead.ReadEvent, String)] = [
            // reading
            (states[0], "asked", .asked(revision: 2), "reading(2)"),
            (states[0], "landed failed", .landed(revision: 1, nil), "failed(1)"),
            (states[0], "landed empty", .landed(revision: 1, none), "empty(1)"),
            (states[0], "landed rows", .landed(revision: 1, rows), "chart(1, 3.4 3.2)"),
            (states[0], "landed stale", .landed(revision: 2, rows), "reading(1)"),
            // empty
            (states[1], "asked", .asked(revision: 2), "reading(2)"),
            (states[1], "landed failed", .landed(revision: 1, nil), "empty(1)"),
            (states[1], "landed empty", .landed(revision: 1, none), "empty(1)"),
            (states[1], "landed rows", .landed(revision: 1, rows), "empty(1)"),
            (states[1], "landed stale", .landed(revision: 2, rows), "empty(1)"),
            // failed: Try again asks for the same revision
            (states[2], "asked", .asked(revision: 1), "reading(1)"),
            (states[2], "landed failed", .landed(revision: 1, nil), "failed(1)"),
            (states[2], "landed empty", .landed(revision: 1, none), "failed(1)"),
            (states[2], "landed rows", .landed(revision: 1, rows), "failed(1)"),
            (states[2], "landed stale", .landed(revision: 2, rows), "failed(1)"),
            // chart
            (states[3], "asked", .asked(revision: 2), "reading(2)"),
            (states[3], "landed failed", .landed(revision: 1, nil), "chart(1, 3.1)"),
            (states[3], "landed empty", .landed(revision: 1, none), "chart(1, 3.1)"),
            (states[3], "landed rows", .landed(revision: 1, rows), "chart(1, 3.1)"),
            (states[3], "landed stale", .landed(revision: 2, rows), "chart(1, 3.1)"),
        ]
        XCTAssertEqual(table.count, 20, "4 states x 5 events")
        for (state, event, sent, expected) in table {
            XCTAssertEqual(Self.named(MetricRead.transition(state, sent)), expected, "\(Self.named(state)) x \(event)")
        }
    }

    /// The one cell that makes the bug impossible: an engine throw lands as failed, not empty.
    func testAFailedLandingIsFailedNeverEmpty_US58_AC4c() {
        XCTAssertEqual(Self.named(MetricRead.transition(.reading(revision: 4), .landed(revision: 4, nil))), "failed(4)")
    }

    /// What the page shows for each state, at the page's revision 1 (US-58 AC4b, AC4c).
    func testWhatThePageShows_US58_AC4c() throws {
        let kept = try Self.chart(["3.1"])
        let none = try Self.chart([])
        let page = { (read: Read, kept: ChartData?, hasReadings: Bool, problem: RecordProblem?) in
            Self.named(MetricRead.page(read, revision: 1, problem: problem, kept: kept, hasReadings: hasReadings, screenHasReading: hasReadings))
        }
        XCTAssertEqual(page(.chart(revision: 1, kept), kept, true, nil), "chart 3.1")
        // US-25 AC21: an erase drops the kept charts, sometimes without moving the revision.
        XCTAssertEqual(page(.chart(revision: 1, kept), nil, true, nil), "guide only", "never a chart the store dropped")
        XCTAssertEqual(page(.empty(revision: 1), nil, true, nil), "No data yet", "the read came back with no values")
        XCTAssertEqual(page(.failed(revision: 1), nil, true, nil), "failed: still in record")
        XCTAssertEqual(page(.failed(revision: 1), nil, false, nil), "failed: No data yet", "no value to duplicate: Add beside Try again")
        XCTAssertEqual(page(.reading(revision: 1), nil, true, nil), "guide only", "no flash of No data yet before the chart")
        XCTAssertEqual(page(.reading(revision: 1), nil, false, nil), "No data yet", "nothing to read")
        XCTAssertEqual(page(.reading(revision: 1), kept, true, nil), "chart 3.1", "the older chart while the read runs")
        XCTAssertEqual(page(.reading(revision: 1), none, true, nil), "guide only", "a kept chart with no values draws nothing")
        // A state from an older revision is read as reading until the page asks for the new one.
        XCTAssertEqual(page(.failed(revision: 0), nil, true, nil), "guide only")
        XCTAssertEqual(page(.empty(revision: 0), nil, true, nil), "guide only")
        XCTAssertEqual(page(.chart(revision: 0, kept), nil, true, nil), "guide only", "never the older chart once the store dropped it")
        // The record did not load: its own words, whatever the read.
        let problem = RecordProblem(HealthEngine.EngineError.callFailed("test"))
        for read: Read in [.reading(revision: 1), .empty(revision: 1), .failed(revision: 1), .chart(revision: 1, kept)] {
            XCTAssertEqual(page(read, kept, true, problem), "problem: \(problem.heading)", Self.named(read))
        }
    }

    /// Brad's rules, 14 Nov (US-58 AC4c): every failed read offers Try again. The screen last drawn
    /// decides what else it says: a reading there, sentence A; positively none, "No data yet" and Add
    /// beside Try again; no screen, or one older than an erase, only a kept chart can say, and with
    /// none the page makes no claim either way.
    func testEveryFailedReadOffersTryAgainAndClaimsOnlyWhatTheScreenShows_US58_AC4c() throws {
        let kept = try Self.chart(["3.1"])
        let failed = { (screen: Bool?, kept: ChartData?, hasReadings: Bool) in
            Self.named(MetricRead.page(.failed(revision: 1), revision: 1, problem: nil, kept: kept, hasReadings: hasReadings, screenHasReading: screen))
        }
        XCTAssertEqual(failed(true, nil, true), "failed: still in record", "the screen holds a reading")
        XCTAssertEqual(failed(false, nil, false), "failed: No data yet", "the screen positively holds none")
        // The screen drawn decides, never the failed read (which kept nothing) or the page's own row.
        XCTAssertEqual(failed(true, nil, false), "failed: still in record", "the drawn screen's reading, though the read kept nothing")
        XCTAssertEqual(failed(false, kept, true), "failed: No data yet", "the drawn screen holds none, whatever else says so")
        // No screen, or one from before an erase: only a chart the store still keeps can say.
        XCTAssertEqual(failed(nil, kept, true), "failed: still in record", "the store still keeps values")
        XCTAssertEqual(failed(nil, try Self.chart([]), true), "failed: No data yet", "kept, with no values")
        XCTAssertEqual(failed(nil, nil, true), "failed: unknown", "nothing establishes it: no claim either way")
        XCTAssertEqual(failed(nil, nil, false), "failed: unknown", "the page's own row is no evidence")
    }

    /// The failed read's words, in one place: sentence A (Brad, 13 Nov) and its first sentence alone (14 Nov).
    func testAFailedReadsWords_US58_AC4c() {
        XCTAssertEqual(MetricRead.couldNotRead("LDL", stillInRecord: true), "Your LDL values could not be read. They are still in your record.")
        XCTAssertEqual(MetricRead.couldNotRead("LDL", stillInRecord: false), "Your LDL values could not be read.")
    }

    /// Lead S31 (US-58 AC4c): a worked-out series reads the plan for the screen drawn, so a read
    /// that a redraw overtakes (a return past midnight) is for a day no longer shown. The page asks
    /// once per revision and a redraw moves none, so what it lands must be read for the screen now.
    @MainActor
    func testAReadWhoseScreenWasRedrawnMidReadDoesNotLand_S31_US58_AC4c() async throws {
        let folder = FileManager.default.temporaryDirectory.appending(path: "Metric Read \(UUID().uuidString)")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: folder) }
        let sample = try XCTUnwrap(Bundle(for: Self.self).url(forResource: "sample.record", withExtension: "json"))
        try Data(contentsOf: sample).write(to: folder.appending(path: "health-roadmap.json"))
        let store = try RecordStore(folder: folder, engine: HealthEngine(), deviceId: "test")
        await XCTAssertSaved(await store.apply(.add(metric: "waist", value: 88, day: "2026-10-20")))
        let (revision, draws) = (store.revision, store.draws)

        let asked = Task { await store.chart(for: "whtr", series: "whtr") }
        while store.reading[RecordStore.historyKey("whtr", "whtr")] == nil { await Task.yield() }
        store.display(store.drawn) // the screen drawn again while the engine reads
        let read = MetricRead.transition(.reading(revision: revision), .landed(revision: revision, await asked.value))

        XCTAssertEqual(store.revision, revision, "a redraw moves no revision, so the page asks nothing more")
        XCTAssertGreaterThan(store.draws, draws)
        XCTAssertNotNil(store.shownHistory(for: "whtr", series: "whtr"), "what landed was read for the screen drawn now")
        let page = MetricRead.page(read, revision: store.revision, problem: nil, kept: store.shownChart(for: "whtr", series: "whtr"),
                                   hasReadings: true, screenHasReading: true)
        XCTAssertTrue(Self.named(page).hasPrefix("chart "), "the page draws the ratio, not \(Self.named(page))")
    }

    static func named(_ page: MetricRead.Page) -> String {
        switch page {
        case .chart(let chart): "chart \(chart.history.rows.map(\.value).joined(separator: " "))"
        case .noDataYet: "No data yet"
        case .guideOnly: "guide only"
        case .failed(.stillInRecord): "failed: still in record"
        case .failed(.noneShown): "failed: No data yet"
        case .failed(.unknown): "failed: unknown"
        case .problem(let problem): "problem: \(problem.heading)"
        }
    }
}
