// The blood pressure widget (US-75): what a typed reading is, the average, the
// plan's own card for it and the save. Every rule is the full app's: the
// vitals grid's reading of a typed half (blood-test-cell.ts), the pair rule
// (US-02 AC8), the tiers (health-core bp-tier.ts), the plan engine
// (computePlan) and the day-value save (saveTasksToStore). This file only
// joins them for two readings.
import { bpTier, type BpTier } from '@roadmap/health-core/bp-tier';
import { dayOf, localDay } from '@roadmap/health-core/merge';
import { PlanError, computePlan } from '@roadmap/health-core/plan';
import type { FileMeasurement } from '@roadmap/health-core/roadmap-file';
import type { Suggestion } from '@roadmap/health-core/types';
import { pressureInverted } from '@roadmap/health-core/validation';
import { saveTasksToStore } from '../hooks/useLongitudinalSave';
import { readTypedValue, validateTypedValue } from '../lib/blood-test-cell';
import { activeRowIndex, slotOf } from '../lib/matrix-save';
import { ensureIsoDatetime } from '../lib/recordedAt';
import {
  correctValue, countMeasuresAdded, currentSaveStatus, flushRoadmapStore, getBackendKind, getShownErase,
  loadAllHistorySync, loadLatestMeasurementsSync, recordFileSync,
} from '../lib/roadmap-data';
import { healthWritesAllowed } from '../lib/storage';

export interface Pair { sys: number; dia: number }
/** A reading's two boxes as typed. */
export interface Typed { sys: string; dia: string }
/** A reading: blank, one half only, wrong (a half unreadable or out of range, or the pair the wrong way up), or a pair. */
export type Reading = { kind: 'blank' } | { kind: 'half' } | { kind: 'error' } | { kind: 'pair'; pair: Pair };

const METRIC = { sys: 'systolic_bp', dia: 'diastolic_bp' } as const;
/** The plan's three tier cards (algorithm § Blood Pressure Tiers). */
const TIER_CARDS = new Set(['bp-crisis', 'bp-stage2', 'bp-stage1']);

/** A typed reading, each half read as the vitals grid reads a typed cell (US-75 AC2). */
export function readReading(typed: Typed): Reading {
  const half = (h: 'sys' | 'dia'): number | null | undefined => {
    const text = typed[h];
    if (text === '') return undefined;
    return validateTypedValue(METRIC[h], text, 'si').error ? null : readTypedValue(METRIC[h], text, 'si');
  };
  const sys = half('sys'), dia = half('dia');
  if (sys === undefined && dia === undefined) return { kind: 'blank' };
  if (sys === null || dia === null) return { kind: 'error' };
  if (sys === undefined || dia === undefined) return { kind: 'half' };
  return pressureInverted(sys, dia) ? { kind: 'error' } : { kind: 'pair', pair: { sys, dia } };
}

/** The average of the pairs, each half rounded to a whole mmHg (US-75 AC4). */
export function averageOf(pairs: readonly Pair[]): Pair {
  const mean = (h: keyof Pair) => Math.round(pairs.reduce((sum, p) => sum + p[h], 0) / pairs.length);
  return { sys: mean('sys'), dia: mean('dia') };
}

/** The record's latest pair, a systolic and a diastolic from the same day, with that day (US-75 AC3). */
export function recordPair(): { pair: Pair; day: string } | null {
  const latest = loadLatestMeasurementsSync()?.previousMeasurements ?? [];
  const sys = latest.find((m) => m.metricType === METRIC.sys), dia = latest.find((m) => m.metricType === METRIC.dia);
  if (!sys || !dia || dayOf(sys.recordedAt) !== dayOf(dia.recordedAt)) return null;
  return { pair: { sys: sys.value, dia: dia.value }, day: dayOf(sys.recordedAt) };
}

export interface Result { pair: Pair; tier: BpTier; card: Suggestion | null }

/** The average's tier, and the card the full roadmap would show once it is today's pair: the plan
 *  engine over the record with today's blood pressure replaced by it, text unchanged (US-75 AC4).
 *  No card when the record has no usable height: the plan engine makes no plan without one. */
export function resultFor(pair: Pair, now = new Date()): Result {
  return { pair, tier: bpTier(pair.sys, pair.dia), card: planCard(pair, now) };
}

function planCard(pair: Pair, now: Date): Suggestion | null {
  const file = recordFileSync();
  if (!file) return null;
  const today = localDay(now), stamp = now.toISOString();
  // The record as it will be once this pair is saved: today's rows corrected, as the save corrects them.
  const measurements: FileMeasurement[] = file.measurements.map((m) =>
    m.status === 'active' && (m.metricType === METRIC.sys || m.metricType === METRIC.dia) && dayOf(m.recordedAt) === today ? { ...m, status: 'entered-in-error' } : m);
  for (const h of ['sys', 'dia'] as const) {
    measurements.push({ id: `typed-${h}`, metricType: METRIC[h], value: pair[h], recordedAt: ensureIsoDatetime(today), createdAt: stamp, source: 'manual', status: 'active', correctsId: null, externalId: null });
  }
  try {
    return computePlan({ ...file, measurements }, now).results.suggestions.find((s) => TIER_CARDS.has(s.id)) ?? null;
  } catch (error) {
    if (error instanceof PlanError) return null;
    throw error;
  }
}

/** Today's active blood pressure rows: what a save may replace (US-75 AC5). */
export interface SeenRows { day: string; sys: string | null; dia: string | null }
export function seenToday(now = new Date()): SeenRows {
  const index = activeRowIndex(loadAllHistorySync()), day = localDay(now);
  return { day, sys: index.get(slotOf(day, METRIC.sys))?.id ?? null, dia: index.get(slotOf(day, METRIC.dia))?.id ?? null };
}

/**
 * Save the average as today's pair through the full app's day-value save (US-75 AC5): one task with
 * both halves, so the pair is never the wrong way up mid-write; a later save the same day corrects
 * today's rows. It replaces only the rows in `seen` (rows seen on another day: none of today's).
 * True once the store has kept it (or its device copy, the store's documented fallback).
 */
export async function savePair(pair: Pair, seen: SeenRows): Promise<boolean> {
  if (getBackendKind() === 'local' && !healthWritesAllowed()) return false;
  const today = localDay(new Date());
  const same = seen.day === today;
  const before = new Set(loadAllHistorySync().map((r) => r.id));
  // Not counted as added here: only once the store has kept the rows (US-74 review C8).
  const refused = await saveTasksToStore([{
    date: today, values: { [METRIC.sys]: pair.sys, [METRIC.dia]: pair.dia },
    expected: { [METRIC.sys]: same ? seen.sys : null, [METRIC.dia]: same ? seen.dia : null }, unit: 'si',
  }], getShownErase(), correctValue, false);
  try {
    await flushRoadmapStore();
  } catch {
    if (currentSaveStatus() !== 'not-saved-on-device') return false;
  }
  // The full app's counter for a prompted measure added: rows inserted, not corrections.
  countMeasuresAdded(loadAllHistorySync().filter((r) => !before.has(r.id) && !r.correctsId && (r.metricType === METRIC.sys || r.metricType === METRIC.dia)));
  return refused.size === 0;
}
