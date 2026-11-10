// The units BloodTestTimeline's typed cells are read and shown in (US-04 AC1,
// US-05 AC2, US-34 AC7). Every cell carries the unit it was typed in
// (useMatrixDraft's stamp), so a unit system the record brings, at load or
// from another device, never re-reads a number already typed: the cell keeps
// its quantity, shown in the new unit. A unit chosen on this page says what
// the numbers typed are in (Brad, 2026-10-13).

import { useLayoutEffect, useRef } from 'react';
import type { LpaUnit, MetricType, UnitSystem } from '@roadmap/health-core/units';
import { type CellUnit, cellText, cellToSI, readTypedValue, validateTypedValue } from './blood-test-cell';
import { useLpaUnit } from './lpa-unit';
import type { CellRef } from './useMatrixDraft';

/** What an Lp(a) cell restored from before its unit was kept says (US-05 AC2). */
const UNCLEAR_UNIT = 'Re-enter this value: its unit is unclear after an update.';

type Cell = CellRef<MetricType>;

export function useBloodDraftUnits({ rows, unitSystem, unitOverrides, unitChoices, unitOf, lpaUnitOf, restamp }: {
  rows: Array<{ metric: MetricType; field: string }>;
  unitSystem: UnitSystem;
  unitOverrides: Record<string, UnitSystem>;
  /** Counts the unit choices made on this page (useUnits). */
  unitChoices: number;
  unitOf: (cell: Cell) => UnitSystem | undefined;
  lpaUnitOf: (cell: Cell) => LpaUnit | undefined;
  restamp: (key: MetricType, from: CellUnit, to: CellUnit, everyCell?: boolean) => void;
}) {
  // Lp(a) has three units on its own control, kept in the record (US-05 AC2);
  // every other field, the two-way toggle.
  const [lpaUnit, chooseLpaUnit] = useLpaUnit(unitSystem);
  // "Type 40, click mg/dL" is 40 mg/dL. Only an Lp(a) number typed by hand
  // on this page is re-read; one the chat filled or the device restored keeps
  // its quantity (useMatrixDraft's `restamp`).
  const pickLpaUnit = (unit: LpaUnit) => {
    restamp('lpa', lpaUnit, unit);
    chooseLpaUnit(unit);
  };
  const fieldUnit = (field: string): CellUnit => (field === 'lpa' ? lpaUnit : unitOverrides[field] ?? unitSystem);
  // Every other test's cell is re-read by a unit choice here that changes its
  // field's unit (the page's pill or the row's chip), whether typed by hand,
  // filled by the chat or restored: its stamp moves from the unit shown to
  // the one chosen. A change with no new choice counted came from the record,
  // and moves none.
  const units = () => rows.map(r => fieldUnit(r.field));
  const shown = useRef({ unitChoices, units: units() });
  useLayoutEffect(() => {
    const was = shown.current;
    shown.current = { unitChoices, units: units() };
    if (was.unitChoices === unitChoices) return;
    rows.forEach(({ metric }, i) => {
      if (metric !== 'lpa' && was.units[i] !== shown.current.units[i]) restamp(metric, was.units[i], shown.current.units[i], true);
    });
  }, [unitChoices, unitSystem, unitOverrides]);
  // The unit a typed cell is read in: the one it was typed in. An Lp(a) cell
  // restored from before that was kept has none: its value waits to be typed
  // again, never guessed (US-05 AC2). Every other cell is stamped as it is
  // restored (useMatrixDraft's `shownUnit`); the field's unit stands in only
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
  return { lpaUnit, pickLpaUnit, fieldUnit, typedUnit, unreadable, shownText };
}
