// The unit a core value is shown and typed in (US-05 AC2): one of its metric's
// two systems, or, for Lp(a), one of the three units its field takes, read
// through the unit table (mg/L is a tenth of mg/dL). The website's matrices and
// the iPhone app's My data both read and write through these.

import {
  LPA_UNITS, UNIT_DEFS, canonicalToReported, formatDisplayValue, fromCanonicalValue, getDisplayLabel, getDisplayRange,
  lookupUnit, reportedToCanonical, toCanonicalValue, unitDecimalPlaces,
  type LpaUnit, type MetricType, type UnitSystem, type ValidationRange,
} from './units';

/** The unit a core cell is typed and shown in: one of its metric's two
 *  systems, or, for Lp(a), one of the three units its field takes (US-05
 *  AC2), read through the unit table (mg/L is a tenth of mg/dL). */
export type CellUnit = UnitSystem | LpaUnit;

/** One of Lp(a)'s three units. A record's `profile.lpaUnit` is unchecked: a hand edit can hold anything. */
export const isLpaUnit = (unit: unknown): unit is LpaUnit => (LPA_UNITS as readonly unknown[]).includes(unit);

/** Lp(a)'s unit from the record: its saved choice, else US units give mg/dL and any other nmol/L. */
export function recordLpaUnit(saved: unknown, unitSystem: UnitSystem | undefined): LpaUnit {
  if (isLpaUnit(saved)) return saved;
  return unitSystem === 'conventional' ? 'mg/dL' : 'nmol/L';
}

const isSystem = (unit: CellUnit): unit is UnitSystem => unit === 'si' || unit === 'conventional';

/** A number typed in `unit`, as the record stores it. */
export function cellToSI(metric: MetricType, typed: number, unit: CellUnit): number {
  return isSystem(unit) ? toCanonicalValue(metric, typed, unit) : reportedToCanonical(metric, typed, unit)!.valueSI;
}

/** A stored value in `unit`, unrounded. */
export function cellFromSI(metric: MetricType, valueSI: number, unit: CellUnit): number {
  return isSystem(unit) ? fromCanonicalValue(metric, valueSI, unit) : canonicalToReported(metric, valueSI, unit)!;
}

/** The decimal places a cell shows in `unit`: Lp(a) at one in mg/dL, none
 *  in nmol/L and mg/L. */
export function cellDecimalPlaces(metric: MetricType, unit: CellUnit): number {
  if (isSystem(unit)) return unitDecimalPlaces(metric, unit);
  const { system, scale } = lookupUnit(metric, unit)!; // every Lp(a) unit is in the unit table
  return unitDecimalPlaces(metric, system, scale);
}

/** A stored value as the cell shows it, at its unit's step. */
export function cellText(metric: MetricType, valueSI: number, unit: CellUnit): string {
  if (isSystem(unit)) return formatDisplayValue(metric, valueSI, unit);
  return cellFromSI(metric, valueSI, unit).toFixed(cellDecimalPlaces(metric, unit));
}

/** The unit's label: the system's for the metric, or the Lp(a) unit itself. */
export function cellLabel(metric: MetricType, unit: CellUnit): string {
  return isSystem(unit) ? getDisplayLabel(metric, unit) : unit;
}

/** The range a value typed in `unit` must fall in: the system's, or the
 *  canonical range in that Lp(a) unit (0–3000 mg/L). */
export function cellRange(metric: MetricType, unit: CellUnit): ValidationRange {
  if (isSystem(unit)) return getDisplayRange(metric, unit);
  const range = UNIT_DEFS[metric].validationRange.si; // Lp(a)'s canonical unit is its SI one
  return { ...range, min: cellFromSI(metric, range.min, unit), max: cellFromSI(metric, range.max, unit) };
}
