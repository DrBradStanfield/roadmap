import Foundation

/// A value's history and chart, read by the engine once per record revision (US-25 AC21).
/// Split out of RecordStore.swift; the kept histories are stored there.
extension RecordStore {
    /// The history and its chart's inputs, read by the engine once per `stamp` and metric,
    /// off the main thread: a second ask while that read runs (a page and the page above it)
    /// joins it. Kept in `histories`, which a page draws; older revisions' are dropped. Only a
    /// chart that landed is kept: after a failure a second ask reads again (Try again, US-58 AC4c).
    /// `series` "lab": `metric` is a lab test's series key, its own history (US-25 AC25), kept apart
    /// from a core metric of the same name. Nothing from a record an erase replaced (US-25 AC21).
    func chart(for metric: String, series: String? = nil) async -> ChartData? {
        guard Self.chartsAllowed(hold) else { return nil }
        let stamp = self.stamp(series)
        let key = Self.historyKey(metric, series)
        if let kept = histories[key], kept.stamp == stamp { return kept.chart }
        if let read = reading[key], read.stamp == stamp {
            let chart = await read.task.value
            return hold == .predatesErase ? nil : chart
        }
        let (units, record, deviceId, engine) = (unitChoices.json, recordJSON, deviceId, engine)
        let task = Task {
            (try? await engine.history(recordJSON: record, metric: metric, now: .now, deviceId: deviceId, units: units, series: series)).map(ChartData.init)
        }
        reading[key] = (stamp, task)
        let chart = await task.value
        if reading[key]?.stamp == stamp { reading[key] = nil }
        // The record moved on while the engine ran: a page asks again for the new one. An erase
        // whose draw failed moves no stamp, so it is checked too.
        guard hold != .predatesErase else { return nil }
        if stamp == self.stamp(series) {
            histories = histories.filter { $0.value.stamp.revision == stamp.revision }
            histories[key] = chart.map { KeptHistory(stamp: stamp, chart: $0) }
        }
        return chart
    }

    /// What a kept history is current for: the record's `revision`, and for a worked-out series
    /// (eGFR, waist-to-height) the screen drawn too, since it reads the plan for the day drawn
    /// (an 18th birthday, a next-day resume; review round 3).
    private func stamp(_ series: String?) -> Stamp {
        Stamp(revision: revision, draws: series.map(HealthPage.series.contains) == true ? draws : nil)
    }

    /// A chart reads a record that is drawn, held undrawn or not yet loaded; never an unreadable one
    /// or one an erase replaced (US-25 AC21).
    nonisolated static func chartsAllowed(_ hold: Hold) -> Bool {
        switch hold {
        case .readable, .heldUndrawn, .empty: true
        case .unreadable, .predatesErase: false
        }
    }

    /// A kept history's key: a lab test's is "lab:<series key>", never a core metric's name.
    nonisolated static func historyKey(_ metric: String, _ series: String?) -> String {
        series.map { "\($0):\(metric)" } ?? metric
    }

    /// The chart last read for `metric`, for a page to draw: it may trail the record by one
    /// engine call, and the page's `.task(id: revision)` brings it up to date.
    func shownChart(for metric: String, series: String? = nil) -> ChartData? {
        Self.chartsAllowed(hold) ? histories[Self.historyKey(metric, series)]?.chart : nil
    }

    /// The history read for the record and units as they are now; nil while it trails them
    /// (adversary R2). Only this one may open a correction: a page keeps drawing the older
    /// one, its taps held, until the fresh one lands.
    func shownHistory(for metric: String, series: String? = nil) -> MetricHistory? {
        guard Self.chartsAllowed(hold), let kept = histories[Self.historyKey(metric, series)], kept.stamp == stamp(series) else { return nil }
        return kept.chart.history
    }

    /// A correction sheet's "Now" hint: the value as a current history shows it, only from a
    /// history in `unit`, the one the sheet shows (and for Lp(a), its screen's). Nil until one
    /// is read, never a number in another unit ("100 mg/dL" from 100 nmol/L, Codex R2;
    /// "176.4 kg" once the record flips to lb, re-check N1).
    /// A lab row is hinted in its own unit (US-25 AC25).
    func correctionHint(for id: String, metric: String, series: String? = nil, unit: String, on screen: Screen) -> String? {
        guard let history = shownHistory(for: metric, series: series), let row = history.rows.first(where: { $0.id == id }),
              (row.unit ?? history.unit) == unit, metric != "lpa" || history.unit == screen.lpaUnit else { return nil }
        return row.value
    }
}
