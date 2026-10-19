// Pure helpers shared by BloodTestTimeline's live matrix and the lab-upload
// review matrix. Anything that touches React state stays in the consuming
// components; everything here is data → data.

import {
  parseLocalisedNumber,
  toCanonicalValue,
  fromCanonicalValue,
  formatDisplayValue,
  reportedToCanonical,
  canonicalToReported,
  lookupUnit,
  unitDecimalPlaces,
  UNIT_DEFS,
  getDisplayLabel,
  getDisplayRange,
  refHintFor,
  lpaRefHint,
  HBA1C_THRESHOLDS,
  LDL_THRESHOLDS,
  getLipidStatus,
  TOTAL_CHOLESTEROL_THRESHOLDS,
  HDL_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  APOB_THRESHOLDS,
  LPA_THRESHOLDS,
  PSA_THRESHOLDS,
  type LpaUnit,
  type MetricType,
  type UnitSystem,
} from '@roadmap/health-core';

import type React from 'react';

export type Status = 'ok' | 'warn' | 'bad' | null;

/** Whom a value is graded for against adult thresholds: their sex (some lines
 *  differ by it), or null to grade nothing, as for a known minor (US-07 AC6). */
export type Grading = { sex?: 'male' | 'female' } | null;

/** The unit a core cell is typed and shown in: one of its metric's two
 *  systems, or, for Lp(a), one of the three units its field takes (US-05
 *  AC2), read through the unit table (mg/L is a tenth of mg/dL). */
export type CellUnit = UnitSystem | LpaUnit;

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

/** The reference hint under the unit: the metric's, or Lp(a)'s in its unit. */
export function cellHint(metric: MetricType, unit: CellUnit, grading: Grading): string | null {
  if (!grading) return null;
  return isSystem(unit) ? refHintFor(metric, unit, grading.sex) : lpaRefHint(unit);
}

/** The range a value typed in `unit` must fall in: the system's, or the
 *  canonical range in that Lp(a) unit (0–3000 mg/L). */
function cellRange(metric: MetricType, unit: CellUnit): { min: number; max: number } {
  if (isSystem(unit)) return getDisplayRange(metric, unit);
  const { min, max } = UNIT_DEFS[metric].validationRange.si; // Lp(a)'s canonical unit is its SI one
  return { min: cellFromSI(metric, min, unit), max: cellFromSI(metric, max, unit) };
}

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

/** Validate a typed display-unit value against the metric's range. */
export function validateTypedValue(
  metric: MetricType,
  typed: string,
  display: CellUnit,
): { error: string | null; range: { min: number; max: number } } {
  const range = cellRange(metric, display);
  if (typed === '') return { error: null, range };
  const n = parseLocalisedNumber(typed);
  if (n === undefined) return { error: 'Enter a number', range };
  // Include the display unit in min/max errors so a user who typed (e.g.)
  // a mg/dL number into an mmol/L field can see the unit mismatch instead
  // of a bare "Max 22.6".
  const unit = cellLabel(metric, display);
  if (n < range.min) return { error: `Min ${range.min} ${unit}`, range };
  if (n > range.max) return { error: `Max ${range.max} ${unit}`, range };
  return { error: null, range };
}

/** Clinical threshold mapping. Returns null for metrics whose status is
 *  judged elsewhere (e.g. creatinine → eGFR). */
export function statusOf(metric: MetricType, siValue: number, grading: Grading): Status {
  if (!grading || siValue == null || Number.isNaN(siValue)) return null;
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
      // Higher is better. lowFemale (~1.29) is the more conservative "ok"
      // gate. Below lowMale (~1.03) = bad. Between = warn.
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
      const max = sex === 'female' ? 90 : 110; // µmol/L
      if (siValue >= max * 1.3) return 'bad';
      if (siValue > max) return 'warn';
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
  const n = parseLocalisedNumber(typed);
  if (n === undefined) return null;
  return statusOf(metric, cellToSI(metric, n, display), grading);
}
