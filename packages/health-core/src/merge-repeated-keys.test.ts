/**
 * US-10 AC15: when one copy holds several rows for the same key, the merge
 * keeps the latest by clock, whichever side is merged first. The rule is the
 * one the merge uses across copies (time, then lamport, then the row's
 * content), applied the same way within a copy. Covers every keyed list the
 * merge keeps one row per key for: medications, supplements, reminder
 * preferences, and the recommendation snapshots (one per date, the richer wins).
 */
import { describe, it, expect } from 'vitest';
import { mergeFiles } from './merge';
import { clockOf, cmpClock } from './record-time';
import {
  createEmptyFile,
  stableStringify,
  type FileMedication,
  type FileReminderPreference,
  type FileSupplement,
  type RecommendationSnapshot,
  type RoadmapFile,
} from './roadmap-file';
import type { Suggestion } from './types';

const OPTS = { deviceId: 'dev_merge', now: '2026-05-01T12:00:00Z' };

function file(): RoadmapFile {
  return createEmptyFile({ deviceId: 'dev_base', now: '2026-01-01T00:00:00Z' });
}

function med(id: string, drugName: string, updatedAt: string, lamport?: number): FileMedication {
  return {
    id, medicationKey: 'statin', drugName, doseValue: null, doseUnit: null, updatedAt,
    ...(lamport === undefined ? null : { lamport }),
  };
}

describe('US-10 AC15: the latest row by clock wins among rows that share a key in one copy', () => {
  it('a copy holding two rows for one medication keeps the later one, in both merge orders', () => {
    const later = med('m1', 'rosuvastatin', '2026-05-01T08:00:00Z', 1);
    const earlier = med('m2', 'atorvastatin', '2026-05-01T07:00:00Z', 1);
    for (const rows of [[later, earlier], [earlier, later]]) {
      const a = file();
      a.medications = rows;
      for (const merged of [mergeFiles(a, file(), OPTS), mergeFiles(file(), a, OPTS)]) {
        expect(merged.medications).toEqual([later]);
      }
    }
  });

  it('on one time, the higher lamport wins; on one clock, the same row wins in either order', () => {
    const low = med('m1', 'a', '2026-05-01T08:00:00Z', 1);
    const high = med('m2', 'b', '2026-05-01T08:00:00Z', 2);
    const tieA = med('m3', 'c', '2026-05-01T09:00:00Z', 0);
    const tieB = med('m4', 'd', '2026-05-01T09:00:00Z', 0);
    const winners = new Set<string>();
    for (const rows of [[low, high], [high, low]]) {
      const a = file();
      a.medications = rows;
      for (const merged of [mergeFiles(a, file(), OPTS), mergeFiles(file(), a, OPTS)]) {
        expect(merged.medications).toEqual([high]);
      }
    }
    for (const rows of [[tieA, tieB], [tieB, tieA]]) {
      const a = file();
      a.medications = rows;
      for (const merged of [mergeFiles(a, file(), OPTS), mergeFiles(file(), a, OPTS)]) {
        winners.add(merged.medications[0].id);
      }
    }
    expect(winners.size).toBe(1);
  });
});

describe('US-10 AC15: across the erase gate, with nothing rescued, the winning copy also keeps one row per key', () => {
  const later = med('m1', 'rosuvastatin', '2026-05-01T08:00:00Z', 1);
  const earlier = med('m2', 'atorvastatin', '2026-05-01T07:00:00Z', 1);
  const supp = (id: string, updatedAt: string): FileSupplement => ({
    id, supplementKey: 'omega3', supplementName: id, doseValue: 1, doseUnit: 'g', status: 'active', startedAt: '2026-01-01', updatedAt,
  });
  const pref = (enabled: boolean, updatedAt: string): FileReminderPreference => ({ category: 'blood_test', enabled, updatedAt });
  const snap = (n: number): RecommendationSnapshot => ({
    date: '2026-05-01', suggestions: Array.from({ length: n }, () => ({ id: 's1' }) as unknown as Suggestion),
  });
  /** A copy past one more erase than `loser`, holding two rows for every key. */
  function erasedWinner(): RoadmapFile {
    const w = file();
    w.meta.eraseEpoch = 1;
    w.medications = [earlier, later];
    w.supplements = [supp('s_new', '2026-05-01T08:00:00Z'), supp('s_old', '2026-05-01T07:00:00Z')];
    w.reminderPreferences = [pref(false, '2026-05-01T07:00:00Z'), pref(true, '2026-05-01T08:00:00Z')];
    w.recommendationSnapshots = [snap(2), snap(1)];
    return w;
  }
  const loser = () => ({ ...file(), medications: [med('m9', 'simvastatin', '2026-05-02T00:00:00Z', 9)] });

  it('keeps the latest by clock for each key, in both merge orders', () => {
    for (const merged of [mergeFiles(erasedWinner(), loser(), OPTS), mergeFiles(loser(), erasedWinner(), OPTS)]) {
      expect(merged.meta.eraseEpoch).toBe(1);
      expect(merged.medications).toEqual([later]);
      expect(merged.supplements.map((s) => s.id)).toEqual(['s_new']);
      expect(merged.reminderPreferences.map((p) => p.enabled)).toEqual([true]);
      expect(merged.recommendationSnapshots.map((s) => s.suggestions.length)).toEqual([2]);
    }
    expect(keyed(mergeFiles(erasedWinner(), loser(), OPTS))).toBe(keyed(mergeFiles(loser(), erasedWinner(), OPTS)));
  });

  it('is idempotent: the result merged with itself changes nothing more', () => {
    const once = mergeFiles(erasedWinner(), loser(), OPTS);
    expect(keyed(mergeFiles(once, once, OPTS))).toBe(keyed(once));
  });

  it('a winner with unique keys, in key order as every merge writes them, comes out as it went in', () => {
    const w = file();
    w.meta.eraseEpoch = 1;
    w.medications = [{ ...earlier, medicationKey: 'ezetimibe' }, later];
    w.supplements = [supp('s_new', '2026-05-01T08:00:00Z')];
    w.reminderPreferences = [{ ...pref(true, '2026-05-01T08:00:00Z'), category: 'blood_pressure' }, pref(true, '2026-05-01T08:00:00Z')];
    w.recommendationSnapshots = [snap(2), { ...snap(1), date: '2026-05-02' }];
    for (const merged of [mergeFiles(w, loser(), OPTS), mergeFiles(loser(), w, OPTS)]) {
      expect(keyed(merged)).toBe(keyed(w));
    }
  });
});

/** mulberry32: a small seeded generator, so every run draws the same records. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Spellings the clock order reads, an unknown time and one that does not parse.
const STAMPS = [
  '2026-05-01T08:00:00Z', '2026-05-01T08:00:00.000Z', '2026-05-01T20:00:00+12:00',
  '2026-05-01T07:00:00Z', '2026-05-02', '', 'not a stamp',
];

function keyedFile(r: () => number, side: string): RoadmapFile {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const n = (max: number) => Math.floor(r() * (max + 1));
  const stamp = () => ({ updatedAt: pick(STAMPS), ...(r() < 0.8 ? { lamport: n(2) } : null) });
  const f = file();
  f.meta.lastDeviceId = `dev_${side}`;
  // Copies past different erases meet at the gate; none lists ids or keeps an
  // erase time, so the higher epoch's copy wins whole.
  f.meta.eraseEpoch = pick([0, 0, 1]);
  f.medications = Array.from({ length: n(4) }, (): FileMedication => ({
    id: `m_${n(3)}`, medicationKey: pick(['statin', 'ezetimibe']), drugName: pick(['a', 'b']),
    doseValue: n(2), doseUnit: 'mg', ...stamp(),
  }));
  f.supplements = Array.from({ length: n(4) }, (): FileSupplement => ({
    id: `s_${n(3)}`, supplementKey: pick(['omega3', 'creatine']), supplementName: pick(['x', 'y']),
    doseValue: n(2), doseUnit: 'g', status: pick(['active', 'stopped'] as const), startedAt: '2026-01-01', ...stamp(),
  }));
  f.reminderPreferences = Array.from({ length: n(4) }, (): FileReminderPreference => ({
    category: pick(['blood_test', 'blood_pressure']), enabled: r() < 0.5, ...stamp(),
  }));
  f.recommendationSnapshots = Array.from({ length: n(4) }, (): RecommendationSnapshot => ({
    date: pick(['2026-05-01', '2026-05-02']),
    suggestions: Array.from({ length: n(2) }, () => ({ id: pick(['s1', 's2']) }) as unknown as Suggestion),
  }));
  return f;
}

/** The keyed lists, as the merge returns them. */
function keyed(f: RoadmapFile): string {
  return stableStringify({
    medications: f.medications,
    supplements: f.supplements,
    reminderPreferences: f.reminderPreferences,
    recommendationSnapshots: f.recommendationSnapshots,
  }) ?? '';
}

/** The latest row by clock for each key, then the content: worked out here, not by the merge. */
function latestByKey<T extends { updatedAt: string; lamport?: number }>(rows: T[], keyOf: (row: T) => string): T[] {
  const best = new Map<string, T>();
  for (const row of rows) {
    const held = best.get(keyOf(row));
    const order = held ? cmpClock(clockOf(row), clockOf(held)) : 1;
    if (order > 0 || (order === 0 && held && (stableStringify(row) ?? '') > (stableStringify(held) ?? ''))) best.set(keyOf(row), row);
  }
  return [...best.values()].sort((x, y) => (keyOf(x) < keyOf(y) ? -1 : 1));
}

function shuffled<T>(xs: T[], r: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

describe('US-10 AC15: the keyed lists merge as a join, repeated keys included (500 seeds)', () => {
  const SEEDS = 500;
  const triples = Array.from({ length: SEEDS }, (_, i) => {
    const r = rng(i + 1);
    return { r, a: keyedFile(r, 'a'), b: keyedFile(r, 'b'), c: keyedFile(r, 'c') };
  });

  it('is commutative', () => {
    for (const { a, b } of triples) expect(keyed(mergeFiles(a, b, OPTS))).toBe(keyed(mergeFiles(b, a, OPTS)));
  });

  it('is associative', () => {
    for (const { a, b, c } of triples) {
      expect(keyed(mergeFiles(mergeFiles(a, b, OPTS), c, OPTS))).toBe(keyed(mergeFiles(a, mergeFiles(b, c, OPTS), OPTS)));
    }
  });

  it('is idempotent: a copy merged with itself, or a merge merged again, changes nothing more', () => {
    for (const { a, b } of triples) {
      const once = mergeFiles(a, a, OPTS);
      expect(keyed(mergeFiles(once, a, OPTS))).toBe(keyed(once));
      const m = mergeFiles(a, b, OPTS);
      expect(keyed(mergeFiles(m, m, OPTS))).toBe(keyed(m));
    }
  });

  it('keeps the latest row by clock for each key, whatever the row order or the side', () => {
    for (const { r, a, b } of triples) {
      const a2 = { ...a, medications: shuffled(a.medications, r), supplements: shuffled(a.supplements, r), reminderPreferences: shuffled(a.reminderPreferences, r) };
      const all = (f: RoadmapFile, g: RoadmapFile) => ({
        medications: latestByKey([...f.medications, ...g.medications], (x) => x.medicationKey),
        supplements: latestByKey([...f.supplements, ...g.supplements], (x) => x.supplementKey),
        reminderPreferences: latestByKey([...f.reminderPreferences, ...g.reminderPreferences], (x) => x.category),
      });
      // Past the erase gate only the copy at the higher epoch counts.
      const [ea, eb] = [a.meta.eraseEpoch ?? 0, b.meta.eraseEpoch ?? 0];
      const want = all(ea >= eb ? a : b, ea === eb ? b : file());
      for (const merged of [mergeFiles(a, b, OPTS), mergeFiles(b, a, OPTS), mergeFiles(a2, b, OPTS), mergeFiles(b, a2, OPTS)]) {
        expect({ medications: merged.medications, supplements: merged.supplements, reminderPreferences: merged.reminderPreferences }).toEqual(want);
      }
    }
  });
});
