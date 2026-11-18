// The widget's three boxes (US-74 AC2): what each shows, and what it holds.
// Each box keeps the canonical value it was filled with beside its text, so a
// box left as it was filled is that value exactly, never its rounded display
// read back (review A1), and is not the person's entry. Text is read by the
// full app's rules: weight and waist as its vitals grid reads a typed cell
// (blood-test-cell.ts validateTypedValue), height as About you reads its box,
// whole feet and inches in US units, range by validateHealthInputs (A6).
import { cellRange, rangeMessage } from '@roadmap/health-core/cell-unit';
import { commaQuestion, parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { cmToFeetInches, feetInchesToCm, formatDisplayValue, fromCanonicalValue, rangeFault, toCanonicalValue, type UnitSystem } from '@roadmap/health-core/units';
import { convertValidationErrorsToUnits, getValidationErrors, validateHealthInputs } from '@roadmap/health-core/validation';
import { NUMERIC_SYNTAX_GUIDANCE, hasNumericSyntax, readTypedValue } from '../lib/blood-test-cell';

export type Field = 'height' | 'weight' | 'waist';
export const FIELDS: readonly Field[] = ['height', 'weight', 'waist'];
/** Each box's HealthInputs field, as errors and the plan name it. */
export const INPUT_OF = { height: 'heightCm', weight: 'weightKg', waist: 'waistCm' } as const;

/** Height, weight and waist in canonical units (cm, kg, cm); a blank box is absent. */
export interface Measured { heightCm?: number; weightKg?: number; waistCm?: number }

/** One box. `text` is the cm box, or the feet box in US units, with `inches`
 *  beside it. `base`: the canonical value the box was filled with (the record,
 *  or a unit switch of the person's entry). `entered`: that value is the
 *  person's, not the record's. `unit`: the units its text was typed in; text
 *  that is no number keeps them through a switch, and is read only in them (review R4). */
export interface Box { text: string; inches: string; base?: number; entered: boolean; unit?: UnitSystem }
export type Boxes = Record<Field, Box>;

/** A canonical value's text as the full app's form shows it: converted, rounded, no trailing zeros. */
function render(field: Field, value: number | undefined, system: UnitSystem): Pick<Box, 'text' | 'inches'> {
  if (value === undefined) return { text: '', inches: '' };
  if (field === 'height' && system === 'conventional') {
    const { feet, inches } = cmToFeetInches(value);
    return { text: String(feet), inches: String(inches) };
  }
  return { text: String(parseFloat(formatDisplayValue(field, value, system))), inches: '' };
}

/** Boxes filled from the record's values: none of them the person's entry. */
export function boxesFor(values: Measured, system: UnitSystem): Boxes {
  const box = (field: Field): Box => ({ ...render(field, values[INPUT_OF[field]], system), base: values[INPUT_OF[field]], entered: false, unit: system });
  return { height: box('height'), weight: box('weight'), waist: box('waist') };
}

/** A box typed into, in `system`: the text changes, and what it was filled
 *  with stays, so typing it back is no entry. Typing a metric height replaces
 *  any US inches left from a draft (review R4). */
export function typed(box: Box, part: 'text' | 'inches', value: string, system: UnitSystem): Box {
  return { ...box, ...(system === 'si' ? { inches: '' } : {}), [part]: value, unit: system };
}

export type Reading =
  | { kind: 'blank' }
  | { kind: 'error'; message: string; part: Part }
  | { kind: 'value'; value: number; entered: boolean };
/** Which input of a box: the US height has two (review C11). */
export type Part = 'text' | 'inches';

const WHOLE = /^\d+$/;
/** The inches box's words for 12 or more (Codex review 1871b R3). */
export const INCHES_OVER = 'Inches must be 0 to 11';

/** A number still being typed: a decimal separator with nothing after it ("88.", "1,") (review R7). */
const UNFINISHED = /[.,]$/;

/** A box's text as a number by its field's rule, or undefined when it is not one (or not one yet). */
function numberIn(field: Field, text: string, system: UnitSystem): number | undefined {
  const t = text.trim();
  if (UNFINISHED.test(t)) return undefined;
  if (field === 'height' && system === 'conventional') return WHOLE.test(t) ? Number(t) : undefined;
  if (!hasNumericSyntax(t)) return undefined;
  return field === 'height' ? parseLocalisedNumber(t) : readTypedValue(field, t, system);
}

/** The same number as the box was filled with, in any spelling ("88", "88.0", "88,0"): no entry (review C4). */
function sameAsFilled(field: Field, box: Box, system: UnitSystem): boolean {
  if (box.base === undefined || (box.unit !== undefined && box.unit !== system)) return false;
  const shown = render(field, box.base, system);
  const same = (typed: string, filled: string) => typed === filled || (numberIn(field, typed, system) ?? NaN) === numberIn(field, filled, system);
  return same(box.text, shown.text) && same(box.inches, shown.inches);
}

/** What a box says, by the full app's rules, before any range check. A box
 *  that still says what it was filled with is that exact value (review A1, C4). */
export function readBox(field: Field, box: Box, system: UnitSystem): Reading {
  // A US height is checked as written first, before anything reads it as a number, so a refused paste
  // ("010", "8 ") is never taken for the number it looks like (Codex review 1871b R2): one digit of feet
  // and up to two of inches, as About you's boxes hold them, and the inches 0 to 11 (R3).
  if (field === 'height' && system === 'conventional' && (box.unit === undefined || box.unit === system)) {
    if (!/^\d?$/.test(box.text)) return { kind: 'error', message: 'Enter a number', part: 'text' };
    if (!/^\d{0,2}$/.test(box.inches)) return { kind: 'error', message: 'Enter a number', part: 'inches' };
    if (Number(box.inches || 0) > 11) return { kind: 'error', message: INCHES_OVER, part: 'inches' };
  }
  if (sameAsFilled(field, box, system)) return { kind: 'value', value: box.base!, entered: box.entered };
  const text = box.text.trim(), inches = box.inches.trim();
  if (text === '' && inches === '') return { kind: 'blank' };
  // Text typed in the other units is read only in them, never as these (review R4).
  if (box.unit !== undefined && box.unit !== system) return { kind: 'error', message: 'Enter a number', part: 'text' };
  if (field === 'height' && system === 'conventional') {
    return { kind: 'value', value: feetInchesToCm(Number(text || 0), Number(inches || 0)), entered: true };
  }
  const n = numberIn(field, text, system);
  if (n !== undefined) return { kind: 'value', value: toCanonicalValue(field, n, system), entered: true };
  // The vitals grid's words for text that is not a number (blood-test-cell.ts validateTypedValue).
  const message = field === 'height' ? 'Enter a number' : !hasNumericSyntax(text) ? NUMERIC_SYNTAX_GUIDANCE : commaQuestion(text) ?? 'Enter a number';
  return { kind: 'error', message, part: 'text' };
}

/** Why an entry is out of its range, in the units shown, or null: height by
 *  About you's rule (validateHealthInputs), weight and waist by the vitals
 *  grid's (its range and words in the unit shown, rangeMessage). Judged on the
 *  value's meaning, so a unit switch never changes what was typed (review C2). */
function rangeError(field: Field, value: number, system: UnitSystem): string | null {
  if (field === 'height') {
    const validation = validateHealthInputs({ heightCm: value });
    const fault = validation.errors ? getValidationErrors(validation.errors).heightCm : undefined;
    return fault ? convertValidationErrorsToUnits({ heightCm: fault }, system).heightCm : null;
  }
  const fault = rangeFault(cellRange(field, system), fromCanonicalValue(field, value, system));
  return fault ? rangeMessage(field, system, fault) : null;
}

/** The boxes read: their values, which of them the person entered, each box's
 *  error and the input at fault (review C11). Height is required; weight and
 *  waist may be blank. Only an entry is range-checked: a value filled from the
 *  record is not the person's to fix, and is never written. */
export function readBoxes(boxes: Boxes, system: UnitSystem): {
  values: Measured; entered: Set<Field>; errors: Record<string, string>; parts: Partial<Record<Field, Part>>;
} {
  const values: Measured = {}, entered = new Set<Field>(), errors: Record<string, string> = {}, parts: Partial<Record<Field, Part>> = {};
  for (const field of FIELDS) {
    const reading = readBox(field, boxes[field], system);
    if (reading.kind === 'blank') {
      if (field === 'height') { errors.heightCm = 'Required'; parts.height = 'text'; }
      continue;
    }
    if (reading.kind === 'error') { errors[INPUT_OF[field]] = reading.message; parts[field] = reading.part; continue; }
    const fault = reading.entered ? rangeError(field, reading.value, system) : null;
    if (fault) { errors[INPUT_OF[field]] = fault; parts[field] = 'text'; continue; }
    values[INPUT_OF[field]] = reading.value;
    if (reading.entered) entered.add(field);
  }
  return { values, entered, errors, parts };
}

/** The boxes in the other units: any number converts for display and keeps
 *  its meaning, in range or not; blank and unreadable text stays as typed (A1, A6, C2). */
export function switchBoxes(boxes: Boxes, from: UnitSystem, to: UnitSystem): Boxes {
  const out = { ...boxes };
  for (const field of FIELDS) {
    const reading = readBox(field, boxes[field], from);
    if (reading.kind === 'value') out[field] = { ...render(field, reading.value, to), base: reading.value, entered: reading.entered, unit: to };
  }
  return out;
}

/** A box after a save: it now holds the record's `value`, no longer the
 *  person's entry. Text that reads the same number stays as typed, so the box
 *  does not change under the cursor; other text shows the record's (US-74 AC4). */
export function settle(field: Field, box: Box, value: number | undefined, system: UnitSystem): Box {
  if (value === undefined) return box;
  const reading = readBox(field, box, system);
  if (reading.kind === 'value' && reading.value === value) return { ...box, base: value, entered: false };
  return { ...render(field, value, system), base: value, entered: false, unit: system };
}
