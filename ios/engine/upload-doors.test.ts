// Shared upload PR 12 (US-52 AC8c): the upload doors agree with health-core, as a caller sees them.
// Seeded event sequences (mulberry32, the upload-flow.property.test.ts pattern) drive the step door
// and, beside it, health-core's transition with the same event made whole by health-core's own
// rules; after each step the view, save plan and usage doors answer exactly as health-core does.
// Malformed input answers the refusal and never throws. Synthetic rows, names and hashes only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadSavePlanJson, uploadStartJson, uploadStepJson, uploadUsageJson, uploadViewJson } from './entry';
import { createEmptyFile, type FileDocument, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { bulkAppendValues, type BulkRow } from '../../packages/health-core/src/record-edits';
import { initialUpload, transition, type UploadEvent, type UploadState } from '../../packages/health-core/src/upload-flow';
import { knownAs, knownIndex, readIsLegacy } from '../../packages/health-core/src/upload-known';
import { uploadFailure } from '../../packages/health-core/src/upload-failure';
import { uploadReview } from '../../packages/health-core/src/upload-review';
import { uploadView } from '../../packages/health-core/src/upload-view';
import { uploadSavePlan } from '../../packages/health-core/src/upload-plan';
import { uploadUsageCounts } from '../../packages/health-core/src/upload-usage';
import type { UnifiedExtractionResult } from '../../packages/health-core/src/lab-extraction';

const NOW = '2026-11-02T00:00:00.000Z';
const DAY = '2026-11-01';

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

// --- A record: a stored document, an archive-only one, a hashless older letter, an LDL on DAY. ---
const doc = (over: Partial<FileDocument>): FileDocument => ({
  id: 'd', title: 'Synthetic letter', type: 'clinic_letter', date: '2026-01-01', fileRef: 'Clinic letters/x.pdf',
  contentHash: '', mimeType: 'application/pdf', extractedText: 'Synthetic', addedAt: NOW, metadata: {}, sourceFileName: 'x.pdf', ...over,
});
const RECORD: RoadmapFile = {
  ...bulkAppendValues(createEmptyFile({ deviceId: 'test', now: NOW }), [{ kind: 'measurement', metricType: 'ldl', value: 2.5, recordedAt: DAY, source: 'manual' } as BulkRow], NOW).file,
  documents: [
    doc({ id: 'd1', contentHash: 'h-held' }),
    doc({ id: 'd2', contentHash: 'h-meta', fileRef: '' }),
    doc({ id: 'd3', fileRef: '', sourceFileName: 'old.pdf' }),
  ],
};
const RECORD_TEXT = JSON.stringify(RECORD);
const HELD_ID = [...RECORD.measurements, ...RECORD.labValues][0].id;

// --- Reads the server can answer ----------------------------------------------------------------
const core = (metric: string, v: number, confidence = 'high') => ({ metric, valueSI: v, displayValue: v, displayUnit: 'mmol/L', displaySystem: 'si', confidence });
const READS: UnifiedExtractionResult[] = [
  { classification: 'lab_report', reportDate: DAY, values: [core('ldl', 3.1), core('hdl', 1.2, 'low')] as never, additionalValues: [{ name: 'Ferritin', value: 80, unit: 'µg/L' }], unrecognized: [], document: null },
  { classification: 'lab_report', reportDate: null, values: [core('ldl', 3.4)] as never, additionalValues: [], unrecognized: [], document: null },
  { classification: 'clinic_letter', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: { classification: 'clinic_letter', title: 'Synthetic letter', documentDate: '2026-01-01', contentMarkdown: '## Plan', metadata: {} } },
  { classification: 'other', reportDate: null, values: [], additionalValues: [], unrecognized: [], document: null },
];
/** A failed send as the app saw it, and the body the web's reader would hand uploadFailure. */
const SEND_ANSWERS: Array<{ status: number | null; body: string | null; contentType: string | null; read: unknown }> = [
  { status: null, body: null, contentType: null, read: null },
  { status: 429, body: '{"code":"busy"}', contentType: 'application/json', read: { code: 'busy' } },
  { status: 429, body: '{}', contentType: 'application/json', read: {} },
  { status: 422, body: '{"errorCode":"too_long"}', contentType: 'application/json; charset=utf-8', read: { errorCode: 'too_long' } },
  { status: 422, body: '{nope', contentType: 'application/json', read: undefined },
  { status: 502, body: '<html>', contentType: 'text/html', read: null },
  { status: 200, body: '{"success":false}', contentType: 'application/json', read: { success: false } },
];
const NAMES = ['old.pdf', 'a.pdf', 'b.jpg', 'c.docx', '__MACOSX/e.pdf'];

type Wire = Record<string, unknown> & { type: string };
/** One wire event (what Swift sends) and health-core's whole event for it. */
function genEvent(r: () => number, s: UploadState, mint: () => string): { wire: Wire; whole: UploadEvent } {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const coin = (p: number) => r() < p;
  const run = coin(0.9) ? s.run : Math.floor(r() * (s.run + 2));
  const files = 'files' in s ? s.files : [];
  const idAt = (stage: string) => {
    const at = files.filter((f) => f.status.s === stage);
    return at.length && coin(0.85) ? pick(at).id : files.length ? pick(files).id : 'nobody';
  };
  const same = (e: UploadEvent) => ({ wire: e as Wire, whole: e });
  const kinds: Array<[number, () => { wire: Wire; whole: UploadEvent }]> = [
    [3, () => same({ type: 'picked', needsConsent: coin(0.2), now: NOW, files: Array.from({ length: 1 + Math.floor(r() * 8) }, () => {
      const zip = coin(0.1);
      return { id: mint(), name: zip ? 'z.zip' : pick(NAMES), bytes: 1, kind: zip ? 'zip' as const : 'file' as const };
    }) })],
    [1, () => same({ type: 'consented' })],
    [2, () => same({ type: 'listed', run, zip: idAt('listing'), members: Array.from({ length: Math.floor(r() * 4) }, () => ({ id: mint(), name: pick(NAMES), bytes: 1 })) })],
    [1, () => same({ type: 'zipFailed', run, zip: idAt('listing') })],
    [10, () => {
      const id = idAt('hashing');
      const hash = coin(0.3) ? pick(['h-held', 'h-meta']) : mint();
      return { wire: { type: 'hashed', run, id, hash }, whole: { type: 'hashed', run, id, hash, known: knownAs(knownIndex(RECORD), hash) } };
    }],
    [1, () => same({ type: 'hashFailed', run, id: idAt('hashing') })],
    [10, () => same({ type: 'converted', run, id: idAt('converting'), pages: 1, truncated: coin(0.1) })],
    [1, () => same({ type: 'convertFailed', run, id: idAt('converting'), reason: pick(['unreadable', 'timeout'] as const) })],
    [8, () => {
      const id = idAt('sending');
      const extraction = pick(READS);
      const name = files.find((f) => f.id === id)?.name;
      return { wire: { type: 'answered', run, id, extraction, now: NOW },
        whole: { type: 'answered', run, id, extraction, now: NOW, legacy: name !== undefined && readIsLegacy(RECORD, name, extraction) } };
    }],
    [2, () => {
      const id = idAt('sending');
      const { read, ...answer } = pick(SEND_ANSWERS);
      return { wire: { type: 'sendFailed', run, id, ...answer }, whole: { type: 'sendFailed', run, id, failure: uploadFailure(answer.status, read) } };
    }],
    [2, () => same({ type: 'retry', id: coin(0.5) ? 'all' : idAt('failed') })],
    [1, () => same({ type: 'stop' })],
    [6, () => same({ type: 'chose', now: NOW, id: idAt('read'), change: pick([
      { tick: 'v0', on: coin(0.5) }, { tick: 'a0', on: coin(0.5) }, { testDay: pick([DAY, '2026-10-01', null]) },
      { replace: 'v0', correctsId: coin(0.5) ? HELD_ID : null }, { edit: 'v1', value: coin(0.5) ? 1.4 : null },
      { document: { title: 'Fixed title', date: pick(['2026-02-01', null, '2999-01-01']) } },
    ]) })],
    [3, () => same({ type: 'saveStarted' })],
    [2, () => same({ type: 'saved', run, attempt: 'attempt' in s ? s.attempt : 1, outcome: { values: 1, documents: 0, archived: 0 } })],
    [1, () => same({ type: 'saveFailed', run, attempt: 'attempt' in s ? s.attempt : 1, message: 'Could not save.' })],
    [1, () => same({ type: 'close' })],
    [1, () => same({ type: 'discard' })],
  ];
  let w = r() * kinds.reduce((n, [k]) => n + k, 0);
  for (const [k, make] of kinds) if ((w -= k) < 0) return make();
  return kinds[0][1]();
}

describe('upload doors agree with health-core (shared upload PR 12, US-52 AC8c)', () => {
  it('start: the initial state for each platform', () => {
    for (const p of ['web', 'phone'] as const) expect(uploadStartJson(p)).toBe(JSON.stringify(initialUpload(p)));
  });

  it('step, view, save plan and usage over 300 seeded sequences of 1-80 events', () => {
    const seen = { known: 0, legacy: 0, sendFailed: 0, read: 0, saveEnabled: 0, done: 0, planned: 0 };
    for (let seed = 1; seed <= 300; seed++) {
      const r = mulberry32(seed);
      let n = 0;
      const mint = () => `h${seed}-${n++}`;
      let s = initialUpload(seed % 3 ? 'phone' : 'web');
      const len = 1 + Math.floor(r() * 80);
      const events: Wire[] = [];
      for (let i = 0; i < len; i++) {
        const { wire, whole } = genEvent(r, s, mint);
        events.push(wire);
        const where = `seed ${seed} step ${i}: ${JSON.stringify(events.map((e) => e.type))}`;
        const direct = transition(s, whole);
        expect(uploadStepJson(JSON.stringify(s), JSON.stringify(wire), RECORD_TEXT), where).toBe(JSON.stringify(direct));
        s = direct.state;
        const cloud = r() < 0.5;
        const review = uploadReview(s, RECORD, NOW);
        const view = uploadView(s, RECORD, NOW, review, cloud);
        const plan = uploadSavePlan(s, RECORD, NOW, review, cloud);
        expect(uploadViewJson(JSON.stringify(s), RECORD_TEXT, NOW, cloud), where).toBe(JSON.stringify(view));
        expect(uploadSavePlanJson(JSON.stringify(s), RECORD_TEXT, NOW, cloud), where).toBe(JSON.stringify(plan));
        expect(uploadUsageJson(JSON.stringify(s)), where).toBe(JSON.stringify(uploadUsageCounts(s)));
        if (whole.type === 'hashed' && whole.known) seen.known++;
        if (whole.type === 'answered' && whole.legacy) seen.legacy++;
        if (whole.type === 'sendFailed') seen.sendFailed++;
        if ('files' in s && s.files.some((f) => f.status.s === 'read')) seen.read++;
        if (view.save.enabled) seen.saveEnabled++;
        if (s.phase === 'done') seen.done++;
        if (plan.counts.values && plan.counts.documents) seen.planned++;
      }
    }
    // The generator reaches what the enrichment and the review are about.
    for (const [name, k] of Object.entries(seen)) expect([name, k > 0]).toEqual([name, true]);
  });

  it("whatever Swift puts in known, legacy or failure, the engine's own answer wins", () => {
    const open = transition(initialUpload('phone'), { type: 'picked', needsConsent: false, now: NOW, files: [{ id: 'f', name: 'a.pdf', bytes: 1, kind: 'file' }] }).state;
    const step = JSON.parse(uploadStepJson(JSON.stringify(open), JSON.stringify({ type: 'hashed', run: 1, id: 'f', hash: 'h-held', known: null }), RECORD_TEXT));
    expect(step.state.files[0].status).toEqual({ s: 'known', as: 'document', archiveOnly: false });
  });
});

describe('upload doors refuse malformed input and never throw (shared upload PR 12)', () => {
  const OPEN = transition(initialUpload('phone'), { type: 'picked', needsConsent: false, now: NOW, files: [{ id: 'f', name: 'a.pdf', bytes: 1, kind: 'file' }] }).state;
  const refusal = (text: string) => {
    const answer = JSON.parse(text);
    expect(answer.ok).toBe(false);
    return answer.reason;
  };
  let logged: ReturnType<typeof vi.spyOn>[] = [];
  beforeEach(() => { logged = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m)); });
  afterEach(() => { for (const spy of logged) { expect(spy).not.toHaveBeenCalled(); spy.mockRestore(); } });

  it('an unknown platform, malformed JSON, a wrong-shape state, an unknown event and a broken record', () => {
    expect(refusal(uploadStartJson('android'))).toBe('invalid-platform');
    for (const bad of ['', '{', 'null', '[]', '{"phase":"open"}', '{"phase":"flying","platform":"web","run":0}', JSON.stringify({ ...OPEN, files: [{ id: 'f' }] })]) {
      expect(refusal(uploadStepJson(bad, '{"type":"stop"}', '')), bad).toBe('invalid-state');
      expect(refusal(uploadViewJson(bad, '', NOW, true)), bad).toBe('invalid-state');
      expect(refusal(uploadSavePlanJson(bad, '', NOW, false)), bad).toBe('invalid-state');
      expect(refusal(uploadUsageJson(bad)), bad).toBe('invalid-state');
    }
    for (const bad of ['', '{', '{"type":"teleport"}', '{"type":"hashed","run":1,"id":"f"}', '{"type":"sendFailed","run":1,"id":"f","failure":"busy"}', '{"type":"answered","run":1,"id":"f","now":"x","extraction":{"values":"many"}}']) {
      expect(refusal(uploadStepJson(JSON.stringify(OPEN), bad, '')), bad).toBe('invalid-event');
    }
    expect(refusal(uploadStepJson(JSON.stringify(OPEN), '{"type":"hashed","run":1,"id":"f","hash":"h"}', '{not json'))).toBe('invalid-record');
    expect(refusal(uploadViewJson(JSON.stringify(OPEN), '[1]', NOW, true))).toBe('invalid-record');
  });

  it('the refusal names no part of what it was given', () => {
    const text = uploadStepJson(JSON.stringify({ ...OPEN, files: [{ id: 'secret-name.pdf', hash: 'sha256-secret' }] }), '{}', '');
    expect(text).not.toMatch(/secret/);
  });

  it('200 seeded mutations of a valid state and event answer JSON, never a throw', () => {
    const read = { ...OPEN, files: [{ ...OPEN.phase === 'open' ? OPEN.files[0] : {}, hash: 'h', pages: { count: 1, truncated: false }, status: { s: 'read', extraction: READS[0], choices: { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} } } }] };
    const JUNK = [null, 0, -1, 'x', true, [], {}, 1e308];
    for (let seed = 1; seed <= 200; seed++) {
      const r = mulberry32(seed);
      const state = JSON.parse(JSON.stringify(read));
      // Retype or drop one value somewhere in the state.
      const paths: Array<[Record<string, unknown>, string]> = [];
      const walk = (o: unknown) => {
        if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { paths.push([o as Record<string, unknown>, k]); walk(v); }
      };
      walk(state);
      const [at, key] = paths[Math.floor(r() * paths.length)];
      if (r() < 0.3) delete at[key]; else at[key] = JUNK[Math.floor(r() * JUNK.length)];
      const text = JSON.stringify(state);
      for (const answer of [uploadViewJson(text, RECORD_TEXT, NOW, true), uploadSavePlanJson(text, RECORD_TEXT, NOW, true), uploadUsageJson(text),
        uploadStepJson(text, JSON.stringify({ type: 'chose', id: 'f', now: NOW, change: { tick: 'v0', on: false } }), RECORD_TEXT)]) {
        const parsed = JSON.parse(answer);
        if (parsed.ok === false) expect(['invalid-state', 'engine-error']).toContain(parsed.reason);
      }
    }
  });
});

describe('upload view cost (shared upload PR 12)', () => {
  it('uploadViewJson for 200 read ten-value reports stays well inside a phone frame budget in Node', () => {
    const values = Array.from({ length: 10 }, (_, i) => core(['ldl', 'hdl', 'triglycerides', 'total_cholesterol', 'apob', 'hba1c', 'creatinine', 'psa', 'lpa', 'ldl'][i], 1 + i / 10));
    const files = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`, name: `r${i}.pdf`, bytes: 1, hash: `h${i}`, pages: { count: 1, truncated: false },
      status: { s: 'read', extraction: { ...READS[0], reportDate: `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, values, additionalValues: [] }, choices: { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} } },
    }));
    const state = JSON.stringify({ phase: 'open', platform: 'phone', run: 1, started: NOW, firstRead: NOW, files });
    uploadViewJson(state, RECORD_TEXT, NOW, true); // warm the record read
    const runs = 5;
    const start = performance.now();
    for (let i = 0; i < runs; i++) expect(JSON.parse(uploadViewJson(state, RECORD_TEXT, NOW, true)).summary).toMatch(/^200 files/);
    const ms = (performance.now() - start) / runs;
    expect(ms).toBeLessThan(1500);
  });
});
