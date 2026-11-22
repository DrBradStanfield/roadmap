// Shared upload PR 12 (US-52 AC8c): the upload doors agree with health-core, as a caller sees them.
// Seeded event sequences (mulberry32, the upload-flow.property.test.ts pattern) drive the step door
// and, beside it, health-core's transition with the same event made whole by health-core's own
// rules; after each step the view, save plan and usage doors answer exactly as health-core does.
// Malformed input answers the refusal and never throws. Synthetic rows, names and hashes only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadSavePlanJson, uploadStartJson, uploadStepJson, uploadUsageJson, uploadViewJson } from './entry';
import { createEmptyFile, type FileDocument, type RoadmapFile } from '../../packages/health-core/src/roadmap-file';
import { bulkAppendValues, type BulkRow } from '../../packages/health-core/src/record-edits';
import { initialUpload, transition, uploadFileName, type UploadEvent, type UploadState } from '../../packages/health-core/src/upload-flow';
import { knownAs, knownIndex, readIsLegacy } from '../../packages/health-core/src/upload-known';
import { appGateFailure } from '../../packages/health-core/src/upload-failure';
import { lostReplaces, uploadReview } from '../../packages/health-core/src/upload-review';
import { uploadView } from '../../packages/health-core/src/upload-view';
import { uploadSavePlan } from '../../packages/health-core/src/upload-plan';
import { uploadUsageCounts } from '../../packages/health-core/src/upload-usage';
import type { UnifiedExtractionResult } from '../../packages/health-core/src/lab-extraction';
import { labStreamAnswer } from '../../packages/health-core/src/upload-answer';
import { UPLOAD_STATE } from '../../packages/health-core/src/upload-schema';
import { REFUSAL_WORDS, UPLOAD_REFUSAL_REASONS } from './upload-doors';
import { TOO_NEW_RECORD } from './my-data';

const NOW = '2026-11-02T00:00:00.000Z';
const DAY = '2026-11-01';
const DEV = 'phone';

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
/** A failed send as the app saw it: the app gate's refusals among them (US-52 AC7e). */
const SEND_ANSWERS: Array<{ status: number | null; body: string | null; contentType: string | null }> = [
  { status: null, body: null, contentType: null },
  { status: 429, body: '{"code":"busy"}', contentType: 'application/json' },
  { status: 429, body: '{}', contentType: 'application/json' },
  { status: 429, body: '{"success":false,"error":"Daily limit reached. Please try again tomorrow.","reason":"limit"}', contentType: 'application/json' },
  { status: 422, body: '{"errorCode":"too_long"}', contentType: 'application/json; charset=utf-8' },
  { status: 422, body: '{nope', contentType: 'application/json' },
  { status: 502, body: '<html>', contentType: 'text/html' },
  { status: 200, body: '{"success":false}', contentType: 'application/json' },
  { status: 401, body: '{"success":false,"error":"This request was not signed by the app.","reason":"bad_signature"}', contentType: 'application/json' },
  { status: 413, body: '{"success":false,"error":"Request too large","reason":"too_large"}', contentType: 'application/json' },
  { status: 400, body: '{"success":false,"error":"Invalid request"}', contentType: 'application/json' },
  { status: 503, body: '{"success":false,"error":"This is not available right now. Please try again later.","reason":"unavailable"}', contentType: 'application/json' },
];
/** A send with no lab-read answer, as the phone saw it, and what the engine makes of it (an oracle written out, not computed). */
const LOCALS = [
  [{ kind: 'cannotAttest' }, { failure: 'cannot_attest' }],
  [{ kind: 'attestFailed', stage: 'assert', code: '3' }, { failure: 'attest_failed', detail: { stage: 'assert', code: '3' } }],
  [{ kind: 'refused', status: 429, message: ' The app could not be registered. ' }, { failure: 'app_refused', detail: { message: 'The app could not be registered.' } }],
  [{ kind: 'refused', status: 503, message: 'Busy' }, { failure: 'server_error', detail: { message: 'Busy' } }],
  [{ kind: 'badAnswer' }, { failure: 'app_refused', detail: { message: "The server's answer could not be read." } }],
  [{ kind: 'timeout' }, { failure: 'network', detail: { network: 'timeout' } }],
  [{ kind: 'dropped' }, { failure: 'network', detail: { network: 'dropped' } }],
  [{ kind: 'unreachable' }, { failure: 'network', detail: { network: 'unreachable' } }],
] as const;
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
      const file = files.find((f) => f.id === id); const name = file && uploadFileName(file);
      return { wire: { type: 'answered', run, id, extraction, now: NOW },
        whole: { type: 'answered', run, id, extraction, now: NOW, legacy: name !== undefined && readIsLegacy(RECORD, name, extraction) } };
    }],
    [4, () => {
      const id = idAt('sending');
      const line = pick([JSON.stringify({ status: 200, body: { success: true, data: pick(READS) } }), JSON.stringify({ status: 429, body: { success: false } }),
        JSON.stringify({ status: 422, body: { errorCode: 'refused' } }), JSON.stringify({ status: 500, body: { success: false, error: 'Failed to process request' } }), null, '{cut']);
      const a = labStreamAnswer(line);
      const file = files.find((f) => f.id === id); const name = file && uploadFileName(file);
      return { wire: { type: 'streamEnded', run, id, line, now: NOW }, whole: 'extraction' in a
        ? { type: 'answered', run, id, extraction: a.extraction, legacy: name !== undefined && readIsLegacy(RECORD, name, a.extraction), now: NOW }
        : { type: 'sendFailed', run, id, failure: a.failure, ...(a.detail ? { detail: a.detail } : {}) } };
    }],
    [2, () => {
      const id = idAt('sending');
      const answer = pick(SEND_ANSWERS);
      return { wire: { type: 'sendFailed', run, id, ...answer }, whole: { type: 'sendFailed', run, id, ...appGateFailure(answer.status, answer.body, answer.contentType) } };
    }],
    [1, () => {
      const id = idAt('sending');
      const [local, made] = pick(LOCALS);
      return { wire: { type: 'sendFailed', run, id, status: null, body: null, contentType: null, local }, whole: { type: 'sendFailed', run, id, ...made } as UploadEvent };
    }],
    [2, () => same({ type: 'retry', id: coin(0.5) ? 'all' : idAt('failed') })],
    [1, () => same({ type: 'stop' })],
    [6, () => same({ type: 'chose', now: NOW, id: idAt('read'), change: pick([
      { tick: 'v0', on: coin(0.5) }, { tick: 'a0', on: coin(0.5) }, { testDay: pick([DAY, '2026-10-01', null]) },
      { replace: 'v0', correctsId: coin(0.5) ? HELD_ID : null }, { edit: 'v1', value: coin(0.5) ? 1.4 : null },
      { document: { title: 'Fixed title', date: pick(['2026-02-01', null, '2999-01-01']) } },
    ]) })],
    // The app echoes what the page it showed would write (the view's `reviewed`), opaque; the door adds nothing.
    [3, () => (r() < 0.5 ? same({ type: 'saveStarted' }) : same({ type: 'saveStarted', reviewed: [{ file: 'f', ref: 'v0', lab: false }] }))],
    [2, () => same({ type: 'saved', run, attempt: 'attempt' in s ? s.attempt : 1, outcome: { values: 1, documents: 0, archived: 0 } })],
    [1, () => same({ type: 'saveFailed', run, attempt: 'attempt' in s ? s.attempt : 1, message: 'Could not save.' })],
    [1, () => same({ type: 'close' })],
    [1, () => same({ type: 'discard' })],
  ];
  let w = r() * kinds.reduce((n, [k]) => n + k, 0);
  for (const [k, make] of kinds) if ((w -= k) < 0) return make();
  return kinds[0][1]();
}

/** A Replace whose target no longer holds its slot on RECORD, dropped and its value unticked, as the doors do. */
function withoutLost(s: UploadState): UploadState {
  const lost = lostReplaces(uploadReview(s, RECORD, new Date().toISOString()), s);
  return lost.length ? transition(s, { type: 'replacesLost', lost }).state : s;
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
        // The doors drop a Replace whose target left its slot before each event and in each view (replacesLost).
        s = withoutLost(s);
        const { wire, whole } = genEvent(r, s, mint);
        events.push(wire);
        const where = `seed ${seed} step ${i}: ${JSON.stringify(events.map((e) => e.type))}`;
        const direct = transition(s, whole);
        const step = JSON.parse(uploadStepJson(JSON.stringify(s), JSON.stringify(wire), RECORD_TEXT, DEV));
        expect(step, where).toEqual(direct);
        expect(UPLOAD_STATE.safeParse(step.state).success, where).toBe(true);
        s = direct.state;
        const shown = withoutLost(s);
        const cloud = r() < 0.5;
        const review = uploadReview(shown, RECORD, NOW);
        const view = uploadView(shown, RECORD, NOW, review, cloud);
        const plan = uploadSavePlan(shown, RECORD, NOW, review, cloud);
        expect(JSON.parse(uploadViewJson(JSON.stringify(s), RECORD_TEXT, NOW, cloud, DEV)), where).toEqual(JSON.parse(JSON.stringify({ ...view, engineError: REFUSAL_WORDS['engine-error'] })));
        expect(JSON.parse(uploadSavePlanJson(JSON.stringify(s), RECORD_TEXT, NOW, cloud, DEV)), where).toEqual(JSON.parse(JSON.stringify(plan)));
        expect(JSON.parse(uploadUsageJson(JSON.stringify(s))), where).toEqual(uploadUsageCounts(s));
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

  it('the engine fills known itself; known, legacy or failure from the app is refused, never run (review R2)', () => {
    const open = transition(initialUpload('phone'), { type: 'picked', needsConsent: false, now: NOW, files: [{ id: 'f', name: 'a.pdf', bytes: 1, kind: 'file' }] }).state;
    const step = JSON.parse(uploadStepJson(JSON.stringify(open), JSON.stringify({ type: 'hashed', run: 1, id: 'f', hash: 'h-held' }), RECORD_TEXT, DEV));
    expect(step.state.files[0].status).toEqual({ s: 'known', as: 'document', archiveOnly: false });
    expect(JSON.parse(uploadStepJson(JSON.stringify(open), JSON.stringify({ type: 'hashed', run: 1, id: 'f', hash: 'h-held', known: null }), RECORD_TEXT, DEV)).reason).toBe('invalid-event');
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
      expect(refusal(uploadStepJson(bad, '{"type":"stop"}', '', DEV)), bad).toBe('invalid-state');
      expect(refusal(uploadViewJson(bad, '', NOW, true, DEV)), bad).toBe('invalid-state');
      expect(refusal(uploadSavePlanJson(bad, '', NOW, false, DEV)), bad).toBe('invalid-state');
      expect(refusal(uploadUsageJson(bad)), bad).toBe('invalid-state');
    }
    for (const bad of ['', '{', '{"type":"teleport"}', '{"type":"hashed","run":1,"id":"f"}', '{"type":"sendFailed","run":1,"id":"f","failure":"busy"}', '{"type":"answered","run":1,"id":"f","now":"x","extraction":{"values":"many"}}']) {
      expect(refusal(uploadStepJson(JSON.stringify(OPEN), bad, '', DEV)), bad).toBe('invalid-event');
    }
    expect(refusal(uploadStepJson(JSON.stringify(OPEN), '{"type":"hashed","run":1,"id":"f","hash":"h"}', '{not json', DEV))).toBe('invalid-record');
    expect(refusal(uploadViewJson(JSON.stringify(OPEN), '[1]', NOW, true, DEV))).toBe('invalid-record');
  });

  // Review R2 (Codex): what runs is what was checked. A change naming two kinds, or one with a wrong
  // type, matches no strict branch and is refused; every step that answers gives a state the schema takes.
  it('adversarial events: conflicting keys and wrong types are refused; every answered step is a valid state', () => {
    const read = { ...OPEN, files: [{ id: 'f', name: 'a.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false },
      status: { s: 'read', extraction: READS[0], choices: { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} } } }] };
    const chose = (change: unknown) => uploadStepJson(JSON.stringify(read), JSON.stringify({ type: 'chose', id: 'f', now: NOW, change }), RECORD_TEXT, DEV);
    for (const change of [{ tick: 'v0', on: 'no', testDay: null }, { tick: 'v0', on: true, testDay: null }, { testDay: null, previousDay: null },
      { edit: 'v0', value: '3' }, { replace: 'v0', correctsId: 1 }, { document: { title: 'T', colour: 'red' } }, { tick: 'v0' }, {}]) {
      expect(refusal(chose(change)), JSON.stringify(change)).toBe('invalid-event');
    }
    const events: unknown[] = [
      { type: 'stop', extra: 1 }, { type: 'retry', id: 7 }, { type: 'converted', run: 1, id: 'f', pages: -1, truncated: false },
      { type: 'picked', files: [{ id: 'x', name: 'x', bytes: 1, kind: 'folder' }], needsConsent: false, now: NOW },
      { type: 'streamEnded', run: 1, id: 'f', line: 5, now: NOW }, { type: 'sendFailed', run: 1, id: 'f', status: '429', body: null, contentType: null },
      // US-52 AC7e: the phone's App Attest outcome is a short step and code, nothing more; never `detail` from the app.
      { type: 'sendFailed', run: 1, id: 'f', status: null, body: null, contentType: null, local: { kind: 'attestFailed', stage: 'assert', code: 'com.apple 3' } },
      { type: 'sendFailed', run: 1, id: 'f', status: null, body: null, contentType: null, local: { kind: 'cannotAttest', stage: 'x' } },
      { type: 'sendFailed', run: 1, id: 'f', status: null, body: null, contentType: null, detail: { message: 'x' } },
      { type: 'answered', run: 1, id: 'f', now: NOW, extraction: { ...READS[0], additionalValues: [{ name: 'Ferritin', value: 80, unit: 'u', referenceLow: 'x' }] } },
    ];
    for (const e of events) expect(refusal(uploadStepJson(JSON.stringify(read), JSON.stringify(e), RECORD_TEXT, DEV)), JSON.stringify(e)).toBe('invalid-event');
    for (const change of [{ tick: 'v0', on: false }, { testDay: '2026-10-01' }, { document: { title: 'T' } }]) {
      const answer = JSON.parse(chose(change));
      expect(UPLOAD_STATE.safeParse(answer.state).success, JSON.stringify(change)).toBe(true);
    }
  });

  it('a bad reference bound in a streamed read never reaches the state or a save plan (review R1)', () => {
    const sending = { ...OPEN, files: [{ id: 'f', name: 'a.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false }, status: { s: 'sending', attempt: 1 } }] };
    const bad = { ...READS[0], additionalValues: [{ name: 'Ferritin', value: 80, unit: 'u', referenceLow: 'x' }] };
    const line = JSON.stringify({ status: 200, body: { success: true, data: bad } });
    const step = JSON.parse(uploadStepJson(JSON.stringify(sending), JSON.stringify({ type: 'streamEnded', run: 1, id: 'f', line, now: NOW }), RECORD_TEXT, DEV));
    expect(step.state.files[0].status).toEqual({ s: 'failed', reason: 'server', attempt: 1 });
    expect(JSON.parse(uploadSavePlanJson(JSON.stringify(step.state), RECORD_TEXT, NOW, true, DEV)).counts.values).toBe(0);
  });

  it('streamEnded: a daily-limit 429 stops the run; no last line is a retryable network failure (review R1)', () => {
    const two = { ...OPEN, files: [
      { id: 'f', name: 'a.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false }, status: { s: 'sending', attempt: 1 } },
      { id: 'g', name: 'b.pdf', bytes: 1, hash: 'g', pages: null, status: { s: 'hashed' } }] };
    const end = (line: string | null) => JSON.parse(uploadStepJson(JSON.stringify(two), JSON.stringify({ type: 'streamEnded', run: 1, id: 'f', line, now: NOW }), RECORD_TEXT, DEV)).state.files;
    expect(end(JSON.stringify({ status: 429, body: { success: false } })).map((f: { status: { reason?: string } }) => f.status.reason)).toEqual(['dailyLimit', 'dailyLimit']);
    expect(end(null)[0].status).toEqual({ s: 'failed', reason: 'network', attempt: 1 });
    expect(end(JSON.stringify({ status: 422, body: { errorCode: 'refused' } }))[0].status).toEqual({ s: 'failed', reason: 'declined', attempt: 1 });
  });

  it('a record a newer app wrote is refused in readRecord\'s words, apart from an unreadable one (review R4)', () => {
    const tooNew = JSON.stringify({ ...RECORD, schemaVersion: 999 });
    const answer = JSON.parse(uploadViewJson(JSON.stringify(OPEN), tooNew, NOW, true, DEV));
    expect(answer).toEqual({ ok: false, reason: 'record-too-new', message: TOO_NEW_RECORD });
    expect(UPLOAD_REFUSAL_REASONS).toContain('record-too-new');
  });

  it('the refusal names no part of what it was given', () => {
    const text = uploadStepJson(JSON.stringify({ ...OPEN, files: [{ id: 'secret-name.pdf', hash: 'sha256-secret' }] }), '{}', '', DEV);
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
      for (const answer of [uploadViewJson(text, RECORD_TEXT, NOW, true, DEV), uploadSavePlanJson(text, RECORD_TEXT, NOW, true, DEV), uploadUsageJson(text),
        uploadStepJson(text, JSON.stringify({ type: 'chose', id: 'f', now: NOW, change: { tick: 'v0', on: false } }), RECORD_TEXT, DEV)]) {
        const parsed = JSON.parse(answer);
        if (parsed.ok === false) expect(['invalid-state', 'engine-error']).toContain(parsed.reason);
      }
    }
  });
});

describe('a send that failed, through the step door: each answer\'s reason and words, written out (US-52 AC7e)', () => {
  const sending = JSON.stringify({
    phase: 'open', platform: 'phone', run: 1, started: NOW, firstRead: null,
    files: [{ id: 'f', name: 'f.pdf', bytes: 1, hash: 'h', pages: { count: 1, truncated: false }, status: { s: 'sending', attempt: 1 } }],
  });
  const json = 'application/json';
  const cases: Array<[number | null, string | null, string | null, unknown]> = [
    [401, '{"success":false,"error":"This request was not signed by the app.","reason":"bad_signature"}', json, { s: 'failed', reason: 'appRefused', attempt: 1, detail: { message: 'This request was not signed by the app.' } }],
    [413, '{"success":false,"error":"Request too large","reason":"too_large"}', json, { s: 'failed', reason: 'tooLarge', attempt: 1, detail: { message: 'Request too large' } }],
    [400, '{"success":false,"error":"The request did not arrive whole. Please try again.","reason":"body_read_failed"}', json, { s: 'failed', reason: 'network', attempt: 1, detail: { message: 'The request did not arrive whole. Please try again.' } }],
    [400, '{"success":false,"error":"Invalid request"}', json, { s: 'failed', reason: 'appRefused', attempt: 1, detail: { message: 'Invalid request' } }],
    [429, '{"success":false,"error":"Daily limit reached. Please try again tomorrow.","reason":"limit"}', json, { s: 'failed', reason: 'dailyLimit', attempt: 1, detail: { message: 'Daily limit reached. Please try again tomorrow.' } }],
    [503, '{"success":false,"error":"This is not available right now. Please try again later.","reason":"unavailable"}', json, { s: 'failed', reason: 'server', attempt: 1, detail: { message: 'This is not available right now. Please try again later.' } }],
    [502, '<html>', 'text/html', { s: 'failed', reason: 'server', attempt: 1 }],
    [null, null, null, { s: 'failed', reason: 'network', attempt: 1 }],
  ];
  it('a refused registration\'s over-long words are cut by the engine, never a reason to refuse the event (Codex re-check)', () => {
    const message = '👨‍👩‍👧'.repeat(1001); // 5 code points, 8 UTF-16 units each
    const step = JSON.parse(uploadStepJson(sending, JSON.stringify({ type: 'sendFailed', run: 1, id: 'f', status: null, body: null, contentType: null, local: { kind: 'refused', status: 503, message } }), RECORD_TEXT, DEV));
    expect(step.state.files[0].status).toEqual({ s: 'failed', reason: 'server', attempt: 1, detail: { message: '👨‍👩‍👧'.repeat(25) } });
  });
  for (const [status, body, contentType, want] of cases) {
    it(`${status} ${body?.slice(0, 40)}`, () => {
      const step = JSON.parse(uploadStepJson(sending, JSON.stringify({ type: 'sendFailed', run: 1, id: 'f', status, body, contentType }), RECORD_TEXT, DEV));
      expect(step.state.files[0].status).toEqual(want);
    });
  }
});

describe('upload view cost (shared upload PR 12)', () => {
  it('uploadViewJson for 200 read ten-value reports stays well inside a phone frame budget in Node', () => {
    const values = Array.from({ length: 10 }, (_, i) => core(['ldl', 'hdl', 'triglycerides', 'total_cholesterol', 'apob', 'hba1c', 'creatinine', 'psa', 'lpa', 'ldl'][i], 1 + i / 10));
    const files = Array.from({ length: 200 }, (_, i) => ({
      id: `f${i}`, name: `r${i}.pdf`, bytes: 1, hash: `h${i}`, pages: { count: 1, truncated: false },
      status: { s: 'read', extraction: { ...READS[0], reportDate: `2025-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}`, values, additionalValues: [] }, choices: { ticks: {}, testDay: null, previousDay: null, replace: {}, edits: {}, document: {} } },
    }));
    const state = JSON.stringify({ phase: 'open', platform: 'phone', run: 1, started: NOW, firstRead: NOW, files });
    uploadViewJson(state, RECORD_TEXT, NOW, true, DEV); // warm the record read
    const runs = 5;
    const start = performance.now();
    for (let i = 0; i < runs; i++) expect(JSON.parse(uploadViewJson(state, RECORD_TEXT, NOW, true, DEV)).summary).toMatch(/^200 files/);
    const ms = (performance.now() - start) / runs;
    expect(ms).toBeLessThan(1500);
  });
});

describe('the doors drop a Replace whose target another writer took away (owner ruling 2026-11-20, US-13 AC7)', () => {
  it('a held row deleted during the review: the view shows the value unticked with no conflict, and the next step carries that', () => {
    const DAY = '2026-10-01';
    const record = bulkAppendValues(createEmptyFile({ deviceId: 'test', now: NOW }), [{ kind: 'measurement', metricType: 'ldl', value: 2.0, recordedAt: DAY, source: 'manual' }], NOW).file;
    const extraction = { classification: 'lab_report', reportDate: DAY, values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }], additionalValues: [], unrecognized: [], document: null } as UnifiedExtractionResult;
    const open: UploadState = { phase: 'open', platform: 'phone', run: 1, started: NOW, firstRead: NOW, files: [{ id: 'f', name: 'f.pdf', bytes: 1, hash: 'h-f', pages: null,
      status: { s: 'read', extraction, choices: { ticks: {}, testDay: null, previousDay: null, replace: { v0: record.labValues[0].id }, edits: {}, document: {} } } }] };
    const deleted = JSON.stringify({ ...record, labValues: record.labValues.map((l) => ({ ...l, status: 'entered-in-error' })) });
    const view = JSON.parse(uploadViewJson(JSON.stringify(open), deleted, NOW, false, DEV));
    const row = [...view.sections.flatMap((x: { kind: string; rows?: unknown[] }) => (x.kind === 'unsure' ? x.rows : [])), ...(view.sure?.rows ?? [])][0];
    expect(row).toMatchObject({ ref: 'v0', ticked: false, conflict: null, replaces: null });
    const step = JSON.parse(uploadStepJson(JSON.stringify(open), JSON.stringify({ type: 'chose', id: 'f', change: { tick: 'v0', on: true }, now: NOW }), deleted, DEV));
    expect(step.state.files[0].status.choices).toMatchObject({ replace: {}, ticks: { v0: true } });
    // With no record the app can read (''), nothing is dropped, in a step or a view (adversary R1).
    const kept0 = JSON.parse(uploadStepJson(JSON.stringify(open), JSON.stringify({ type: 'stop' }), '', DEV));
    expect(kept0.state.files[0].status.choices).toMatchObject({ replace: { v0: record.labValues[0].id }, ticks: {} });
    // Nor with one that will not read: the door drops nothing, as for '' (health-core `dropLostReplaces`, web list PR 1a).
    const unread = JSON.parse(uploadStepJson(JSON.stringify(open), JSON.stringify({ type: 'stop' }), '{', DEV));
    expect(unread.state.files[0].status.choices).toMatchObject({ replace: { v0: record.labValues[0].id }, ticks: {} });
    const blind = JSON.parse(uploadViewJson(JSON.stringify(open), '', NOW, false, DEV));
    expect([...blind.sections.flatMap((x: { kind: string; rows?: unknown[] }) => (x.kind === 'unsure' ? x.rows : [])), ...(blind.sure?.rows ?? [])][0]).toMatchObject({ ticked: true });
    // With the target still there, nothing changes.
    const kept = JSON.parse(uploadViewJson(JSON.stringify(open), JSON.stringify(record), NOW, false, DEV));
    expect(kept.sections.find((x: { kind: string }) => x.kind === 'unsure').rows[0]).toMatchObject({ replacing: true });
  });
});
