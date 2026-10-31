// Pure helpers shared by BloodTestTimeline's live matrix and the lab-upload
// review matrix. Anything that touches React state stays in the consuming
// components; everything here is data → data.

import {
  commaQuestion,
  parseLocalisedNumber,
  rangeFault,
  cellLabel,
  cellRange,
  cellToSI,
  HBA1C_THRESHOLDS,
  LDL_THRESHOLDS,
  getLipidStatus,
  TOTAL_CHOLESTEROL_THRESHOLDS,
  HDL_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  APOB_THRESHOLDS,
  LPA_THRESHOLDS,
  PSA_THRESHOLDS,
  type CellUnit,
  type MetricType,
  type ValidationRange,
} from '@roadmap/health-core';

import type React from 'react';

export type Status = 'ok' | 'warn' | 'bad' | null;

// Whom a value is graded for (null: a known minor, US-07 AC6) lives in
// health-core beside rowTarget, which reads it too.
export type { Grading } from '@roadmap/health-core';
import type { Grading } from '@roadmap/health-core';

// The unit a cell is shown and typed in, and its conversions, live in health-core
// (cell-unit.ts), which the iPhone app reads too.
export { type CellUnit, cellToSI, cellFromSI, cellDecimalPlaces, cellText, cellLabel } from '@roadmap/health-core';

// Keystroke filters (US-02 AC4). Most of our numeric cells are type="text"
// (for inputMode/pattern control), and even type="number" doesn't reject
// letters in Safari — so filtering must happen here, not in the browser.
// Control keys (Backspace, Tab, arrows — key.length > 1) and shortcuts
// (cmd/ctrl/alt combos) always pass.
function blockKeysOutside(allowed: RegExp, e: React.KeyboardEvent<HTMLInputElement>) {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length === 1 && !allowed.test(e.key)) e.preventDefault();
}

/** Decimal fields: digits plus locale separators. */
export function blockBadNumericKeys(e: React.KeyboardEvent<HTMLInputElement>) {
  blockKeysOutside(/[0-9.,]/, e);
}

/** Integer-only fields (BP, birth year, pack-years): digits only. */
export function blockNonIntegerKeys(e: React.KeyboardEvent<HTMLInputElement>) {
  blockKeysOutside(/[0-9]/, e);
}

/**
 * Systolic → diastolic auto-advance decision (US-02 AC6).
 * 'advance': unambiguous complete value (3 digits, 100–250) — move focus now.
 * 'defer': plausible 2-digit systolic (60–99) that the user might still extend —
 *          advance after a short pause unless another key arrives.
 * 'stay': prefix ('12' → 120), out-of-range, or non-numeric.
 */
export type BpAdvance = 'advance' | 'defer' | 'stay';
export function bpSysAdvance(typed: string): BpAdvance {
  const t = typed.trim();
  if (!/^\d+$/.test(t)) return 'stay';
  const n = Number(t);
  if (t.length >= 3) return n >= 100 && n <= 250 ? 'advance' : 'stay';
  if (t.length === 2) return n >= 60 && n <= 99 ? 'defer' : 'stay';
  return 'stay';
}

/** A lab value as the matrix shows it: up to two decimals, no trailing zeros. */
export function formatLabValue(v: number): string {
  return String(Math.round(v * 100) / 100);
}

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

/** Text kept for refusal because stripping it could change the number
 *  (US-02 AC4). Lab flag arrows and a unit's own superscript ('5.2 ↑',
 *  '24 kg/m²') are not here, so they still strip. */
const CHANGES_THE_NUMBER = [
  /[\t\p{Pd}\p{Sk}\p{Lm}\p{Pi}\p{Pf}➖]/u, // a sign or dash in any script: '－5', '˗5', 'ー5'
  /(?![↑↓])\p{Sm}/u, // a comparison or approximation: '＜5', '~5'
  /(?![0-9])\p{Nd}/u, // a non-ASCII digit: '1５'
  /[0-9.,]\p{No}|\p{No}[0-9.,]/u, // a superscript touching a digit: '10³'
  /[0-9.,][eE]/, // exponent notation: '1e1'
];

/** Strip decorations only around a single numeric token (US-02 AC4).
 * Keep ambiguous text so validation and every save caller can refuse it. */
export function numericCellText(text: string): string {
  // Text inputs remove line breaks. Keep a visible separator in state too,
  // so DOM selection offsets and replacement pastes address the same text.
  text = text.replace(/\r\n|[\r\n]/g, ' ');
  if (CHANGES_THE_NUMBER.some((pattern) => pattern.test(text))) return text;
  const token = text.match(/^[^0-9.,]*([0-9.,]+)[^0-9.,]*$/);
  return token ? token[1] : /[0-9.,]/.test(text) ? text : '';
}

/** A typed number in the unit it was typed in: "1,234" is the one reading
 *  inside the metric's input range there, else undefined (US-02 AC7). */
export function readTypedValue(metric: MetricType, typed: string, display: CellUnit): number | undefined {
  return hasNumericSyntax(typed) ? parseLocalisedNumber(typed, cellRange(metric, display)) : undefined;
}

/** Validate a typed display-unit value against the metric's range. */
export function validateTypedValue(
  metric: MetricType,
  typed: string,
  display: CellUnit,
): { error: string | null; range: ValidationRange } {
  const range = cellRange(metric, display);
  if (typed === '') return { error: null, range };
  if (!hasNumericSyntax(typed)) return { error: NUMERIC_SYNTAX_GUIDANCE, range };
  const n = readTypedValue(metric, typed, display);
  if (n === undefined) return { error: commaQuestion(typed) ?? 'Enter a number', range };
  // Include the display unit in min/max errors so a user who typed (e.g.)
  // a mg/dL number into an mmol/L field can see the unit mismatch instead
  // of a bare "Max 22.6".
  const unit = cellLabel(metric, display);
  const fault = rangeFault(range, n);
  if (fault === 'below') return { error: `${range.minExclusive ? 'Must be above' : 'Min'} ${range.min} ${unit}`, range };
  if (fault === 'above') return { error: `Max ${range.max} ${unit}`, range };
  return { error: null, range };
}

/** Clinical threshold mapping. Returns null for metrics whose status is
 *  judged elsewhere (e.g. creatinine → eGFR), and for a value the plan leaves
 *  out as out of range, such as a stored LDL 0 (US-03 AC7). */
export function statusOf(metric: MetricType, siValue: number, grading: Grading): Status {
  if (!grading || siValue == null || Number.isNaN(siValue) || rangeFault(cellRange(metric, 'si'), siValue)) return null;
  const { sex } = grading;
  switch (metric) {
    case 'hba1c':
      if (siValue >= HBA1C_THRESHOLDS.diabetes) return 'bad';
      if (siValue >= HBA1C_THRESHOLDS.prediabetes) return 'warn';
      return 'ok';
    case 'ldl': {
      // The LDL tile's grade: amber from the plan's target, as ApoB is from its 0.5 (US-07 AC5)
      const s = getLipidStatus(siValue, LDL_THRESHOLDS);
      return s === 'Optimal' ? 'ok' : s === 'High' || s === 'Very High' ? 'bad' : 'warn';
    }
    case 'total_cholesterol':
      if (siValue >= TOTAL_CHOLESTEROL_THRESHOLDS.high) return 'bad';
      if (siValue >= TOTAL_CHOLESTEROL_THRESHOLDS.borderline) return 'warn';
      return 'ok';
    case 'hdl': {
      // Higher is better. Below lowMale (~1.03) = bad. Between = warn. With
      // no sex, the bands both sexes share: ok only from lowFemale (~1.29),
      // the no-sex hint's ">1.0/>1.3" (US-62 AC13).
      const okGate = sex === 'male' ? HDL_THRESHOLDS.lowMale : HDL_THRESHOLDS.lowFemale;
      if (siValue >= okGate) return 'ok';
      if (siValue >= HDL_THRESHOLDS.lowMale) return 'warn';
      return 'bad';
    }
    case 'triglycerides':
      if (siValue >= TRIGLYCERIDES_THRESHOLDS.high) return 'bad';
      if (siValue >= TRIGLYCERIDES_THRESHOLDS.borderline) return 'warn';
      return 'ok';
    case 'apob':
      if (siValue >= APOB_THRESHOLDS.high) return 'bad';
      if (siValue >= APOB_THRESHOLDS.borderline) return 'warn';
      return 'ok';
    case 'lpa':
      if (siValue >= LPA_THRESHOLDS.elevated) return 'bad';
      if (siValue >= LPA_THRESHOLDS.normal) return 'warn';
      return 'ok';
    case 'psa':
      return siValue >= PSA_THRESHOLDS.normal ? 'warn' : 'ok';
    case 'creatinine': {
      // No formal threshold (eGFR is the clinical gate). Use the adult
      // reference range as the ok ceiling, mild elevation → warn,
      // significant elevation (≥30% over) → bad.
      // With no sex, the bands both sexes share, never one sex's (US-62
      // AC13): ok to the female 90, bad from the male 143, warn between.
      const okMax = sex === 'male' ? 110 : 90; // µmol/L
      const badFrom = (sex === 'female' ? 90 : 110) * 1.3;
      if (siValue >= badFrom) return 'bad';
      if (siValue > okMax) return 'warn';
      return 'ok';
    }
    default:
      return null;
  }
}

/** Live status from a typed display value (parsed + canonicalised). */
export function previewStatus(
  metric: MetricType, typed: string, display: CellUnit, grading: Grading,
): Status {
  const n = readTypedValue(metric, typed, display);
  if (n === undefined) return null;
  return statusOf(metric, cellToSI(metric, n, display), grading);
}
