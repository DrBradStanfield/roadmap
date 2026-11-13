import XCTest
@testable import HealthRoadmap

/// US-58 AC4b, AC4c (iPhone survey S25, 2026-11-13): a metric page's read is one state, changed
/// only by `MetricRead.transition`. A failed read is failed, never empty, so it never says
/// "No data yet"; a landing for another revision changes nothing.
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
            Self.named(MetricRead.page(read, revision: 1, problem: problem, kept: kept, hasReadings: hasReadings))
        }
        XCTAssertEqual(page(.chart(revision: 1, kept), nil, true, nil), "chart 3.1")
        XCTAssertEqual(page(.empty(revision: 1), nil, true, nil), "No data yet", "the read came back with no values")
        XCTAssertEqual(page(.failed(revision: 1), nil, true, nil), "failed")
        XCTAssertEqual(page(.failed(revision: 1), nil, false, nil), "failed", "even when My data has no reading")
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

    /// The engine failure's words, in one place (awaiting Brad's yes on the sentence).
    func testAnEngineFailureNamesTheMetricAndSaysItsValuesAreKept_US58_AC4c() {
        XCTAssertEqual(MetricRead.couldNotRead("LDL"), "Your LDL values could not be read. They are still in your record.")
    }

    static func named(_ page: MetricRead.Page) -> String {
        switch page {
        case .chart(let chart): "chart \(chart.history.rows.map(\.value).joined(separator: " "))"
        case .noDataYet: "No data yet"
        case .guideOnly: "guide only"
        case .failed: "failed"
        case .problem(let problem): "problem: \(problem.heading)"
        }
    }
}
