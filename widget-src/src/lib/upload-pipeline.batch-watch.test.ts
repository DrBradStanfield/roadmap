// Ledger H43 pins: the batch watch as its caller sees it, written before the watch
// became one named state (lib/batch-watch.ts). A cancel at each step (US-12 AC5a),
// an error beside results (AC24), and each result on its own file (AC9).
// The real poll client; only fetch and the clock are synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthUploadAPI } from '../upload-entry';
import { processBatch, UploadError, type FileNotice } from './upload-pipeline';

const N = 4;
const upload = {
  isPdf: () => true,
  isImage: () => false,
  extractFromPdf: vi.fn(async (file: File) => ({ pages: [{ type: 'text' as const, content: file.name }], truncated: false })),
} as unknown as HealthUploadAPI;
const queue = Array.from({ length: N }, (_, i) => `r${i}.pdf`)
  .map(fileName => ({ fileName, getFile: async () => new File(['x'], fileName, { type: 'application/pdf' }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
/** A result that names its file only by its report date. */
const read = (i: number) => ({ classification: 'lab_report', reportDate: `2026-01-0${i + 1}`, values: [], additionalValues: [], document: null });
const ended = (results: unknown[], extra: object = {}) => json({ status: 'ended', completed: N, total: N, results, ...extra });
const allRead = () => ended(Array.from({ length: N }, (_, index) => ({ index, ...read(index) })));
const processing = () => json({ status: 'processing', completed: 1, total: N });

let polls: number;
let submitted: number;
/** The batch POST answers `submit()`; each poll gets the next answer, the last repeating. */
function script(submit: () => Promise<Response> | Response, ...answers: Array<() => Promise<Response> | Response>) {
  polls = 0;
  submitted = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (String(init?.body).includes('"batch":true')) {
      submitted++;
      return submit();
    }
    return answers[Math.min(polls++, answers.length - 1)]();
  }));
}
const accepted = () => json({ success: true, batchId: 'batch_1', pollToken: 'tok-1' });

let shown: string[];
let notices: FileNotice[];
let settled: unknown;
function run(abort = new AbortController()) {
  shown = [];
  notices = [];
  settled = undefined;
  const outcome = processBatch(upload, queue, abort, p => { shown.push(p.fileName); }, notices);
  outcome.then(r => { settled = r; }, (error: unknown) => { settled = error; });
  return outcome;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('H43, US-12 AC5a: a cancel at each step of the watch', () => {
  it('during the sleep: returns [], starts no poll and shows no progress after the abort', async () => {
    script(accepted, allRead);
    const abort = new AbortController();
    const outcome = run(abort);
    await vi.advanceTimersByTimeAsync(2000); // mid-sleep, before the first poll
    expect(submitted).toBe(1);
    expect(polls).toBe(0);
    abort.abort();
    const shownAtAbort = shown.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toEqual([]);
    expect(polls).toBe(0);
    expect(shown).toHaveLength(shownAtAbort);
  });

  it.each([
    ['ended with results: the results come back', allRead, (r: unknown) => expect(r).toHaveLength(N)],
    ['ended with an error: it rejects', () => ended([], { error: 'Batch failed', errorCode: 'server_error' }),
      (r: unknown) => expect(r).toBeInstanceOf(UploadError)],
    ['still processing: returns []', processing, (r: unknown) => expect(r).toEqual([])],
    ['a transient error: returns []', () => json({ status: 'error', completed: 0, total: N }), (r: unknown) => expect(r).toEqual([])],
  ] as const)('while a poll is in flight, %s, and no poll follows', async (_, answer, outcomeIs) => {
    let answerPoll!: () => void;
    script(accepted, () => new Promise<Response>(resolve => { answerPoll = () => resolve(answer()); }));
    const abort = new AbortController();
    run(abort);
    await vi.advanceTimersByTimeAsync(5000 + 100);
    expect(polls).toBe(1);
    abort.abort();
    answerPoll();
    await vi.advanceTimersByTimeAsync(60_000);
    outcomeIs(settled);
    expect(polls).toBe(1);
  });

  it('during submit: returns [] and starts no poll', async () => {
    let answerSubmit!: () => void;
    script(() => new Promise<Response>(resolve => { answerSubmit = () => resolve(accepted()); }), allRead);
    const abort = new AbortController();
    const outcome = run(abort);
    await vi.advanceTimersByTimeAsync(100);
    expect(submitted).toBe(1);
    abort.abort();
    answerSubmit();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await outcome).toEqual([]);
    expect(polls).toBe(0);
  });
});

describe('H43, US-12 AC24: an error beside results', () => {
  it('an `ended` with both results and an error rejects with that error', async () => {
    script(accepted, () => ended([{ index: 0, ...read(0) }], { error: 'Batch failed', errorCode: 'server_restart' }));
    const outcome = run();
    outcome.catch(() => {});
    await vi.advanceTimersByTimeAsync(5000 + 100);
    await expect(outcome).rejects.toMatchObject({ message: 'Batch failed', code: 'server_restart' });
  });
});

describe('H43, US-12 AC9: each result lands on its own file', () => {
  async function results(answer: () => Response) {
    script(accepted, answer);
    const outcome = run();
    await vi.advanceTimersByTimeAsync(5000 + 100);
    return outcome;
  }

  it('results out of order land on the file their index names', async () => {
    const got = await results(() => ended([3, 1, 0, 2].map(index => ({ index, ...read(index) }))));
    expect(got.map(r => [r.fileName, r.reportDate, r.error])).toEqual([
      ['r0.pdf', '2026-01-01', undefined], ['r1.pdf', '2026-01-02', undefined],
      ['r2.pdf', '2026-01-03', undefined], ['r3.pdf', '2026-01-04', undefined],
    ]);
    expect(got.map(r => (r.file as File | undefined)?.name)).toEqual(['r0.pdf', 'r1.pdf', 'r2.pdf', 'r3.pdf']);
  });

  it('a missing index or an `errorCode` gives an unread row under that file\'s name', async () => {
    const got = await results(() => ended([{ index: 0, ...read(0) }, { index: 2, errorCode: 'refused' }, { index: 3, ...read(3) }]));
    expect(got.map(r => [r.fileName, r.reportDate, r.error])).toEqual([
      ['r0.pdf', '2026-01-01', undefined], ['r1.pdf', null, 'Extraction failed'],
      ['r2.pdf', null, 'Extraction failed'], ['r3.pdf', '2026-01-04', undefined],
    ]);
    expect(notices).toEqual([
      { name: 'r1.pdf', reason: 'serverError', text: undefined },
      { name: 'r2.pdf', reason: 'refused', text: undefined },
    ]);
  });

  it('an old server with no index reads by order when the counts match', async () => {
    const got = await results(() => ended(Array.from({ length: N }, (_, i) => read(i))));
    expect(got.map(r => r.reportDate)).toEqual(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04']);
  });

  it('an old server with no index and a count that differs marks every file unread', async () => {
    const got = await results(() => ended([read(0), read(1), read(2)]));
    expect(got.map(r => [r.fileName, r.error])).toEqual(queue.map(q => [q.fileName, 'Extraction failed']));
  });
});
