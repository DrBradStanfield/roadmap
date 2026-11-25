/**
 * A blood pressure is one reading (US-13 AC27, owner ruling on PR 2152), as a property: over seeded uploads of blood
 * pressure halves (in range, out of range, the wrong way up, cleared, edited) on a report's day and its dated previous
 * columns, across reports on their own days, onto a record that may hold a half already, no Save writes one half of a
 * pair from a report and day whose other half the review or the commit refused. Each report's days are its own, so a
 * written row names the report it came from. Mutation: no partner refused (`paired` always false, import-review.ts) fails it on seed 1.
 * Synthetic values only.
 */
import { describe, expect, it } from 'vitest';
import { core, EMPTY, NOW } from './import-review.test-helpers';
import { bulkAppendValues } from './record-edits';
import type { ExtractedValue } from './lab-extraction';
import { NO_CHOICES, type FileChoices } from './upload-choices';
import { transition, type UploadState } from './upload-flow';
import { reviewedWrites, uploadReview } from './upload-review';
import { uploadSave } from './upload-save';
import { uploadView } from './upload-view';

type Open = Extract<UploadState, { phase: 'open' }>;
const SEEDS = 400;
const HALVES = ['systolic_bp', 'diastolic_bp'] as const;
const OTHER = { systolic_bp: 'diastolic_bp', diastolic_bp: 'systolic_bp' } as const;
/** Each report's own days: its test day, then two dated previous columns. */
const DAYS = [['2026-11-01', '2026-10-01', '2026-09-01'], ['2026-08-01', '2026-07-01', '2026-06-01']] as const;
const off = { stopped: () => false, holds: () => false, original: () => null, mimeType: () => '', write: async () => {}, now: () => NOW };

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

function genCase(seed: number) {
  const r = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const files = DAYS.slice(0, 1 + Math.floor(r() * 2)).map((days, i) => {
    const values: ExtractedValue[] = [];
    for (const [k, day] of days.entries()) {
      if (r() < 0.3) continue;
      for (const metric of HALVES) {
        if (r() < 0.15) continue;
        const v = pick(metric === 'systolic_bp' ? [120, 135, 70, 400, 30] : [80, 90, 140, 200, 20]);
        values.push(core({ metric, valueSI: v, displayValue: v, displayUnit: 'mmHg', ...(k ? { recordedAt: day } : {}) }));
      }
    }
    const choices: FileChoices = { ...NO_CHOICES, ticks: {}, edits: {} };
    values.forEach((v, j) => {
      if (r() < 0.1) choices.ticks[`v${j}`] = false;
      if (r() < 0.1) choices.edits[`v${j}`] = v.metric === 'systolic_bp' ? pick([125, 300]) : pick([85, 180]);
    });
    return { id: `f${i}`, name: `f${i}.pdf`, bytes: 1, hash: `h-f${i}`, pages: { count: 1, truncated: false },
      status: { s: 'read' as const, extraction: { classification: 'lab_report' as const, reportDate: days[0], values, additionalValues: [], unrecognized: [], document: null }, choices } };
  });
  const record = r() < 0.4 ? bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: pick(HALVES), value: pick([95, 130]), recordedAt: pick(DAYS.flat()), source: 'manual' }], NOW).file : EMPTY;
  const s: Open = { phase: 'open', platform: pick(['web', 'phone'] as const), run: 1, files, started: NOW, firstRead: NOW };
  return { s, record, files };
}

describe('US-13 AC27: no Save writes half a blood pressure whose other half was refused', () => {
  it(`holds for ${SEEDS} seeded uploads`, async () => {
    let reached = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const { s, record, files } = genCase(seed);
      const review = uploadReview(s, record, NOW);
      if (!uploadView(s, record, NOW, review, false).save.enabled) continue;
      // Refused by the review: a sent half the write will not take for its range or the pair's order.
      const refused = new Set(review.classification.values.filter((v) => v.sent && !v.writes && v.group === 'unsure' && v.reasons.includes('outOfRange'))
        .map((v) => {
          const { extraction } = files[v.file].status;
          const value = extraction.values[Number(v.ref.slice(1))];
          return `${value.metric} ${value.recordedAt ?? extraction.reportDate}`;
        }));
      const saving = transition(s, { type: 'saveStarted', reviewed: reviewedWrites(review) }).state;
      const out = await uploadSave(saving, record, NOW, false, off);
      if (!out.ok) throw new Error(`seed ${seed}: ${out.message}`);
      const { file } = out.commit(record);
      const before = new Set(record.measurements.map((m) => m.id));
      const written = file.measurements.filter((m) => !before.has(m.id) && m.status === 'active').map((m) => `${m.metricType} ${m.recordedAt.slice(0, 10)}`);
      for (const half of written) {
        const [metric, day] = half.split(' ') as [keyof typeof OTHER, string];
        expect(refused.has(`${OTHER[metric]} ${day}`), `seed ${seed}: ${half} written, its other half refused`).toBe(false);
      }
      if (refused.size && written.length) reached++;
    }
    // Saves that refused a half and wrote another pair: the rule was exercised, not dodged.
    expect(reached).toBeGreaterThan(20);
  });
});
