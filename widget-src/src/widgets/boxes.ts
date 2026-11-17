// The widget's three boxes (US-74 AC2): what each shows, and what it holds.
// Each box keeps the canonical value it was filled with beside its text, so a
// box left as it was filled is that value exactly, never its rounded display
// read back (review A1), and is not the person's entry. Text is read by the
// full app's rules: weight and waist as its vitals grid reads a typed cell
// (blood-test-cell.ts validateTypedValue), height as About you reads its box,
// whole feet and inches in US units, range by validateHealthInputs (A6).
import { parseLocalisedNumber } from '@roadmap/health-core/parseNumber';
import { cmToFeetInches, feetInchesToCm, formatDisplayValue, toCanonicalValue, type UnitSystem } from '@roadmap/health-core/units';
import { convertValidationErrorsToUnits, getValidationErrors, validateHealthInputs } from '@roadmap/health-core/validation';
import { hasNumericSyntax, readTypedValue, validateTypedValue } from '../lib/blood-test-cell';

export type Field = 'height' | 'weight' | 'waist';
export const FIELDS: readonly Field[] = ['height', 'weight', 'waist'];
/** Each box's HealthInputs field, as errors and the plan name it. */
export const INPUT_OF = { height: 'heightCm', weight: 'weightKg', waist: 'waistCm' } as const;

/** Height, weight and waist in canonical units (cm, kg, cm); a blank box is absent. */
export interface Measured { heightCm?: number; weightKg?: number; waistCm?: number }

/** One box. `text` is the cm box, or the feet box in US units, with `inches`
 *  beside it. `base`: the canonical value the box was filled with (the record,
 *  or a unit switch of the person's entry). `entered`: that value is the
 *  person's, not the record's. */
export interface Box { text: string; inches: string; base?: number; entered: boolean }
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
  const box = (field: Field): Box => ({ ...render(field, values[INPUT_OF[field]], system), base: values[INPUT_OF[field]], entered: false });
  return { height: box('height'), weight: box('weight'), waist: box('waist') };
}

/** A box typed into: the text changes, and what it was filled with stays, so typing it back is no entry. */
export function typed(box: Box, part: 'text' | 'inches', value: string): Box {
  return { ...box, [part]: value };
}

export type Reading = { kind: 'blank' } | { kind: 'error'; message: string } | { kind: 'value'; value: number; entered: boolean };

const WHOLE = /^\d+$/;

/** What a box says, by the full app's rules, before any range check. */
export function readBox(field: Field, box: Box, system: UnitSystem): Reading {
  const shown = render(field, box.base, system);
  if (box.base !== undefined && box.text === shown.text && box.inches === shown.inches) return { kind: 'value', value: box.base, entered: box.entered };
  const text = box.text.trim(), inches = box.inches.trim();
  if (text === '' && inches === '') return { kind: 'blank' };
  if (field === 'height' && system === 'conventional') {
    // Whole feet and inches, as About you takes them; a fraction or a suffix is never cut off (A6).
    if (!WHOLE.test(text || '0') || !WHOLE.test(inches || '0')) return { kind: 'error', message: 'Enter a number' };
    return { kind: 'value', value: feetInchesToCm(Number(text || 0), Number(inches || 0)), entered: true };
  }
  if (field === 'height') {
    const n = hasNumericSyntax(text) ? parseLocalisedNumber(text) : undefined;
    return n === undefined ? { kind: 'error', message: 'Enter a number' } : { kind: 'value', value: toCanonicalValue('height', n, 'si'), entered: true };
  }
  const { error } = validateTypedValue(field, text, system);
  const n = readTypedValue(field, text, system);
  if (error || n === undefined) return { kind: 'error', message: error ?? 'Enter a number' };
  return { kind: 'value', value: toCanonicalValue(field, n, system), entered: true };
}

/** The boxes read: their values, which of them the person entered, and each
 *  box's error. Height is required; weight and waist may be blank. Only an
 *  entry is range-checked: a value filled from the record is not the person's
 *  to fix, and is never written. */
export function readBoxes(boxes: Boxes, system: UnitSystem): { values: Measured; entered: Set<Field>; errors: Record<string, string> } {
  const values: Measured = {}, entered = new Set<Field>(), errors: Record<string, string> = {};
  for (const field of FIELDS) {
    const reading = readBox(field, boxes[field], system);
    if (reading.kind === 'error') errors[INPUT_OF[field]] = reading.message;
    if (reading.kind !== 'value') continue;
    values[INPUT_OF[field]] = reading.value;
    if (reading.entered) entered.add(field);
  }
  if (readBox('height', boxes.height, system).kind === 'blank') errors.heightCm = 'Required';
  if (entered.has('height') && !errors.heightCm) {
    // About you's range and words: validateHealthInputs, in the units shown.
    const validation = validateHealthInputs({ heightCm: values.heightCm });
    const fault = validation.errors ? getValidationErrors(validation.errors).heightCm : undefined;
    if (fault) errors.heightCm = convertValidationErrorsToUnits({ heightCm: fault }, system).heightCm;
  }
  for (const key of Object.keys(errors)) delete values[key as keyof Measured];
  return { values, entered, errors };
}

/** The boxes in the other units: a value converts for display and keeps its
 *  canonical value; blank and unreadable text stays as typed (A1, A6). */
export function switchBoxes(boxes: Boxes, from: UnitSystem, to: UnitSystem): Boxes {
  const out = { ...boxes };
  for (const field of FIELDS) {
    const reading = readBox(field, boxes[field], from);
    if (reading.kind === 'value') out[field] = { ...render(field, reading.value, to), base: reading.value, entered: reading.entered };
  }
  return out;
}
