// US-12 AC6, US-35 AC17: a value the shared Save's final commit refuses is carried in its outcome as a closed code
// (`refusedCodes`), so the web can send the same usage events its own Save sends (`measurement_refused`,
// `lab_unit_refused`) without reading a display line. A code names the test and the reason in closed words only:
// never a value. Synthetic values only.
import { describe, expect, it } from 'vitest';
import { DAY, EMPTY, extra, NOW } from './import-review.test-helpers';
import type { ExtractedValue, UnifiedExtractionResult } from './lab-extraction';
import { LAB_CATALOG, labUnitTaken, resolveLabCatalogEntry } from './lab-catalog';
import { isLabKeyWord, labUnitForEvent, MEASUREMENT_REFUSAL_REASONS } from './product-events';
import { bulkAppendValues, type BulkAppendResult, type BulkRow } from './record-edits';
import type { RoadmapFile } from './roadmap-file';
import { NO_CHOICES } from './upload-choices';
import type { RefusedCode, UploadState } from './upload-flow';
import { uploadSavePlan } from './upload-plan';
import { uploadReview } from './upload-review';
import { REFUSED_CODE_KEYS, UPLOAD_STATE } from './upload-schema';
import { refusalCodes, uploadSave } from './upload-save';
import { METRIC_TYPES, type MetricTypeValue } from './validation';

const IO = { stopped: () => false, holds: () => false, original: () => null, mimeType: () => '', write: async () => {} };
const bpValue = (metric: 'systolic_bp' | 'diastolic_bp', v: number): ExtractedValue =>
  ({ metric, valueSI: v, displayValue: v, displayUnit: 'mmHg', displaySystem: 'si', confidence: 'high' });
const report = (values: ExtractedValue[], additionalValues = [extra()]): UnifiedExtractionResult =>
  ({ classification: 'lab_report', reportDate: DAY, values, additionalValues, unrecognized: [], document: null });
const saving = (x: UnifiedExtractionResult): UploadState => ({ phase: 'saving', platform: 'web', run: 1, started: NOW, firstRead: NOW, attempt: 1,
  files: [{ id: 'f', name: 'a.pdf', bytes: 1, hash: 'h-a', pages: null, status: { s: 'read', extraction: x, choices: NO_CHOICES } }] });
const another = (rows: Array<Omit<Extract<BulkRow, { kind: 'measurement' }>, 'kind' | 'recordedAt' | 'source'>>) =>
  bulkAppendValues(EMPTY, rows.map((r) => ({ kind: 'measurement' as const, recordedAt: DAY, source: 'manual' as const, ...r })), NOW).file;

async function commitOn(s: UploadState, record: RoadmapFile, at: RoadmapFile) {
  const out = await uploadSave(s, record, NOW, false, IO);
  if (!out.ok) throw new Error(out.reason);
  return out.commit(at).outcome;
}

/** Every word a code may hold: the closed vocabularies today's events take, never a value. */
function assertClosed(codes: RefusedCode[]): void {
  const json = JSON.stringify(codes);
  expect(json).toMatch(/^[\[\]{}":,a-zA-Z_\-/µ() ]*$/); // no digit, so no value; the test units hold none
  for (const c of codes) {
    if (c.kind === 'measurement') {
      expect(Object.keys(c).sort()).toEqual(c.metricType === undefined ? ['kind', 'reason'] : ['kind', 'metricType', 'reason']);
      expect(MEASUREMENT_REFUSAL_REASONS).toContain(c.reason);
      if (c.metricType !== undefined) expect(METRIC_TYPES).toContain(c.metricType);
    } else {
      expect(c.kind).toBe('lab');
      expect(['key', 'kind', 'reason', 'unit']).toEqual(expect.arrayContaining(Object.keys(c)));
      expect(isLabKeyWord(c.key)).toBe(true);
      expect(REFUSED_CODE_KEYS.has(c.key), c.key).toBe(true); // only a key the writer can emit
      expect(['unit', 'value']).toContain(c.reason);
      if (c.unit !== undefined) expect(c.reason).toBe('unit');
    }
  }
}

describe('US-12 AC6: the commit carries a closed code for each value it refused', () => {
  it('a core value another writer made the commit refuse (a blood pressure the wrong way up) yields its code', async () => {
    const s = saving(report([bpValue('systolic_bp', 90)], []));
    // While the originals uploaded, another device saved a diastolic of 120 for that day: 90/120 is the wrong way up.
    const outcome = await commitOn(s, EMPTY, another([{ metricType: 'diastolic_bp', value: 120 }]));
    expect(outcome.refusedCodes).toEqual([{ kind: 'measurement', metricType: 'systolic_bp', reason: 'out-of-range' }]);
    expect(outcome.refused).toHaveLength(1); // the display line is unchanged beside it
    assertClosed(outcome.refusedCodes!);
  });

  it('a lab the commit write refuses yields its code: the catalogue key, `unit` with the counted spelling, or `value`', () => {
    // A lab refusal turns on the row alone, never the record, so the plan already leaves it out of the commit; the
    // codes are read from the commit's write as it is, which this checks directly.
    const rows: BulkRow[] = [
      { kind: 'lab', metricName: 'Ferritin', value: 80, unit: 'mmol/L', recordedAt: DAY, source: 'lab_import' },
      { kind: 'lab', metricName: 'Ferritin', value: 80, unit: 'zzz', recordedAt: '2026-10-02', source: 'lab_import' },
      { kind: 'lab', metricName: 'Ferritin', value: 80, unit: '', recordedAt: '2026-10-03', source: 'lab_import' },
    ];
    const written = bulkAppendValues(EMPTY, rows, NOW);
    expect(written.refused).toHaveLength(3);
    const codes = refusalCodes(written);
    expect(codes).toEqual([
      { kind: 'lab', key: 'ferritin', reason: 'unit', unit: 'mmol/L' },
      { kind: 'lab', key: 'ferritin', reason: 'unit' }, // not a unit word: counted without it, as lab_unit_refused is
      { kind: 'lab', key: 'ferritin', reason: 'unit', unit: '(blank)' },
    ]);
    assertClosed(codes);
  });

  it('a lab whose test takes the spelling but whose number was refused reads `value`, with no unit', () => {
    const written: Pick<BulkAppendResult, 'refused' | 'measurementRefusals'> = {
      refused: [{ key: 'ferritin', unit: 'µg/L', message: 'synthetic', fault: 'implausible', bound: 'above' }], measurementRefusals: [],
    };
    expect(refusalCodes(written)).toEqual([{ kind: 'lab', key: 'ferritin', reason: 'value' }]);
  });

  it('a core metric the record does not know is named by its reason alone: its name is free text', () => {
    const written = bulkAppendValues(EMPTY, [{ kind: 'measurement', metricType: 'not a metric 42', value: 1, recordedAt: DAY, source: 'manual' }], NOW);
    expect(refusalCodes(written)).toEqual([{ kind: 'measurement', reason: 'unknown-metric' }]);
  });

  it('a clean commit carries no field', async () => {
    const s = saving(report([bpValue('systolic_bp', 120), bpValue('diastolic_bp', 80)]));
    const outcome = await commitOn(s, EMPTY, EMPTY);
    expect(outcome.values).toBe(3);
    expect('refusedCodes' in outcome).toBe(false);
  });
});

describe('US-12 AC6: a stored done state carries the codes in closed words only (the phone\'s doors read it)', () => {
  const parses = (refusedCodes: unknown) => {
    const { attempt: _attempt, ...pick } = saving(report([])) as Extract<UploadState, { phase: 'saving' }>;
    return UPLOAD_STATE.safeParse({ ...pick, phase: 'done', outcome: { values: 0, documents: 0, archived: 0, refusedCodes } }).success;
  };
  it('takes each code shape', () => {
    expect(parses([{ kind: 'measurement', metricType: 'systolic_bp', reason: 'out-of-range' }, { kind: 'measurement', reason: 'unknown-metric' },
      { kind: 'lab', key: 'ferritin', reason: 'unit', unit: 'mmol/L' }, { kind: 'lab', key: 'ferritin', reason: 'unit', unit: '(blank)' }, { kind: 'lab', key: 'ferritin', reason: 'value' }])).toBe(true);
  });
  it('takes a lab key with digits that the catalogue holds', () => {
    expect(LAB_CATALOG.some((e) => e.key === 'vitamin_b12')).toBe(true);
    expect(parses([{ kind: 'lab', key: 'vitamin_b12', reason: 'value' }])).toBe(true);
  });
  it('refuses a lab key the writer cannot emit, though shaped like one: a number may not ride in it', () => {
    for (const key of ['glucose_180', 'ldl2', 'thyroxine_free']) {
      expect(LAB_CATALOG.some((e) => e.key === key), key).toBe(false);
      expect(parses([{ kind: 'lab', key, reason: 'value' }]), key).toBe(false);
    }
  });
  it('refuses a code holding free text or a value', () => {
    for (const bad of [
      { kind: 'measurement', metricType: 'not a metric', reason: 'unknown-metric' },
      { kind: 'measurement', metricType: 'systolic_bp', reason: 'out-of-range', value: 90 },
      { kind: 'lab', key: 'Ferritin 80', reason: 'unit' },
      { kind: 'lab', key: 'ferritin', reason: 'unit', unit: '80 mmol/L' },
      { kind: 'lab', key: 'ferritin', reason: 'implausible' },
    ]) expect(parses([bad]), JSON.stringify(bad)).toBe(false);
  });
});

// --- Generated: the codes are exactly what the commit's write refused ---------------------------------------------

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The oracle's table, written out by hand: each refusal as today's web events read it (roadmap-data.ts,
 *  refused-spellings.ts). */
function byHand(w: BulkAppendResult): RefusedCode[] {
  const labs = w.refused.map((r): RefusedCode => {
    if (labUnitTaken(resolveLabCatalogEntry(r.key), r.unit)) return { kind: 'lab', key: r.key, reason: 'value' };
    const unit = labUnitForEvent(r.unit);
    return unit === undefined ? { kind: 'lab', key: r.key, reason: 'unit' } : { kind: 'lab', key: r.key, reason: 'unit', unit };
  });
  const cores = w.measurementRefusals.map((r): RefusedCode => (r.reason === 'unknown-metric'
    ? { kind: 'measurement', reason: r.reason }
    : { kind: 'measurement', reason: r.reason, metricType: r.metricType as MetricTypeValue }));
  return [...labs, ...cores];
}
const multiset = (codes: RefusedCode[] | undefined) => (codes ?? []).map((c) => JSON.stringify(c, Object.keys(c).sort())).sort();

describe('US-12 AC6, generated: the codes are the commit write\'s refusals, one each', () => {
  it('over 300 seeded picks and writers meanwhile', async () => {
    let refusedSeen = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = rng(seed);
      const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
      const values: ExtractedValue[] = [];
      if (r() < 0.8) values.push(bpValue('systolic_bp', 80 + Math.floor(r() * 100)));
      if (r() < 0.5) values.push(bpValue('diastolic_bp', 50 + Math.floor(r() * 80)));
      const additional = Array.from({ length: Math.floor(r() * 3) }, () => extra({ unit: pick(['µg/L', 'ng/mL', 'mmol/L', 'zzz']) }));
      const s = saving(report(values, additional.slice(0, 1)));
      const record = r() < 0.3 ? another([{ metricType: pick(['systolic_bp', 'diastolic_bp']), value: 60 + Math.floor(r() * 100) }]) : EMPTY;
      // Another writer meanwhile: a half for the same day, or nothing.
      const at = r() < 0.85 ? bulkAppendValues(record, [{ kind: 'measurement', metricType: pick(['systolic_bp', 'diastolic_bp']), value: 50 + Math.floor(r() * 130), recordedAt: DAY, source: 'manual' }], NOW).file : record;
      const out = await uploadSave(s, record, NOW, false, IO);
      if (!out.ok) continue;
      const { outcome } = out.commit(at);
      // The oracle: the plan's rows written on the commit record on their own.
      const rows = uploadSavePlan(s, record, NOW, uploadReview(s, record, NOW), false).labRows.flatMap((f) => f.rows);
      const expected = byHand(bulkAppendValues(at, rows, NOW));
      expect(multiset(outcome.refusedCodes), `seed ${seed}`).toEqual(multiset(expected));
      expect('refusedCodes' in outcome, `seed ${seed}`).toBe(expected.length > 0);
      // `refused` also names the rows the list refused and never sent (US-13 AC27): one code for each commit refusal only.
      expect(outcome.refused?.length ?? 0, `seed ${seed}`).toBeGreaterThanOrEqual(outcome.refusedCodes?.length ?? 0);
      if (outcome.refusedCodes) { assertClosed(outcome.refusedCodes); refusedSeen++; }
    }
    expect(refusedSeen).toBeGreaterThan(10); // the generator reaches the refusal, not only clean commits
  });
});
