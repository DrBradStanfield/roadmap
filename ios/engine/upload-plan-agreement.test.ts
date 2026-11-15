// Design PR 8 (US-52 AC8c, US-13 AC13, AC14): health-core's upload plan writes what today's
// iPhone save writes for the same choices (ios/engine lab-review.ts `labRows`, behind Swift's
// LabSavePlan: ticks default to every value with no question, the test day to the report's),
// and files each letter as its review card does (`labReview(...).document`). The one
// exception is R3: a letter whose name the record already holds is skipped by today's card
// and saved by the plan, since the upload's own duplicate rule (upload-known.ts) runs before
// the read. The web classifies every file at once as the plan does; across files that never
// share a (test, day) the plan equals each report saved alone. Seeded, no dependency.
import { describe, expect, it } from 'vitest';
import { labReview, labRows, type Extraction } from './lab-review';
import { createEmptyFile, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { bulkAppendValues, type BulkRow } from '../../packages/health-core/src/record-edits';
import { documentRow } from '../../packages/health-core/src/document-rows';
import type { UploadFile, UploadState } from '../../packages/health-core/src/upload-flow';
import { uploadSavePlan } from '../../packages/health-core/src/upload-plan';
import { uploadReview } from '../../packages/health-core/src/upload-review';
import { uploadView } from '../../packages/health-core/src/upload-view';

const NOW = '2026-11-15T00:00:00.000Z';
const DAYS = ['2026-10-01', '2026-10-02', '2026-10-03'];
const TODAY = '2026-11-15';

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

const CORE = [['ldl', 3.1, 'mmol/L'], ['hdl', 1.2, 'mmol/L'], ['triglycerides', 1.5, 'mmol/L'], ['hba1c', 39, 'mmol/mol']] as const;
const LABS = [['Ferritin', 80, 'µg/L'], ['Vitamin B12', 400, 'pmol/L'], ['Ferritin', 900000, 'µg/L']] as const;

/** One lab report over `metrics` (a slice of CORE and LABS), its own days drawn from `days`. */
function genLab(r: () => number, metrics: { core: typeof CORE[number][]; labs: typeof LABS[number][] }, days: string[]): Extraction {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  return {
    classification: 'lab_report',
    reportDate: coin(0.2) ? null : pick(days),
    values: metrics.core.map(([metric, v, unit]) => ({
      metric, valueSI: coin(0.3) ? v * 1.5 : v, displayValue: v, displayUnit: unit, displaySystem: 'si' as const,
      confidence: pick(['high', 'high', 'medium', 'low'] as const),
      ...(coin(0.15) ? { question: 'Was this a blood test?' } : {}),
      ...(coin(0.25) ? { recordedAt: pick(days) } : {}),
    })),
    additionalValues: metrics.labs.map(([name, value, unit]) => ({ name, value, unit, ...(coin(0.25) ? { recordedAt: pick(days) } : {}) })),
  };
}

function genRecord(r: () => number): RoadmapFile {
  const rows: BulkRow[] = [];
  for (const [metric, v] of CORE) if (r() < 0.3) rows.push({ kind: 'measurement', metricType: metric, value: r() < 0.5 ? v : v * 2, recordedAt: DAYS[Math.floor(r() * DAYS.length)], source: 'manual' });
  return bulkAppendValues(createEmptyFile({ deviceId: 't', now: NOW }), rows, NOW).file;
}

const readFile = (id: string, extraction: Extraction, ticks: Record<string, boolean> = {}, testDay: string | null = null, hash = `h-${id}`): UploadFile => ({
  id, name: `${id}.pdf`, bytes: 1, hash, pages: { count: 1, truncated: false },
  status: { s: 'read', extraction: { unrecognized: [], document: null, ...extraction } as never, choices: { ticks, testDay, previousDay: null, replace: {}, edits: {}, document: {} } },
});
/** The caller's way: one review, handed to the plan. */
const planOf = (s: UploadState, record: RoadmapFile, now: string) => uploadSavePlan(s, record, now, uploadReview(s, record, now), true);
const open = (files: UploadFile[]): UploadState => ({ phase: 'open', platform: 'phone', run: 1, files, started: NOW, firstRead: null });
const refsOf = (x: Extraction) => [...(x.values ?? []).map((v, i) => ({ ref: `v${i}`, q: !!v.question })), ...(x.additionalValues ?? []).map((_, i) => ({ ref: `a${i}`, q: false }))];

describe('upload plan agrees with today\'s iPhone save', () => {
  it('one report: the same rows as labRows for the same ticks and day, for 400 seeds', () => {
    let compared = 0;
    let waited = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const r = mulberry32(seed);
      const x = genLab(r, { core: CORE.filter(() => r() < 0.6), labs: LABS.filter(() => r() < 0.4) }, DAYS);
      const record = genRecord(r);
      const ticks: Record<string, boolean> = {};
      for (const { ref } of refsOf(x)) if (r() < 0.2) ticks[ref] = r() < 0.5;
      const testDay = r() < 0.3 ? DAYS[0] : null;
      const plan = planOf(open([readFile('a', x, ticks, testDay)]), record, NOW);
      const ticked = refsOf(x).filter(({ ref, q }) => ticks[ref] ?? !q).map((t) => t.ref);
      const planned = plan.labRows.find((l) => l.fileId === 'a')?.rows ?? [];
      const ownDay = (ref: string) => (ref[0] === 'v' ? x.values![Number(ref.slice(1))].recordedAt : x.additionalValues![Number(ref.slice(1))].recordedAt);
      // The phone's test day starts at the report's, else today, and waits to be confirmed when a
      // ticked value needs it (LabChoices.valuesWait): then it saves nothing, and neither does the plan.
      if (!testDay && !x.reportDate && ticked.some((ref) => ownDay(ref) === undefined)) {
        expect([seed, planned]).toEqual([seed, []]);
        waited++;
        continue;
      }
      const phone = labRows(x, ticked, testDay ?? x.reportDate ?? TODAY, NOW, record);
      if (!phone.ok) throw new Error(`seed ${seed}: ${phone.message}`);
      expect([seed, planned]).toEqual([seed, phone.rows]);
      compared++;
    }
    expect(compared).toBeGreaterThan(200);
    expect(waited).toBeGreaterThan(10);
  });

  it('reports that share no (test, day): the plan equals each report saved alone, in picked order', () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = mulberry32(seed);
      const a = genLab(r, { core: [CORE[0], CORE[1]], labs: [LABS[0]] }, [DAYS[0]]);
      const b = genLab(r, { core: [CORE[2], CORE[3]], labs: [LABS[1]] }, [DAYS[1]]);
      const empty = createEmptyFile({ deviceId: 't', now: NOW });
      const plan = planOf(open([readFile('a', a), readFile('b', b)]), empty, NOW);
      const alone = (x: Extraction) => {
        const ticked = refsOf(x).filter((t) => !t.q).map((t) => t.ref);
        const needs = ticked.some((ref) => (ref[0] === 'v' ? x.values![Number(ref.slice(1))].recordedAt : x.additionalValues![Number(ref.slice(1))].recordedAt) === undefined);
        if (!x.reportDate && needs) return []; // waits for the test day
        const res = labRows(x, ticked, x.reportDate ?? TODAY, NOW, empty);
        return res.ok ? res.rows : [];
      };
      const want = [{ fileId: 'a', rows: alone(a) }, { fileId: 'b', rows: alone(b) }].filter((l) => l.rows.length);
      expect([seed, plan.labRows]).toEqual([seed, want]);
    }
  });

  it('two reports with the same test on the same day: one copy saves, as the web classifies them together', () => {
    const x: Extraction = { classification: 'lab_report', reportDate: DAYS[0], values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }] };
    const plan = planOf(open([readFile('a', x), readFile('b', x)]), createEmptyFile({ deviceId: 't', now: NOW }), NOW);
    expect(plan.counts.values).toBe(1);
    expect(plan.labRows.map((l) => l.fileId)).toEqual(['a']);
  });

  it('a letter: the title, kind and date of today\'s review card, held row included; R3 differs only on a same-name letter', () => {
    let r3 = 0;
    for (let seed = 1; seed <= 120; seed++) {
      const r = mulberry32(seed);
      const doc = { classification: 'clinic_letter', title: `Letter ${seed}`, documentDate: r() < 0.3 ? null : r() < 0.5 ? '2026-10-05' : '2026-10', contentMarkdown: 'text', metadata: {} };
      const x: Extraction = { classification: 'clinic_letter', reportDate: null, document: doc };
      const rows = [];
      if (r() < 0.3) rows.push(documentRow({ documentType: 'clinic_letter', title: 'Held', documentDate: '2026-09-09', contentMd: '', metadata: {}, sourceFileName: 'other.pdf' }, { id: 'h', contentHash: 'h-a', mimeType: '', addedAt: NOW }));
      if (r() < 0.2) rows.push(documentRow({ documentType: 'clinic_letter', title: 'Same name', documentDate: null, contentMd: 't', metadata: {}, sourceFileName: 'a.pdf' }, { id: 's', contentHash: '', mimeType: '', addedAt: NOW }));
      const record = { ...createEmptyFile({ deviceId: 't', now: NOW }), documents: rows };
      const card = labReview(x, NOW, record, 'a.pdf', 'h-a').document!;
      const plan = planOf(open([{ ...readFile('a', x), status: { s: 'read', extraction: { unrecognized: [], values: [], additionalValues: [], ...x } as never, choices: { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} } } }]), record, NOW);
      expect([seed, plan.documents[0].fields]).toMatchObject([seed, { title: card.title, documentDate: card.documentDate, documentType: card.classification, sourceFileName: 'a.pdf' }]);
      if (card.alreadySaved) r3++;
    }
    expect(r3).toBeGreaterThan(0);
  });
});

describe('the view counts what the plan writes', () => {
  it('the numbers in Save\'s label, the documents line and the sure line equal what the plan writes, for 300 seeds', () => {
    const num = (text: string, word: RegExp) => Number(word.exec(text)?.[1] ?? 0);
    const letter = (i: number): Extraction => ({ classification: 'clinic_letter', reportDate: null, document: { classification: 'clinic_letter', title: `L${i}`, documentDate: null, contentMarkdown: 't', metadata: {} } });
    let withDocs = 0;
    for (let seed = 1; seed <= 300; seed++) {
      const r = mulberry32(seed);
      const files = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => (r() < 0.3
        ? readFile(`f${i}`, letter(i), {}, null, r() < 0.2 ? 'h-same' : `h-${i}`)
        : readFile(`f${i}`, genLab(r, { core: CORE.filter(() => r() < 0.5), labs: LABS.filter(() => r() < 0.3) }, DAYS))));
      const s = open(files);
      const record = genRecord(r);
      const review = uploadReview(s, record, NOW);
      const plan = uploadSavePlan(s, record, NOW, review, true);
      const view = uploadView(s, record, NOW, review, true);
      const written = plan.labRows.reduce((n, l) => n + l.rows.length, 0);
      // The label's own numbers, read back from its words, against the rows and payloads Save would write.
      if (written || plan.documents.length) {
        expect([seed, num(view.save.label, /(\d+) values?/), num(view.save.label, /(\d+) documents?/)]).toEqual([seed, written, plan.documents.length]);
      }
      expect([seed, view.documents ? num(view.documents.line, /^(\d+)/) : 0]).toEqual([seed, plan.documents.length]);
      // The sure line counts the sure rows whose value the plan writes, row by row.
      const planned = new Set(plan.labRows.flatMap((l) => l.rows));
      const writes = (fileId: string, ref: string) => review.classification.values.some((v) => v.ref === ref && review.labFiles[v.file].fileId === fileId && v.writes)
        && planned.size > 0;
      const sureWrites = (view.sure?.rows ?? []).filter((row) => writes(row.fileId, row.ref)).length;
      expect([seed, view.sure ? num(view.sure.line, /^(\d+)/) : 0]).toEqual([seed, sureWrites]);
      if (plan.documents.length) withDocs++;
    }
    expect(withDocs).toBeGreaterThan(30);
  });
});
