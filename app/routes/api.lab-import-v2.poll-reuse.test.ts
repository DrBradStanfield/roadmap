/** US-12 AC18 / US-15 AC34: real action, proxy HMAC and Anthropic parser.
 * Only fetch and telemetry cross a synthetic boundary. No live data or network. */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const SECRET = 'synthetic-proxy-secret';
const MIN = 60_000;
let action: typeof import('./api.lab-import-v2').action;
let nextId: number;
let ended: boolean;
let fetchMock: ReturnType<typeof vi.fn>;
const lines = [JSON.stringify({ custom_id: 'file-0', result: { type: 'succeeded', message: {
  content: [], stop_reason: 'refusal', stop_details: { category: 'bio' },
} } })];

function request(body: object, timestamp = Date.now() / 1000, valid = true) {
  const query = new URLSearchParams({ shop: 'synthetic.myshopify.com', timestamp: String(timestamp) });
  const message = [...query].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('');
  query.set('signature', valid ? crypto.createHmac('sha256', SECRET).update(message).digest('hex') : '0'.repeat(64));
  return new Request(`https://synthetic.test/api/lab-import-v2?${query}`, {
    method: 'POST', headers: { 'fly-client-ip': `10.0.0.${nextId}` }, body: JSON.stringify(body),
  });
}
const call = (body: object) => action({ request: request(body) } as never);
async function upload(flags: object = {}) {
  const response = await call({ batch: true, files: [{ pages: [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }] }], ...flags });
  expect(response.status).toBe(200);
  return response.json() as Promise<{ batchId: string; pollToken: string }>;
}
const reads = () => fetchMock.mock.calls.filter(([, init]) => !init?.method).length;
const statusResponse = () => Response.json({ ended_at: ended ? '2026-10-20T00:00:00Z' : null,
  request_counts: { processing: ended ? 0 : 1, succeeded: ended ? 1 : 0 } });

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-10-20T00:00:00Z'));
  vi.stubEnv('SHOPIFY_API_SECRET', SECRET);
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-provider-key');
  nextId = 0;
  ended = true;
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ id: `batch_${++nextId}` });
    if (init?.method === 'DELETE') return new Response(null, { status: 204 });
    return url.endsWith('/results') ? new Response(lines.join('\n')) : statusResponse();
  });
  vi.stubGlobal('fetch', fetchMock);
  ({ action } = await import('./api.lab-import-v2'));
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('US-12 AC18: capability-safe in-flight reuse and value-free pacing', () => {
  it('retains no terminal health payload or settled flight on the batch entry (constitution)', async () => {
    const set = vi.spyOn(Map.prototype, 'set');
    let batch: Awaited<ReturnType<typeof upload>>;
    let entry: { pollResult?: unknown; pollInFlight?: unknown } | undefined;
    try {
      batch = await upload();
      entry = set.mock.calls.find(([id, value]) => id === batch.batchId && value?.pollToken === batch.pollToken)?.[1];
    } finally {
      set.mockRestore();
    }
    expect(entry).toBeDefined();
    const marker = 'synthetic-retention-marker';
    const text = JSON.stringify({ classification: 'lab_report', reportDate: '2026-10-10', document: null,
      values: [], additionalValues: [{ name: marker, value: 80, unit: 'ug/L' }],
    });
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/results')
      ? new Response(JSON.stringify({ custom_id: 'file-0', result: { type: 'succeeded', message: { content: [{ type: 'text', text }] } } }))
      : statusResponse());
    const answers = await Promise.all(Array.from({ length: 3 }, async () => (await call(batch)).json()));
    for (const answer of answers) {
      expect(answer.status).toBe('ended');
      expect(answer.results[0].additionalValues[0].name).toBe(marker);
    }
    expect(entry?.pollInFlight).toBeUndefined();
    expect(entry?.pollResult).toBeUndefined();
    expect(JSON.stringify(entry)).not.toContain(marker);
    expect(reads()).toBe(2);
  });
  it.each(['status', 'results'])('clears a rejected %s flight so every waiter settles and an immediate retry can succeed', async stage => {
    ended = false;
    const batch = await upload();
    expect(await (await call(batch)).json()).toEqual({ status: 'processing', completed: 0, total: 1 });
    await vi.advanceTimersByTimeAsync(2000);
    ended = true;
    let reject!: (reason: Error) => void;
    const gate = new Promise<Response>((_, fail) => { reject = fail; });
    if (stage === 'results') fetchMock.mockImplementationOnce(async () => statusResponse());
    fetchMock.mockImplementationOnce(() => gate);
    const polls = Array.from({ length: 5 }, () => call(batch));
    await vi.waitFor(() => expect(reads()).toBe(stage === 'status' ? 2 : 3));
    reject(new TypeError('synthetic fetch rejection'));
    for (const response of await Promise.all(polls)) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'processing', completed: 0, total: 1 });
    }
    const before = reads();
    expect(await (await call(batch)).json()).toMatchObject({ status: 'ended', results: [{ index: 0, errorCode: 'refused' }] });
    expect(reads()).toBe(before + 2);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, 1, 1, 1],
    [{ ownDates: true }, 2, 2, 2],
    [{ ownDates: true, undatedPrev: true, refusedRows: true }, 3, 3, 0],
  ] as const)('keeps the upload projection on every re-read retry, ignoring poll flags: %j', async (flags, values, refusals, dropped) => {
    const batch = await upload(flags);
    const text = JSON.stringify({ classification: 'lab_report', reportDate: '2026-10-10', document: null,
      values: [undefined, '2025-09-02', 'undated'].flatMap(recordedAt => [
        { metric: 'ldl', value: 2.8, unit: 'mmol/L', confidence: 'high', recordedAt },
        { metric: 'creatinine', value: 2, unit: 'mg/mmol', confidence: 'high', recordedAt },
      ]),
      additionalValues: [undefined, '2025-09-02', 'undated'].map(recordedAt => ({ name: 'ferritin', value: 80, unit: 'ug/L', recordedAt })),
    });
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/results')
      ? new Response(JSON.stringify({ custom_id: 'file-0', result: { type: 'succeeded', message: { content: [{ type: 'text', text }] } } }))
      : statusResponse());
    const first = await (await call({ ...batch, ownDates: true, undatedPrev: true, refusedRows: true })).json();
    expect(first.results[0].values).toHaveLength(values);
    expect(first.results[0].additionalValues).toHaveLength(values);
    expect(first.results[0].refusedValues).toHaveLength(refusals);
    expect(first.results[0].droppedValueCount).toBe(dropped);
    for (let i = 0; i < 3; i++) expect(await (await call(batch)).json()).toEqual(first);
    expect(reads()).toBe(8);
  });

  it('keeps served entries inside the existing 200-batch capacity and releases them with upstream deletion at the sweep', async () => {
    const batches = [];
    for (let i = 0; i < 200; i++) {
      const batch = await upload();
      batches.push(batch);
      expect(await (await call(batch)).json()).toMatchObject({ status: 'ended' });
    }
    expect(reads()).toBe(400);
    const busy = await call({ batch: true, files: [{ pages: [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }] }] });
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ success: false, error: 'Server busy. Please try again later.' });
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(200);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(200);
    for (const batch of batches) expect((await call(batch)).status).toBe(404);
    expect(reads()).toBe(400);
    expect((await upload()).batchId).toBe('batch_201');
  });

  it('expires an unserved processing cache after the existing one-hour lifecycle', async () => {
    ended = false;
    const batch = await upload();
    await call(batch);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect((await call(batch)).status).toBe(404);
    expect(reads()).toBe(1);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
  });
  it('paces processing reads for two seconds after completion without rejecting retries or blocking another batch', async () => {
    ended = false;
    const batch = await upload();
    const other = await upload();
    let release!: (response: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
    const first = call(batch);
    await vi.waitFor(() => expect(reads()).toBe(1));
    await vi.advanceTimersByTimeAsync(3000);
    const joined = call(batch);
    const independent = await (await call(other)).json();
    expect(independent).toEqual({ status: 'processing', completed: 0, total: 1 });
    release(statusResponse());
    const progress = await (await first).json();
    expect(await (await joined).json()).toEqual(progress);
    for (let i = 0; i < 5; i++) expect(await (await call(batch)).json()).toEqual(progress);
    expect((await call({ batchId: batch.batchId, pollToken: other.pollToken })).status).toBe(404);
    expect(reads()).toBe(2); // one pending flight plus the other batch
    await vi.advanceTimersByTimeAsync(1999);
    expect(await (await call(batch)).json()).toEqual(progress);
    expect(reads()).toBe(2);
    ended = true;
    await vi.advanceTimersByTimeAsync(1);
    expect(await (await call(batch)).json()).toMatchObject({ status: 'ended' });
    expect(reads()).toBe(4);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(2);
  });
  it('coalesces concurrent status and JSONL reads, but validates every capability and proxy signature first', async () => {
    const batch = await upload();
    const other = await upload();
    let releaseStatus!: (response: Response) => void;
    let releaseResults!: (response: Response) => void;
    const statusGate = new Promise<Response>(resolve => { releaseStatus = resolve; });
    const resultsGate = new Promise<Response>(resolve => { releaseResults = resolve; });
    fetchMock.mockImplementation((url: string) => (url.endsWith('/results') ? resultsGate : statusGate).then(response => response.clone()));
    const polls = Array.from({ length: 20 }, () => call(batch));
    await vi.waitFor(() => expect(reads()).toBeGreaterThan(0));
    const checkDenied = async () => {
      for (const pollToken of [undefined, '', 'x', 'x'.repeat(batch.pollToken.length), other.pollToken]) {
        const response = await call({ batchId: batch.batchId, pollToken });
        expect(response.status).toBe(404);
        expect(await response.json()).toEqual({ error: 'Batch not found' });
      }
      for (const req of [request(batch, Date.now() / 1000, false), request(batch, Date.now() / 1000 - 601)]) {
        expect((await action({ request: req } as never)).status).toBe(403);
      }
    };
    await checkDenied();
    releaseStatus(statusResponse());
    await vi.waitFor(() => expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/results'))).toBe(true));
    await checkDenied();
    releaseResults(new Response(lines.join('\n')));
    const answers = await Promise.all(polls.map(async promise => (await promise).json()));
    expect(answers.every(answer => JSON.stringify(answer) === JSON.stringify(answers[0]))).toBe(true);
    expect(answers[0]).toMatchObject({ status: 'ended', results: [{ index: 0, errorCode: 'refused' }] });
    expect(reads()).toBe(2);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    await checkDenied(); // a served entry grants no new capability
    expect(reads()).toBe(2);
  });
  it('re-reads a dropped terminal answer within ten minutes; reports stops once (US-15 AC34)', async () => {
    const batch = await upload();
    const first = await (await call(batch)).json();
    expect(first).toEqual({ status: 'ended', completed: 1, total: 1, results: [{ index: 0, errorCode: 'refused' }] });
    expect(reads()).toBe(2);
    await vi.advanceTimersByTimeAsync(10 * MIN - 1);
    expect(await (await call(batch)).json()).toEqual(first);
    expect(reads()).toBe(4);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Lab import: extraction refused', expect.objectContaining({
      tags: expect.objectContaining({ path: 'batch', refusalCategory: 'bio' }),
    }));
    await vi.advanceTimersByTimeAsync(1);
    expect((await call(batch)).status).toBe(404);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'DELETE')).toHaveLength(1);
    expect(reads()).toBe(4);
  });
});
