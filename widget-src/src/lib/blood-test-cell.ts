// Pure helpers shared by BloodTestTimeline's live matrix and the lab-upload
// review matrix. Anything that touches React state stays in the consuming
// components; everything here is data → data.

import {
  parseLocalisedNumber,
  toCanonicalValue,
  getDisplayLabel,
  getDisplayRange,
  HBA1C_THRESHOLDS,
  LDL_THRESHOLDS,
  TOTAL_CHOLESTEROL_THRESHOLDS,
  HDL_THRESHOLDS,
  TRIGLYCERIDES_THRESHOLDS,
  APOB_THRESHOLDS,
  LPA_THRESHOLDS,
  PSA_THRESHOLDS,
  type MetricType,
  type UnitSystem,
} from '@roadmap/health-core';

import type React from 'react';

export type Status = 'ok' | 'warn' | 'bad' | null;

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

/** Validate a typed display-unit value against the metric's range. */
export function validateTypedValue(
  metric: MetricType,
  typed: string,
  display: UnitSystem,
): { error: string | null; range: { min: number; max: number } } {
  const range = getDisplayRange(metric, display);
  if (typed === '') return { error: null, range };
  const n = parseLocalisedNumber(typed);
  if (n === undefined) return { error: 'Enter a number', range };
  // Include the display unit in min/max errors so a user who typed (e.g.)
  // a mg/dL number into an mmol/L field can see the unit mismatch instead
  // of a bare "Max 22.6".
  const unit = getDisplayLabel(metric, display);
  if (n < range.min) return { error: `Min ${range.min} ${unit}`, range };
  if (n > range.max) return { error: `Max ${range.max} ${unit}`, range };
  return { error: null, range };
}

/** Clinical threshold mapping. Returns null for metrics whose status is
 *  judged elsewhere (e.g. creatinine → eGFR). */
export function statusOf(metric: MetricType, siValue: number, sex?: 'male' | 'female'): Status {
  if (siValue == null || Number.isNaN(siValue)) return null;
  switch (metric) {
    case 'hba1c':
      if (siValue >= HBA1C_THRESHOLDS.diabetes) return 'bad';
      if (siValue >= HBA1C_THRESHOLDS.prediabetes) return 'warn';
      return 'ok';
    case 'ldl':
      if (siValue >= LDL_THRESHOLDS.high) return 'bad';
      if (siValue >= LDL_THRESHOLDS.borderline) return 'warn';
      return 'ok';
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
  metric: MetricType, typed: string, display: UnitSystem, sex?: 'male' | 'female',
): Status {
  const n = parseLocalisedNumber(typed);
  if (n === undefined) return null;
  return statusOf(metric, toCanonicalValue(metric, n, display), sex);
}
