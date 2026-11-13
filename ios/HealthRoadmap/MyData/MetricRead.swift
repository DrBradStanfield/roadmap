import Foundation

/// A metric page's read of its chart (US-58 AC4b, AC4c; iPhone survey S25): one state, changed
/// only by `transition`. The page asks once per record revision and again from Try again; the
/// answer lands for the revision it was asked at, so a late answer for another revision changes
/// nothing. A failed read is its own state and always offers Try again; it says "No data yet" only
/// where the last good screen shows no reading, since over a value still in the record that invited
/// a duplicate. Web twin: none (ValuePage.tsx has no async read).
@MainActor
enum MetricRead {
    enum Read {
        /// Asked for `revision`, no answer yet. The page opens here at the store's revision.
        case reading(revision: Int)
        /// The read came back with no values.
        case empty(revision: Int)
        /// The engine threw, or the record did not load.
        case failed(revision: Int)
        case chart(revision: Int, ChartData)
    }

    enum ReadEvent {
        /// The page's task, for a new revision or on appear, or Try again.
        case asked(revision: Int)
        /// `store.chart` answered; nil when it failed.
        case landed(revision: Int, ChartData?)
    }

    nonisolated static func transition(_ s: Read, _ e: ReadEvent) -> Read {
        switch (s, e) {
        case (.reading, .asked(let revision)), (.empty, .asked(let revision)), (.failed, .asked(let revision)), (.chart, .asked(let revision)):
            return .reading(revision: revision)
        case (.reading(let asked), .landed(let revision, let chart)):
            guard revision == asked else { return s }
            guard let chart else { return .failed(revision: revision) }
            return chart.history.rows.isEmpty ? .empty(revision: revision) : .chart(revision: revision, chart)
        case (.empty, .landed), (.failed, .landed), (.chart, .landed):
            return s
        }
    }

    /// What the page body shows above the guide.
    enum Page {
        case chart(ChartData)
        /// "No data yet" and "Add your first value".
        case noDataYet
        /// Neither: the guide alone, while a metric with readings is read.
        case guideOnly
        /// A failed read: Try again, with what the app can establish about the metric's values.
        case failed(Failure)
        /// The record did not load: its own heading and words, no Try again.
        case problem(RecordProblem)
    }

    /// What a failed read's page can say beside Try again (Brad, 14 Nov; US-58 AC4c).
    enum Failure: Equatable {
        /// The last good screen shows a reading: sentence A.
        case stillInRecord
        /// It positively shows none: "No data yet" and "Add your first value".
        case noneShown
        /// No screen, one older than an erase, and no kept chart: the first sentence alone.
        case unknown
    }

    /// The page for `read` at the store's `revision`. A state from an older revision reads as
    /// reading until the page asks: the store's `kept` chart if it has values, else "No data yet"
    /// only when My data has no reading, so it never flashes before a chart (US-58 AC4b).
    /// `screenHasReading`: whether the screen last drawn holds a value for the metric; nil when
    /// none was drawn or it predates an erase (`MetricDetailView.screenHasReading`).
    nonisolated static func page(_ read: Read, revision: Int, problem: RecordProblem?, kept: ChartData?, hasReadings: Bool,
                                 screenHasReading: Bool?) -> Page {
        if let problem { return .problem(problem) }
        switch read {
        // Only while the store still keeps a chart: an erase that drops them without moving the
        // revision never leaves the erased values drawn (US-25 AC21, S25 adversary R2).
        case .chart(revision, let chart) where kept != nil: return .chart(chart)
        case .empty(revision): return .noDataYet
        case .failed(revision):
            // The screen drawn decides, never the failed read; with no such screen, a chart the
            // store still keeps; with neither, no claim either way (Brad, 14 Nov).
            guard let held = screenHasReading ?? kept.map({ !$0.history.rows.isEmpty }) else { return .failed(.unknown) }
            return .failed(held ? .stillInRecord : .noneShown)
        case .reading, .empty, .failed, .chart:
            if let kept, !kept.history.rows.isEmpty { return .chart(kept) }
            return hasReadings ? .guideOnly : .noDataYet
        }
    }

    /// A failed read's words: sentence A where the screen shows a reading (Brad, 13 Nov), its first
    /// sentence alone where the app cannot say (Brad, 14 Nov).
    nonisolated static func couldNotRead(_ label: String, stillInRecord: Bool) -> String {
        let read = "Your \(label) values could not be read."
        return stillInRecord ? read + " They are still in your record." : read
    }
}
