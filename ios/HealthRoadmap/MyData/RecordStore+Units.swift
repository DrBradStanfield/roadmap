import Foundation

/// Per-test units, Lp(a)'s unit and the units onboarding reads (US-25 AC17e, US-05 AC2, US-54 AC6).
/// Split out of RecordStore.swift; the edit checks that read units stay there.
extension RecordStore {
    /// The units the row for `metric` shows: its per-test choice, else the record's (AC17e).
    func units(for metric: String) -> String {
        unitChoices.system(for: metric, record: myData?.unitSystem ?? "si")
    }

    /// The range a value typed for `metric` is read against: in `unit` (an Lp(a) unit or
    /// "si"/"conventional") when given, else in the units the metric is shown in (US-02 AC7);
    /// nil from an older engine.
    func inputRange(for metric: String, in unit: String? = nil) -> ClosedRange<Double>? {
        myData?.inputRange(metric, unit ?? units(for: metric))
    }

    /// One test to the other units, as the web's unit chip does. Back to the record's
    /// units drops the choice; nothing is written to the record.
    @discardableResult
    func switchUnits(for row: MyData.Row, to system: String) -> Task<Void, Never> {
        unitSwitches += 1
        return chain {
            defer { self.unitSwitches -= 1 }
            guard row.switchable == true, let data = self.myData else { return }
            let choices = self.unitChoices.setting(row.metric, to: system == data.unitSystem ? nil : system)
            // Drawn first: a choice the screen cannot show is not kept, so labels and reading agree.
            guard let shown = try? await self.engine.screen(recordJSON: self.recordJSON, now: .now, deviceId: self.deviceId, units: choices.json) else { return }
            self.display(shown)
            self.publish(choices)
        }
    }

    /// Lp(a)'s units, in the web's order (health-core's LPA_UNITS).
    static let lpaUnits = ["nmol/L", "mg/dL", "mg/L"]

    /// Lp(a)'s unit, from its page's menu or a sheet's picker (US-05 AC2, US-25 AC20): a record
    /// edit, as the web's control writes it, so it syncs; the unit already stored writes nothing.
    /// Not a typed value, so it is checked against the record when its turn comes, never a
    /// sheet's screen. Entry waits while it lands, as for any unit switch. A sheet open as it
    /// is chosen there shows it from then on and moves its own screen with it
    /// (`ValueEntrySheet.lpaUnits`), so a value typed there is read in the unit shown at Save.
    /// Entry is held, and its turn taken, in the tap itself, as `switchUnits` does: a tap
    /// queued behind the menu cannot open a sheet on the old unit (merge review R1, F1).
    @discardableResult
    func setLpaUnit(_ unit: String) -> Task<ApplyResult, Never> {
        unitSwitches += 1
        return chain {
            defer { self.unitSwitches -= 1 }
            let result = await self.applyInTurn(.lpaUnit(unit), as: self.screen)
            if result == .saved() { self.forgetCharts() }
            return result
        }
    }

    /// The same, answering a refusal's words, nil when it was taken.
    func chooseLpaUnit(_ unit: String) -> Task<String?, Never> {
        let setting = setLpaUnit(unit)
        return Task {
            if case .refused(let message, _) = await setting.value { return message }
            return nil
        }
    }

    /// Lp(a)'s unit as the record holds it now, for an Lp(a) row; nil for any other.
    func lpaUnit(for row: MyData.Row) -> String? {
        Self.lpaUnit(for: row, recordUnit: myData?.lpaUnit)
    }

    /// Lp(a)'s unit only on the core Lp(a) row: a lab test filed as "lpa" is read in its own
    /// unit, never the record's Lp(a) unit (US-25 AC25, review N1).
    nonisolated static func lpaUnit(for row: MyData.Row, recordUnit: String?) -> String? {
        row.series == nil && row.metric == "lpa" ? recordUnit : nil
    }

    /// A row's input range in `unit`: a core metric's; none for a lab test, whatever its name
    /// (US-25 AC25, review N1).
    func inputRange(for row: MyData.Row, in unit: String? = nil) -> ClosedRange<Double>? {
        row.series == nil ? inputRange(for: row.metric, in: unit) : nil
    }

    /// The units the web's first-visit rule gives this phone's region and time zone, by the
    /// engine; nil if it cannot say. Onboarding's region default (US-54 AC6, US-05 AC5).
    func regionUnits() async -> String? {
        try? await engine.regionUnits()
    }

    /// A typed value in the other units ("si" or "conventional"), by the engine; nil if it
    /// cannot. Onboarding's entry-only unit switches (US-54 AC6).
    func convert(_ value: Double, metric: String, from: String, to: String) async -> UnitConversion? {
        try? await engine.convert(value, metric: metric, from: from, to: to)
    }
}
