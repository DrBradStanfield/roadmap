// A number typed into a value's input, read and committed (moved from the web's blood-test-cell.ts, which
// re-exports it, so both the web's cells and the shared upload list read typed text by one rule). Pure.

import { parseLocalisedNumber } from './parseNumber';
import { cellRange, cellToSI, type CellUnit } from './cell-unit';
import type { ChoiceChange } from './upload-choices';
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

/**
 * A row's typed text at commit (blur, Enter, focus moving on; owner rulings 2026-11-21): "" unticks the value; a number
 * equal to the one shown sends nothing; another number is an edit (a core value in SI, a lab in its own unit); text that
 * is no number sends nothing, so the input reverts to the view. `shown`: the row's (upload-view.ts `ShownValue`).
 */
export function cellCommit(ref: string, text: string, shown: { number: string; current: number; cell: { metric: MetricType; unit: CellUnit } | null }): ChoiceChange | null {
  const t = text.trim();
  if (t === '') return { tick: ref, on: false };
  const { cell } = shown;
  const typed = cell ? readTypedValue(cell.metric, t, cell.unit) : readNumericCell(t);
  if (typed === undefined) return null;
  const candidate = cell ? cellToSI(cell.metric, typed, cell.unit) : typed;
  return sameAsSaved(typed, shown.number, candidate, shown.current) ? null : { edit: ref, value: candidate };
}
