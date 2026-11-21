// A number typed into a value's input, read (moved from the web's blood-test-cell.ts, which re-exports it), and a read
// value as the person reads it in their unit, so the web's cells and the shared upload read one rule. Pure.

import { commaQuestion, parseLocalisedNumber } from './parseNumber';
import { cellFromSI, cellLabel, cellNumber, cellRange, cellToSI, isCellMetric, unitFits, type CellUnit } from './cell-unit';
import type { OfferedValue } from './import-review';
import type { ExtractedValue } from './lab-extraction';
import { withComparator } from './lab-limits';
import { rangeFault, type MetricType } from './units';
import { REVIEW_CELL_TEXT } from './upload-text';

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
/** A typed number no reading takes (moved from the web's blood-test-cell.ts, byte for byte). */
export const ENTER_A_NUMBER = 'Enter a number';

/** Why held text is no number, in the cells' words (blood-test-cell.ts `validateCell`, US-02 AC4, AC7): the syntax
 *  guidance, the comma question ("Did you mean 1234 or 1.234?"), else "Enter a number". */
export const typedTextError = (text: string): string =>
  (!hasNumericSyntax(text.trim()) ? NUMERIC_SYNTAX_GUIDANCE : commaQuestion(text.trim()) ?? ENTER_A_NUMBER);

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
 *  `current` the value Save would write (a core value in SI), exact; `cell` a core value's metric and unit, null for a lab.
 *  A value as read shows rounded to the unit's display step (12.94 shows "12.9"); the person's own edit shows exact in the
 *  unit they typed it in, never rounded (US-13 AC5: "4.25" stays "4.25"), and in any other unit rounded, as a value read. */
export interface ShownValue { text: string; number: string; unit: string; current: number; cell: { metric: MetricType; unit: CellUnit } | null }

/** A read value as the person reads it: a core value in `unit`, a lab as printed; an edit as Save writes it, exact. A core
 *  metric the units table lacks is shown as printed (its number and unit), `current` still the number Save would send.
 *  `editUnit`: the unit the edit was typed in (`FileChoices.editUnits`, web only); none, the edit is rounded as a value read. */
export function shownValue(at: OfferedValue, edit: number | undefined, unit: CellUnit, editUnit?: CellUnit): ShownValue {
  const comparator = edit === undefined ? at.value.comparator ?? null : null;
  if (at.kind === 'lab') {
    const number = String(edit ?? at.value.value);
    return { text: withComparator(number, comparator), number, unit: at.value.unit, current: edit ?? at.value.value, cell: null };
  }
  if (!isCellMetric(at.value.metric)) {
    const number = String(edit ?? at.value.displayValue);
    return { text: withComparator(number, comparator), number, unit: at.value.displayUnit, current: edit ?? at.value.valueSI, cell: null };
  }
  const metric = at.value.metric;
  const current = edit ?? at.value.valueSI;
  // An edit in the unit it was typed in, exact but for the float noise a unit round trip leaves (12 significant digits).
  const number = edit === undefined || editUnit !== unit ? cellNumber(metric, current, unit, comparator) : String(Number(cellFromSI(metric, edit, unit).toPrecision(12)));
  return { text: withComparator(number, comparator), number, unit: cellLabel(metric, unit), current, cell: { metric, unit } };
}

/** What the report printed, when a core value read shows something else in `unit` (US-13 AC11; moved from the web's
 *  review-matrix.ts): a converted number, or a unit the read guessed. By number: "1.10" is "1.1". A core metric the units
 *  table lacks shows as printed, so only a guessed unit names it. The value as read, never the person's edit. */
export function printedNote(v: Pick<ExtractedValue, 'metric' | 'valueSI' | 'displayValue' | 'displayUnit' | 'comparator' | 'unitGuessed'>, unit: CellUnit): string | null {
  const shown = isCellMetric(v.metric) ? Number(cellNumber(v.metric, v.valueSI, unit, v.comparator)) : v.displayValue;
  return v.unitGuessed || shown !== v.displayValue ? REVIEW_CELL_TEXT.printed(v.displayValue, v.displayUnit) : null;
}

/**
 * Non-empty text typed into a row, committed (owner rulings 2026-11-21; US-13 AC5, AC12; US-02 AC4, AC7): `hold` when it is
 * no number (the text stays in its row, explained, and blocks Save); `same` when it is the row's shown text again (a printed
 * limit's "< 0.6" too), the shown number, or the exact value, and that value is in range, so nothing changes (US-03 AC3);
 * else `edit`, a core value in SI, a lab in its own unit.
 * Retyping the rounded display of an out-of-range value corrects it to the typed number (AC5: LDL 12.94 shown "12.9").
 * The typed number is never rounded: "3.12" over a shown "3.1" is an edit. `unit`: the one typed in (a core value's; null for
 * a lab); null, no change, when the unit does not fit the value (a system unit for a core value, an Lp(a) unit for Lp(a)
 * alone), or for a core metric the units table lacks. `editUnit`: the unit `edit` was typed in, as `shownValue` takes it.
 */
export function typedCommit(text: string, at: OfferedValue, edit: number | undefined, unit: CellUnit | null, editUnit?: CellUnit): { kind: 'hold' } | { kind: 'same' } | { kind: 'edit'; value: number } | null {
  if ((at.kind === 'core') !== (unit !== null)) return null;
  const metric = at.kind === 'core' ? at.value.metric : null;
  if (metric !== null && (!isCellMetric(metric) || !unitFits(metric, unit!))) return null;
  const t = text.trim();
  const shown = shownValue(at, edit, unit ?? 'si', editUnit);
  const valid = !metric || rangeFault(cellRange(metric, 'si'), shown.current) === null;
  if (valid && t === shown.text) return { kind: 'same' };
  const typed = metric && unit ? readTypedValue(metric, t, unit) : readNumericCell(t);
  if (typed === undefined) return { kind: 'hold' };
  const candidate = metric && unit ? cellToSI(metric, typed, unit) : typed;
  return valid && sameAsSaved(typed, shown.number, candidate, shown.current) ? { kind: 'same' } : { kind: 'edit', value: candidate };
}
