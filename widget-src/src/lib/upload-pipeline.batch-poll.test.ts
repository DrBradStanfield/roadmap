// US-12 AC24: a failed batch poll answers `error` and never shows less progress than the last answer.
// The batch loop as its caller sees it: the real poll client, with only fetch and the clock synthetic.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HealthUploadAPI } from '../upload-entry';
import { processBatch, UploadError, type FileNotice } from './upload-pipeline';

const N = 20;
const upload = {
  isPdf: () => true,
  isImage: () => false,
  extractFromPdf: vi.fn(async (file: File) => ({ pages: [{ type: 'text' as const, content: file.name }], truncated: false })),
} as unknown as HealthUploadAPI;
const queue = Array.from({ length: N }, (_, i) => `r${i}.pdf`)
  .map(fileName => ({ fileName, getFile: async () => new File(['x'], fileName, { type: 'application/pdf' }) }));

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const processing = (completed: number) => json({ status: 'processing', completed, total: N });
const ended = () => json({ status: 'ended', completed: N, total: N, results: Array.from({ length: N }, (_, index) => (
  { index, classification: 'lab_report', reportDate: null, values: [], additionalValues: [], document: null })) });
const status500 = () => json({ success: false, error: 'Failed to process request' }, 500);
const networkThrow = () => { throw new TypeError('synthetic network failure'); };
/** Headers arrive, then the connection drops while the body streams. */
const bodyDrop = () => new Response(new ReadableStream({
  start(c) { c.enqueue(new TextEncoder().encode('{"status":')); c.error(new TypeError('synthetic connection drop')); },
}), { headers: { 'content-type': 'application/json' } });

let polls: number;
/** The batch POST is accepted; each poll gets the next scripted answer, the last one repeating. */
function script(...answers: Array<() => Response>) {
  polls = 0;
  vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
    if (String(init?.body).includes('"batch":true')) return json({ success: true, batchId: 'batch_1', pollToken: 'tok-1' });
    return answers[Math.min(polls++, answers.length - 1)]();
  }));
}

let shown: string[];
let bar: number[];
function run() {
  shown = [];
  bar = [];
  const outcome = processBatch(upload, queue, new AbortController(), p => { shown.push(p.fileName); bar.push(p.current); }, [] as FileNotice[]);
  outcome.catch(() => {});
  return outcome;
}
/** The "Processed k of N" counts, from the first one shown on: a rotating line reads as 0. */
function countsShown() {
  const first = shown.findIndex(m => m.startsWith('Processed '));
  return shown.slice(first).filter(m => m !== 'All files processed!').map(m => Number(/^Processed (\d+) of/.exec(m)?.[1] ?? 0));
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('US-12 AC24: a poll failure that can change keeps the count and polls on', () => {
  it.each([
    ['a 500 from our route', status500],
    ['a network throw', networkThrow],
    ['a connection drop while the body streams', bodyDrop],
  ])('3 of 20, then %s, then a good poll: the count never drops below 3 and the run returns results', async (_, failure) => {
    script(() => processing(3), failure, failure, ended);
    const outcome = run();
    await vi.advanceTimersByTimeAsync(4 * 5000 + 100);
    const results = await outcome;
    expect(results).toHaveLength(N);
    expect(polls).toBe(4);
    const counts = countsShown();
    expect(counts.length).toBeGreaterThan(10);
    expect(Math.min(...counts)).toBe(3);
  });

  it('errors until the deadline reject with UploadError "timeout"', async () => {
    script(() => processing(3), status500);
    const outcome = run();
    await vi.advanceTimersByTimeAsync(11 * 60_000);
    await expect(outcome).rejects.toBeInstanceOf(UploadError);
    await expect(outcome).rejects.toMatchObject({ code: 'timeout' });
    expect(polls).toBeGreaterThan(100);
  });
});

describe('US-12 AC24: a poll failure that cannot change ends the watch at once', () => {
  it.each([
    ['a 401', () => json({ error: 'Unauthorized' }, 401), 'server_error'],
    ['a 403', () => json({ success: false, error: 'Forbidden' }, 403), 'server_error'],
    ['a 404 (unknown batch or bad poll token)', () => json({ error: 'Batch not found' }, 404), 'server_restart'],
    ['a malformed answer', () => new Response('<html>synthetic</html>', { headers: { 'content-type': 'text/html' } }), 'server_error'],
    ['an answer with no `completed`', () => json({ status: 'processing', total: N }), 'server_error'],
    ['a NaN count (JSON carries it as null)', () => json({ status: 'processing', completed: NaN, total: N }), 'server_error'],
    ['a negative count', () => json({ status: 'error', completed: -1, total: N }), 'server_error'],
    ['an `ended` with neither results nor an error', () => json({ status: 'ended', completed: N, total: N }), 'server_error'],
  ] as const)('%s rejects after one poll and no more, and the bar never reads NaN', async (_, failure, code) => {
    script(failure, () => processing(3));
    let settled: unknown;
    run().then(() => { settled = 'resolved'; }, (error: unknown) => { settled = error; });
    await vi.advanceTimersByTimeAsync(5000 + 100);
    expect(settled).toBeInstanceOf(UploadError);
    expect(settled).toMatchObject({ code });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toBe(1);
    expect(bar.filter(Number.isNaN)).toEqual([]);
  });
});

/**
 * Stands in for one turn of processBatch's poll loop as shipped before this fix (24f52596^, upload-pipeline.ts
 * :349-352): it set its count from every answer, threw on `error` text, finished on `ended` with results and
 * polled on for anything else. Copied, not imported: the deploy window serves that widget against this server.
 */
function oldWidgetTurn(poll: { status: string; completed?: number; total?: number; error?: string; results?: unknown[] }, fake = 35) {
  const realCompleted = poll.completed as number;
  const next = poll.error ? 'throw' : poll.status === 'ended' && poll.results ? 'done' : 'poll';
  return { next, realCompleted, bar: Math.round(Math.max(fake, (realCompleted / N) * 100)) };
}

describe('US-12 AC24: a widget from before the fix, given the server\'s new `error` answer', () => {
  it('polls on with a count of 3, never NaN', () => {
    expect(oldWidgetTurn({ status: 'error', completed: 3, total: N })).toEqual({ next: 'poll', realCompleted: 3, bar: 35 });
  });
  it('would read NaN were `completed` left out, which is why the server sends it', () => {
    expect(oldWidgetTurn({ status: 'error', total: N }).bar).toBeNaN();
  });
});
