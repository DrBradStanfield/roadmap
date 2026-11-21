// A number typed into a value's input, read (moved from the web's blood-test-cell.ts, which re-exports it), and a read
// value as the person reads it in their unit, so the web's cells and the shared upload read one rule. Pure.

import { parseLocalisedNumber } from './parseNumber';
import { cellLabel, cellNumber, cellRange, type CellUnit } from './cell-unit';
import type { OfferedValue } from './import-review';
import { withComparator } from './lab-limits';
import type { MetricType } from './units';

/**
 * A typed value that changes nothing, so saving it writes nothing (US-03
 * AC3): the number the user saw, typed again in any spelling ("3.20", "3,2"),
 * or the stored value itself once converted. `typed` is in the unit it was
 * typed in and `shown` is the saved value as displayed in that unit;
 * `candidate` and `stored` are in the unit the record keeps. The typed
 * number is never rounded: 3.24 over a shown 3.2 is a change.
 */
export function sameAsSaved(typed: number, shown: string, candidate: number, stored: number): boolean {
  const seen = parseLocalisedNumber(shown);
  return (seen !== undefined && closeTo(typed, seen)) || closeTo(candidate, stored);
}

/** Equal up to float noise (1e-9 relative), which is all a unit round trip leaves. */
function closeTo(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(Math.abs(a), Math.abs(b));
}

/** Numeric cells accept unsigned plain decimals, not signs or exponent syntax.
 * Keep this UI contract separate from the shared record/clinical parser. */
export const NUMERIC_SYNTAX_GUIDANCE = 'Type one decimal number, without signs, < > or spaces';

export function hasNumericSyntax(text: string): boolean {
  return /^[0-9.,]+$/.test(text);
}

/** Free-form rows have no metric range for resolving grouped commas. */
export function readNumericCell(text: string): number | undefined {
  return hasNumericSyntax(text) ? parseLocalisedNumber(text) : undefined;
}

/** A typed number in the unit it was typed in: "1,234" is the one reading
 *  inside the metric's input range there, else undefined (US-02 AC7). */
export function readTypedValue(metric: MetricType, typed: string, display: CellUnit): number | undefined {
  return hasNumericSyntax(typed) ? parseLocalisedNumber(typed, cellRange(metric, display)) : undefined;
}

/** A row's number as the person reads and types it: `text` with any limit sign, `number` for the input, `unit` its label;
 *  `current` the value Save would write (a core value in SI); `cell` a core value's metric and unit, null for a lab. */
export interface ShownValue { text: string; number: string; unit: string; current: number; cell: { metric: MetricType; unit: CellUnit } | null }

/** A read value as the person reads it: a core value in `unit`, a lab as printed; an edit as Save writes it, exact. */
export function shownValue(at: OfferedValue, edit: number | undefined, unit: CellUnit): ShownValue {
  const comparator = edit === undefined ? at.value.comparator ?? null : null;
  if (at.kind === 'lab') {
    const number = String(edit ?? at.value.value);
    return { text: withComparator(number, comparator), number, unit: at.value.unit, current: edit ?? at.value.value, cell: null };
  }
  const metric = at.value.metric as MetricType;
  const current = edit ?? at.value.valueSI;
  const number = cellNumber(metric, current, unit, comparator);
  return { text: withComparator(number, comparator), number, unit: cellLabel(metric, unit), current, cell: { metric, unit } };
}
