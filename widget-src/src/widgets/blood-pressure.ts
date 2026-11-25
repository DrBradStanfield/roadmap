// The blood pressure widget (US-75): what a typed reading is, the average, the
// result shown for it and the save. Every rule is the full app's: the vitals
// grid's reading of a typed half (blood-test-cell.ts), the pair rule (US-02
// AC8), the tiers (health-core bp-tier.ts), the plan engine (computePlan over
// the readable record, else the engine's own cards for the pair alone), the
// known-minor rule (US-07 AC6) and the record's batch write (bulkAppendValues).
// This file only joins them for two readings.
import { bpTier, type BpTier } from '@roadmap/health-core/bp-tier';
import { isActive } from '@roadmap/health-core/blood-tests';
import { calculateHealthResults } from '@roadmap/health-core/calculations';
import { dayOf, localDay } from '@roadmap/health-core/merge';
import { PlanError, computePlan } from '@roadmap/health-core/plan';
import { bulkAppendValues, slotIndex, slotKey } from '@roadmap/health-core/record-edits';
import type { FileMeasurement } from '@roadmap/health-core/roadmap-file';
import type { Suggestion, SuggestionInputs } from '@roadmap/health-core/types';
import { pressureInverted } from '@roadmap/health-core/validation';
import { readTypedValue, validateTypedValue } from '../lib/blood-test-cell';
import { ensureIsoDatetime } from '../lib/recordedAt';
import {
  bulkSaveMeasurements, currentSaveStatus, flushRoadmapStore, getBackendKind, isKnownMinorNow, readableRecordSync, recordFileSync,
} from '../lib/roadmap-data';
import { healthWritesAllowed } from '../lib/storage';

export interface Pair { sys: number; dia: number }
/** A reading's two boxes as typed. */
export interface Typed { sys: string; dia: string }
/** A reading: blank, one half only, wrong (a half unreadable or out of range, or the pair the wrong way up), or a pair. */
export type Reading = { kind: 'blank' } | { kind: 'half' } | { kind: 'error' } | { kind: 'pair'; pair: Pair };
/** Each half's row: its id, or null for an empty slot. */
export interface Ids { sys: string | null; dia: string | null }

const METRIC = { sys: 'systolic_bp', dia: 'diastolic_bp' } as const;
const HALVES = ['sys', 'dia'] as const;
/** The plan's three tier cards (algorithm § Blood Pressure Tiers). */
const TIER_CARD: Partial<Record<BpTier, string>> = { crisis: 'bp-crisis', stage2: 'bp-stage2', stage1: 'bp-stage1' };

/** One page view, however many blood pressure blocks it holds (as US-74's pageView): each event once per view. */
export const bpPageView = { mounted: 0, savedCounted: false };

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

/** The average of the pairs, each half rounded to a whole mmHg, halves up (US-75 AC4). */
export function averageOf(pairs: readonly Pair[]): Pair {
  const mean = (h: keyof Pair) => Math.round(pairs.reduce((sum, p) => sum + p[h], 0) / pairs.length);
  return { sys: mean('sys'), dia: mean('dia') };
}

/** The record's latest pair (US-75 AC3): the newest day holding both an active systolic and an active
 *  diastolic in the readable record, with that day and the two rows shown. */
export function recordPair(): { pair: Pair; day: string; ids: Ids } | null {
  const file = readableRecordSync();
  if (!file) return null;
  const byDay = new Map<string, Partial<Record<'sys' | 'dia', FileMeasurement>>>();
  for (const m of file.measurements) {
    const h = HALVES.find((x) => METRIC[x] === m.metricType);
    if (!h || !isActive(m)) continue;
    const day = byDay.get(dayOf(m.recordedAt)) ?? {};
    // One active row per slot; should a record hold two, the later-created one.
    if (!day[h] || m.createdAt > day[h]!.createdAt) day[h] = m;
    byDay.set(dayOf(m.recordedAt), day);
  }
  const days = [...byDay].filter(([, d]) => d.sys && d.dia).sort(([a], [b]) => (a < b ? 1 : -1));
  if (days.length === 0) return null;
  const [day, { sys, dia }] = days[0];
  return { pair: { sys: sys!.value, dia: dia!.value }, day, ids: { sys: sys!.id, dia: dia!.id } };
}

/** What the checker shows: the average, the stage (null for a known minor), and the card for it. */
export interface Result { pair: Pair; tier: BpTier | null; card: Suggestion | null }

/**
 * The result for the readings (US-75 AC4). A known minor gets no adult stage or card (US-07 AC6). Any one
 * reading at crisis level makes the result crisis, whatever the average, with the crisis card for that
 * reading (clinical ruling C1, 2026-11-18). The card is the full roadmap's: the plan engine over the
 * readable record with today's blood pressure replaced; with no plan (no record or no usable height), the
 * engine's own card for the pair alone, with no age, so its wording names no medicine (ruling C2).
 */
export function resultFor(pairs: readonly Pair[], now = new Date()): Result {
  const pair = averageOf(pairs);
  if (isKnownMinorNow()) return { pair, tier: null, card: null };
  const crisis = pairs.find((p) => bpTier(p.sys, p.dia) === 'crisis');
  const tier = crisis ? 'crisis' : bpTier(pair.sys, pair.dia);
  const id = TIER_CARD[tier];
  if (!id) return { pair, tier, card: null };
  const cardPair = crisis ?? pair;
  const card = (planSuggestions(cardPair, now) ?? pairSuggestions(cardPair)).find((s) => s.id === id) ?? null;
  return { pair, tier, card };
}

/** The plan's cards with `pair` as the blood pressure: every saved pair set aside, whatever its day (a later-dated
 *  one from another timezone included), so the typed pair is the plan's only one (Codex 1876b R1); the record's
 *  other inputs stay. Null with no plan. */
function planSuggestions(pair: Pair, now: Date): Suggestion[] | null {
  const file = readableRecordSync();
  if (!file) return null;
  const today = localDay(now), stamp = now.toISOString();
  const measurements: FileMeasurement[] = file.measurements.map((m) =>
    isActive(m) && (m.metricType === METRIC.sys || m.metricType === METRIC.dia) ? { ...m, status: 'entered-in-error' } : m);
  for (const h of HALVES) {
    measurements.push({ id: `typed-${h}`, metricType: METRIC[h], value: pair[h], recordedAt: ensureIsoDatetime(today), createdAt: stamp, source: 'manual', status: 'active', correctsId: null, externalId: null });
  }
  try {
    return computePlan({ ...file, measurements }, now).results.suggestions;
  } catch (error) {
    if (error instanceof PlanError) return null;
    throw error;
  }
}

/** The engine's cards for the pair alone (ruling C2): no height, age or other input, so none of the sentences that need one. */
function pairSuggestions(pair: Pair): Suggestion[] {
  return calculateHealthResults({ systolicBp: pair.sys, diastolicBp: pair.dia } as SuggestionInputs).suggestions;
}

/** A day's rows in the record as written, unreadable ones included: what a write on that day meets. */
export function rowsOn(day: string): Ids {
  const file = recordFileSync();
  if (!file) return { sys: null, dia: null };
  const index = slotIndex(file);
  const at = (h: 'sys' | 'dia') => index.get(slotKey('measurement', METRIC[h], day))?.id ?? null;
  return { sys: at('sys'), dia: at('dia') };
}

/** The widget's saves (AC5, AC8): each edit is numbered; `kept` is the newest the store kept, `dropped` the newest
 *  whose save met a changed row or a newer erase, so it and every save asked before it go. While typing waits on
 *  neither, it holds the erase the page showed at its first keystroke: its saves write under that erase or not at all. */
export type Saves = { edits: number; kept: number; dropped: number } & ({ kind: 'settled' } | { kind: 'typing'; erase: string });
export type SaveEvent = { type: 'typed'; erase: string } | { type: 'kept'; seq: number } | { type: 'dropped'; seq: number };
export const NO_SAVES: Saves = { kind: 'settled', edits: 0, kept: 0, dropped: 0 };

export function transition(s: Saves, e: SaveEvent): Saves {
  if (e.type === 'typed') return { edits: s.edits + 1, kept: s.kept, dropped: s.dropped, kind: 'typing', erase: s.kind === 'typing' ? s.erase : e.erase };
  const counts = { edits: s.edits, kept: e.type === 'kept' ? Math.max(s.kept, e.seq) : s.kept, dropped: e.type === 'dropped' ? Math.max(s.dropped, e.seq) : s.dropped };
  return s.kind === 'typing' && counts.edits > Math.max(counts.kept, counts.dropped) ? { ...counts, kind: 'typing', erase: s.erase } : { ...counts, kind: 'settled' };
}

/** How a save ended: kept (with the rows now holding the pair), a slot changed since the page showed it, or
 *  not kept. A write the store took but could not yet keep names its rows: they are this page's own, and the
 *  next save, which retries the flush, expects them. */
export type SaveOutcome = { kind: 'kept'; ids: Ids } | { kind: 'changed' } | { kind: 'failed'; ids?: Ids };

/**
 * Save `pair` as `day`'s blood pressure (US-75 AC5), replacing only the rows `expected` names (null: an
 * empty slot). Both halves or neither: the batch is first run on the record as written, unreadable rows
 * included, and written only if every half would land, in the same turn, so nothing changes between.
 * A half the record already holds exactly is not written again: compared exactly, never by display.
 * `erase`: the erase the page showed as the reading was typed (AC8); a record at another one takes nothing (US-16 AC2a).
 */
export async function savePair(pair: Pair, day: string, expected: Ids, erase: string): Promise<SaveOutcome> {
  if (getBackendKind() === 'local' && !healthWritesAllowed()) return { kind: 'failed' };
  const file = recordFileSync();
  if (!file) return { kind: 'failed' };
  const held = rowsOn(day);
  if (HALVES.some((h) => held[h] !== expected[h])) return { kind: 'changed' };
  const index = slotIndex(file);
  const value = (h: 'sys' | 'dia') => index.get(slotKey('measurement', METRIC[h], day))?.value;
  const at = ensureIsoDatetime(day);
  const rows = HALVES.filter((h) => value(h) !== pair[h]).map((h) => ({
    metricType: METRIC[h], value: pair[h], recordedAt: at, source: 'manual' as const, ...(expected[h] ? { correctsId: expected[h]! } : {}),
  }));
  if (rows.length > 0) {
    // The record's own batch rule, tried first on the same file the store writes next, with no await between.
    if (bulkAppendValues(file, rows.map((r) => ({ kind: 'measurement' as const, ...r })), new Date().toISOString()).saved.length !== rows.length) return { kind: 'changed' };
    const written = bulkSaveMeasurements(rows, erase);
    if ((await written).saved.length !== rows.length) return { kind: 'changed' };
  }
  try {
    await flushRoadmapStore();
  } catch {
    // A cloud save that failed but reached this device's copy is the store's documented fallback.
    if (currentSaveStatus() !== 'not-saved-on-device') return { kind: 'failed', ids: rowsOn(day) };
  }
  return { kind: 'kept', ids: rowsOn(day) };
}
