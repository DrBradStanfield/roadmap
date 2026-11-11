// The units BloodTestTimeline's typed cells are read and shown in (US-04 AC1,
// US-05 AC2, US-34 AC7). Every cell carries the unit it was typed in
// (useMatrixDraft's stamp), so a unit system the record brings, at load or
// from another device, never re-reads a number already typed: the cell keeps
// its quantity, shown in the new unit. A unit chosen on this page says what
// the numbers typed are in (Brad, 2026-10-13), for the cells typed by hand on
// this load of the page only: a row's own unit control, or the page's Units
// or Height pill, re-reads them.

import { useEffect, useRef } from 'react';
import type { LpaUnit, MetricType, UnitSystem } from '@roadmap/health-core/units';
import type { UnitSwitchListener } from '../hooks/useUnits';
import { type CellUnit, cellText, cellToSI, readTypedValue, validateTypedValue } from './blood-test-cell';
import { useLpaUnit } from './lpa-unit';
import type { CellRef } from './useMatrixDraft';

/** What an Lp(a) cell restored from before its unit was kept says (US-05 AC2). */
const UNCLEAR_UNIT = 'Re-enter this value: its unit is unclear after an update.';

type Cell = CellRef<MetricType>;
/** A field's own unit toggle (useUnits' `handleToggleFieldUnit`): the turn it made. */
export type FieldUnitToggle = (field: string) => { from: UnitSystem; to: UnitSystem };
/** This tab's switch of the unit system, subscribed to (useUnits' `onSwitch`); returns the unsubscribe. */
export type UnitSwitchSource = (listener: UnitSwitchListener) => () => void;

export function useBloodDraftUnits({ rows, unitSystem, unitOverrides, onToggleFieldUnit, onUnitSwitch, unitOf, lpaUnitOf, restamp }: {
  rows: Array<{ metric: MetricType; field: string }>;
  unitSystem: UnitSystem;
  unitOverrides: Record<string, UnitSystem>;
  onToggleFieldUnit: FieldUnitToggle;
  onUnitSwitch?: UnitSwitchSource;
  unitOf: (cell: Cell) => UnitSystem | undefined;
  lpaUnitOf: (cell: Cell) => LpaUnit | undefined;
  restamp: (key: MetricType, from: CellUnit, to: CellUnit) => void;
}) {
  // Lp(a) has three units on its own control, kept in the record (US-05 AC2);
  // every other field, the two-way toggle.
  const [lpaUnit, chooseLpaUnit] = useLpaUnit(unitSystem);
  const fieldUnit = (field: string): CellUnit => (field === 'lpa' ? lpaUnit : unitOverrides[field] ?? unitSystem);
  // "Type 40, click mg/dL" is 40 mg/dL: a row's own unit control re-reads
  // the numbers typed by hand on this page. One the chat filled or the device
  // restored keeps its quantity (useMatrixDraft's `restamp`), and so does
  // every cell through another surface's chip (the upload review).
  const pickLpaUnit = (unit: LpaUnit) => {
    restamp('lpa', lpaUnit, unit);
    chooseLpaUnit(unit);
  };
  // The re-read turns as the toggle did: from the unit the person saw at the
  // press, which a record's units landing mid-press do not change (PR 1204 F2).
  const toggleUnit = (metric: MetricType, field: string) => {
    const { from, to } = onToggleFieldUnit(field);
    restamp(metric, from, to);
  };
  // The page's Units or Height pill switches the unit system (useUnits' `onSwitch`):
  // a unit chosen here too (Brad, 2026-11-10, PR 1147 re-check R1). Its press
  // leaves the matrix, which commits the cells typed by hand first
  // (useSaveOnLeave); one it could not commit (out of range: "135" typed in
  // mmol/L) is re-read in the new unit as the switch is made, before it
  // renders. A field already in the new unit (by its own chip) keeps it.
  // Lp(a) keeps its own rule (US-05 AC2): left out here.
  const switchSystem = useRef<UnitSwitchListener>(() => {});
  switchSystem.current = (_from, to) => {
    for (const { metric, field } of rows) if (metric !== 'lpa' && fieldUnit(field) !== to) restamp(metric, fieldUnit(field), to);
  };
  useEffect(() => onUnitSwitch?.((from, to) => switchSystem.current(from, to)), [onUnitSwitch]);
  // The unit a typed cell is read in: the one it was typed in. An Lp(a) cell
  // restored from before that was kept has none: its value waits to be typed
  // again, never guessed (US-05 AC2). Every other cell is stamped as it is
  // restored (useMatrixDraft's `legacyUnit`); the field's unit stands in only
  // if a stamp is missing.
  const typedUnit = (column: string | null, metric: MetricType, field: string): CellUnit | undefined =>
    metric === 'lpa' ? lpaUnitOf([column, metric]) : unitOf([column, metric]) ?? fieldUnit(field);
  // Why a typed cell cannot be read: its unit unclear, or its number out of
  // range in the unit it was typed in. The cell shows this whatever unit it
  // is shown in: 750.1 nmol/L reads "300.0" mg/dL, inside that range.
  const unreadable = (column: string | null, metric: MetricType, field: string, typed: string) => {
    if (!typed) return null;
    const unit = typedUnit(column, metric, field);
    return unit ? validateTypedValue(metric, typed, unit).error : UNCLEAR_UNIT;
  };
  // What a typed cell shows: as typed, or, for a cell typed in another unit,
  // the same quantity in the field's unit.
  const shownText = (column: string | null, metric: MetricType, field: string, typed: string) => {
    const unit = typedUnit(column, metric, field);
    const n = unit ? readTypedValue(metric, typed, unit) : undefined;
    return !unit || unit === fieldUnit(field) || n === undefined ? typed : cellText(metric, cellToSI(metric, n, unit), fieldUnit(field));
  };
  // The cell's own check (NumericInputCell's `validationResult`): a cell
  // shown in another unit is judged as it saves, its text in the unit it was
  // typed in, never the rounded number shown: 12.9 mmol/L shows "499" mg/dL,
  // over the 498 mg/dL bound (Codex R2, PR 1147). So it skips the check of
  // the text shown (null), and `unreadable`, the cell's error, says what is
  // wrong. Undefined: the cell checks the text it shows, which is as typed.
  const checkOf = (column: string | null, metric: MetricType, field: string, typed: string) =>
    (shownText(column, metric, field, typed) === typed ? undefined : null);
  return { lpaUnit, pickLpaUnit, toggleUnit, fieldUnit, typedUnit, unreadable, shownText, checkOf };
}
