/**
 * L13 across unit toggles (web list PR 1e; US-13 AC5, AC26), on its own seeds, apart from upload-view.property.test.ts so
 * that run stays inside CI's time budget. Each seed types text and numbers into a report's rows in any unit that fits, then
 * reads the list after every step in a unit chosen afresh for each test (a toggle, or an Lp(a) pick): the label beside
 * held text, the unit a commit is typed in and `typed.unit` agree; a row holding text offers no unit control while the
 * test's other rows keep theirs (owner ruling on PR 1951). The oracle is `checkUnits` (upload-list-page.test-helpers.ts),
 * with its mutations: `label: shown.unit` fails it (seed 1: "L13: f0:v0 shows unit "mg/dL" (si), held text typed in si");
 * a toggle kept on a row holding text fails it (seed 1: "L13: f0:v0 toggles to conventional, want null (holds text)").
 * Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import type { CellUnit } from './cell-unit';
import type { UnifiedExtractionResult } from './lab-extraction';
import { NO_CHOICES, type ChoiceChange } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { uploadList } from './upload-list';
import { checkUnits } from './upload-list-page.test-helpers';
import { uploadReview } from './upload-review';
import { LPA_UNITS, type MetricType } from './units';

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Failure extends Error {}
const fail = (prop: string, msg: string): never => { throw new Failure(`${prop}: ${msg}`); };

const POOL = [
  () => core({}),
  () => core({ valueSI: 2.4, displayValue: 2.4, recordedAt: '2026-10-01' }),
  () => core({ metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol' }),
  () => core({ metric: 'lpa', valueSI: 120, displayValue: 120, displayUnit: 'nmol/L' }),
  () => core({ metric: 'systolic_bp', valueSI: 120, displayValue: 120, displayUnit: 'mmHg' }),
];
const UNITS: readonly CellUnit[] = ['si', 'conventional', ...LPA_UNITS];
const SEEDS = 400;

describe('L13 across unit toggles, on its own seeds', () => {
  it(`holds for ${SEEDS} seeded reports`, () => {
    const reach = { held: 0, heldOtherUnit: 0, heldBesideToggle: 0, lpaHeld: 0 };
    for (let seed = 1; seed <= SEEDS; seed++) {
      const r = mulberry32(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
      const values = Array.from({ length: 2 + Math.floor(r() * 4) }, () => pick(POOL)());
      const x: UnifiedExtractionResult = { classification: 'lab_report', reportDate: DAY, values, additionalValues: r() < 0.5 ? [extra({})] : [], unrecognized: [], document: null };
      let s: UploadState = { phase: 'open', platform: 'web', run: 1, started: NOW, firstRead: NOW,
        files: [{ id: 'f0', name: 'f0.pdf', bytes: 1, hash: 'h-f0', pages: { count: 1, truncated: false }, status: { s: 'read', extraction: x, choices: NO_CHOICES } }] };
      const refs = [...values.map((_, i) => `v${i}`), ...x.additionalValues.map((_, i) => `a${i}`)];
      for (let step = 0; step < 12; step++) {
        const ref = pick(refs);
        const change: ChoiceChange = r() < 0.15 ? { tick: ref, on: r() < 0.5 }
          : { typed: ref, text: pick(['abc', '1,234', '3..5', '3.6', '']), unit: ref[0] === 'a' ? null : pick(UNITS) };
        s = transition(s, { type: 'chose', id: 'f0', change, now: NOW }).state;
        // The person's units now: each test's toggle, or Lp(a)'s pick, chosen afresh, as after any sequence of toggles.
        const system = pick(['si', 'conventional'] as const);
        // Lp(a) as the web may read it: one of its three units, or a system unit (review H3: `current` maps it).
        const lpa = pick(UNITS);
        const unitOf = (m: MetricType): CellUnit => (m === 'lpa' ? lpa : system);
        const list = uploadList(s, EMPTY, NOW, uploadReview(s, EMPTY, NOW), unitOf);
        try { checkUnits(s, list, unitOf, fail); } catch (e) {
          if (e instanceof Failure) throw new Error(`${e.message}\nseed ${seed}, step ${step}`);
          throw e;
        }
        for (const row of list.rows) {
          if (!row.typed) continue;
          reach.held++;
          if (row.typed.unit && row.typed.unit !== unitOf(row.shown.cell?.metric ?? 'ldl')) reach.heldOtherUnit++;
          if (row.shown.cell?.metric === 'lpa') reach.lpaHeld++;
          if (list.rows.some((o) => o !== row && o.unit.toggle && o.shown.cell?.metric === row.shown.cell?.metric)) reach.heldBesideToggle++;
        }
      }
    }
    for (const [name, k] of Object.entries(reach)) expect([name, k > 0]).toEqual([name, true]);
  });
});
