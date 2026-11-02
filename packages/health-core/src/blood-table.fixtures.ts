/**
 * Test-only: the records US-66 AC7's golden test plans before and after the
 * move. Each holds core tests in `measurements` and no old core-named lab row,
 * so the move must leave the plan, the reminder dates and every tile alone.
 * Synthetic data only.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
// @ts-expect-error: a plain .mjs module shared with the iPhone engine's parity tests.
import { parityFixtures } from '../../../ios/engine/fixtures.mjs';
import { migrateFile } from './migrate';
import { computePlan, planPayload } from './plan';
import { computeReminderSchedule } from './reminder-schedule';
import { createEmptyFile, createLabValue, createMeasurement, type RoadmapFile } from './roadmap-file';

/** The clock every golden run uses. */
export const GOLDEN_NOW = new Date('2026-10-01T12:00:00Z');

const SAMPLE = resolve(__dirname, '../../../docs/examples/health-roadmap.sample.json');

/** A record touching every blood-test reader: all nine tests, corrections, a quarantined id, a lab eGFR and a vital. */
function handBuilt(): RoadmapFile {
  const file = createEmptyFile({ deviceId: 'golden', now: '2026-09-01T00:00:00Z' });
  file.profile = { ...file.profile, sex: 'male', birthYear: 1965, birthMonth: 3, heightCm: 180, unitSystem: 'conventional', lpaUnit: 'mg/dL' };
  const m = (id: string, metricType: string, value: number, recordedAt: string, extra: object = {}) =>
    createMeasurement({ id, metricType, value, recordedAt, createdAt: `${recordedAt}T08:00:00Z`, ...extra });
  file.measurements = [
    m('w1', 'weight', 88, '2026-08-01'),
    m('wa1', 'waist', 98, '2026-08-01'),
    m('s1', 'systolic_bp', 138, '2026-08-01'),
    m('d1', 'diastolic_bp', 86, '2026-08-01'),
    m('ldl-old', 'ldl', 4.1, '2025-06-01'),
    m('ldl-1', 'ldl', 3.6, '2026-03-01', { status: 'entered-in-error' }),
    m('ldl-1-fix', 'ldl', 3.4, '2026-03-01', { source: 'manual_correction', correctsId: 'ldl-1', createdAt: '2026-03-02T08:00:00Z' }),
    m('tc', 'total_cholesterol', 5.9, '2026-03-01'),
    m('hdl', 'hdl', 1.0, '2026-03-01'),
    m('tg', 'triglycerides', 2.1, '2026-03-01'),
    m('a1c', 'hba1c', 44, '2026-03-01'),
    m('apob', 'apob', 1.2, '2026-03-01'),
    m('cr', 'creatinine', 95, '2026-03-01'),
    m('psa', 'psa', 1.4, '2025-11-01'),
    m('lpa', 'lpa', 180, '2024-01-01'),
    // A quarantined copy: the same id reused for another value on another day.
    m('a1c-dup#dup-0a1b2c3d', 'hba1c', 41, '2025-09-01'),
    m('a1c-dup', 'hba1c', 40, '2025-03-01'),
  ];
  file.labValues = [
    createLabValue({ id: 'egfr', metricName: 'egfr', value: 74, unit: 'mL/min/1.73m²', recordedAt: '2026-02-01', createdAt: '2026-02-01T08:00:00Z' }),
    createLabValue({ id: 'fer', metricName: 'ferritin', value: 120, unit: 'µg/L', referenceLow: 30, referenceHigh: 400, recordedAt: '2026-03-01', createdAt: '2026-03-01T08:00:00Z' }),
  ];
  file.medications = [{ id: 'med', medicationKey: 'statin', drugName: 'atorvastatin', doseValue: 20, doseUnit: 'mg', updatedAt: '2026-01-01T00:00:00Z', lamport: 1 }];
  return file;
}

/** name → raw record, as a file on disk would hold it. */
export function goldenRecords(): Record<string, unknown> {
  const sample = JSON.parse(readFileSync(SAMPLE, 'utf8'));
  return { ...parityFixtures(sample), 'hand-built': JSON.parse(JSON.stringify(handBuilt())) };
}

/** What the golden test compares: the plan payload (or its refusal) and the reminder dates. */
export function goldenOf(raw: unknown): unknown {
  const file = migrateFile(raw, { deviceId: 'golden', now: GOLDEN_NOW.toISOString() });
  let plan: unknown;
  try {
    plan = planPayload(computePlan(file, GOLDEN_NOW));
  } catch (error) {
    plan = { error: (error as Error).message };
  }
  return { plan, due: computeReminderSchedule(file, GOLDEN_NOW) };
}
