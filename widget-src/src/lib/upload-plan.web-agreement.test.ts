// Design PR 8 (US-13 AC13, US-52 AC8c): health-core's upload plan writes the lab rows today's
// web review hands to Save for the same choices: the web's own `classifyReview` (the review's
// decisions) against `uploadSavePlan`, for seeded reports, cleared cells and edited values.
// The web keeps every value unless its cell is cleared, a question included (upload-rules
// `defaultTicked('web')`). Days are real past days, as the web's columns require.
import { describe, expect, it } from 'vitest';
import { recordFromHistory } from '@roadmap/health-core/import-review';
import { NO_CHOICES } from '@roadmap/health-core/upload-choices';
import type { UploadFile, UploadState } from '@roadmap/health-core/upload-flow';
import { uploadSavePlan } from '@roadmap/health-core/upload-plan';
import { uploadReview } from '@roadmap/health-core/upload-review';
import { classifyReview, type KeptValue } from './import-review-view';
import { buildRecordedAt, parseReportDate } from './review-dates';
import type { FileResult } from './upload-pipeline';
import type { UploadHistory } from './api-types';

const NOW = new Date().toISOString();
const DAYS = ['2026-09-01', '2026-09-02'];

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

const CORE = [['ldl', 3.1], ['hdl', 1.2], ['triglycerides', 1.5]] as const;
const LABS = [['Ferritin', 80, 'µg/L'], ['Vitamin B12', 400, 'pmol/L']] as const;

/** One dated report, with the web's choices: some cells cleared, some edited. */
function genFile(r: () => number, fi: number) {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const result: FileResult = {
    fileName: `f${fi}.pdf`, reportDate: pick(DAYS),
    values: CORE.filter(() => r() < 0.7).map(([metric, v]) => ({
      metric, valueSI: v, displayValue: v, displayUnit: 'mmol/L', displaySystem: 'si' as const, confidence: pick(['high', 'low'] as const),
      ...(r() < 0.2 ? { question: 'Was this a blood test?' } : {}), ...(r() < 0.3 ? { recordedAt: pick(DAYS) } : {}),
    })),
    additionalValues: LABS.filter(() => r() < 0.5).map(([name, value, unit]) => ({ name, value, unit })),
  };
  const refs = [...result.values.map((_, i) => `v${i}`), ...result.additionalValues.map((_, i) => `a${i}`)];
  const cleared = new Set(refs.filter(() => r() < 0.15));
  const edits = Object.fromEntries(refs.filter((ref) => ref[0] === 'a' && !cleared.has(ref) && r() < 0.3).map((ref) => [ref, 50 + Math.floor(r() * 100)]));
  return { result, cleared, edits };
}

describe('upload plan agrees with today\'s web review', () => {
  it('the same lab rows as classifyReview\'s decisions, for 150 seeds', () => {
    let compared = 0;
    for (let seed = 1; seed <= 150; seed++) {
      const r = mulberry32(seed);
      const built = Array.from({ length: 1 + Math.floor(r() * 3) }, (_, fi) => genFile(r, fi));
      const history: UploadHistory = {
        measurements: CORE.filter(() => r() < 0.3).map(([metric, v], i) => ({ id: `m${i}`, metricType: metric, value: r() < 0.5 ? v : v * 2, recordedAt: `${DAYS[0]}T00:00:00.000Z`, createdAt: NOW })) as never,
        labValues: [], documents: [],
      };
      // The web: each kept cell on its column's day, an edit its number (ReviewTable `kept`).
      const results = built.map((b) => b.result);
      const fileDates = Object.fromEntries(results.map((res, fi) => [String(fi), parseReportDate(res.reportDate)]));
      const kept: KeptValue[] = built.flatMap(({ result, cleared, edits }, fi) => [
        ...result.values.map((v, i) => ({ ref: `v${i}`, day: v.recordedAt ?? result.reportDate })),
        ...result.additionalValues.map((v, i) => ({ ref: `a${i}`, day: v.recordedAt ?? result.reportDate })),
      ].filter(({ ref }) => !cleared.has(ref)).map(({ ref, day }) => ({
        id: `${fi}:${ref}`, recordedAt: buildRecordedAt(parseReportDate(day)), ...(edits[ref] !== undefined ? { edited: edits[ref] } : {}),
      })));
      const web = classifyReview(results, fileDates, history, kept).decisions;
      // The plan: the same choices on the upload's read files.
      const files: UploadFile[] = built.map(({ result, cleared, edits }, fi) => ({
        id: `f${fi}`, name: result.fileName, bytes: 1, hash: `h${fi}`, pages: null,
        status: { s: 'read', extraction: { classification: 'lab_report', unrecognized: [], document: null, ...result } as never,
          choices: { ...NO_CHOICES, ticks: Object.fromEntries([...cleared].map((ref) => [ref, false])), edits } },
      }));
      const s: UploadState = { phase: 'open', platform: 'web', run: 1, files, started: NOW, firstRead: null };
      const record = recordFromHistory(history.measurements, history.labValues);
      const rows = uploadSavePlan(s, record, NOW, uploadReview(s, record, NOW), true).labRows.flatMap((l) => l.rows);
      const day = (at: string) => at.slice(0, 10);
      const planCore = rows.flatMap((row) => (row.kind === 'measurement' ? [[row.metricType, row.value, day(row.recordedAt), row.source]] : []));
      const webCore = web.values.map((v) => [v.metric, v.valueSI, day(v.recordedAt), v.source ?? 'lab_import']);
      // A lab's edited marker is the store's to drop (to-store-inputs.ts files every lab as lab_import): compared without it.
      const planLabs = rows.flatMap((row) => (row.kind === 'lab' ? [[row.metricName, row.value, row.unit, day(row.recordedAt)]] : []));
      const webLabs = web.labValues.map((v) => [v.name, v.value, v.unit, day(v.recordedAt)]);
      expect([seed, planCore.sort()]).toEqual([seed, webCore.sort()]);
      expect([seed, planLabs.sort()]).toEqual([seed, webLabs.sort()]);
      compared += planCore.length + planLabs.length;
    }
    expect(compared).toBeGreaterThan(200);
  });
});
