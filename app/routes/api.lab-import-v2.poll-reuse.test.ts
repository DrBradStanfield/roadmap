/** US-12 AC18 / US-15 AC34: real action, proxy HMAC and Anthropic parser.
 * Only fetch and telemetry cross a synthetic boundary. No live data or network. */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));

const SECRET = 'synthetic-proxy-secret';
const MIN = 60_000;
let action: typeof import('./api.lab-import-v2').action;
let loader: typeof import('./api.lab-import-v2').loader;
let nextId: number;
let ended: boolean;
let fetchMock: ReturnType<typeof vi.fn>;
const lines = [JSON.stringify({ custom_id: 'file-0', result: { type: 'succeeded', message: {
  content: [], stop_reason: 'refusal', stop_details: { category: 'bio' },
} } })];

function request(body: object, timestamp = Math.floor(Date.now() / 1000), valid = true, ip = `10.0.0.${nextId}`, method = 'POST') {
  const query = new URLSearchParams({ shop: 'synthetic.myshopify.com', timestamp: String(timestamp) });
  const message = [...query].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${k}=${v}`).join('');
  query.set('signature', valid ? crypto.createHmac('sha256', SECRET).update(message).digest('hex') : '0'.repeat(64));
  return new Request(`https://synthetic.test/api/lab-import-v2?${query}`, {
    method, headers: { 'fly-client-ip': ip }, body: method === 'POST' ? JSON.stringify(body) : undefined,
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
  ({ action, loader } = await import('./api.lab-import-v2'));
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
      entry = set.mock.calls.find(([id, value]) => id === batch.batchId && value?.pollTokens?.[0] === batch.pollToken)?.[1];
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
    // US-12 AC24: a failed read answers `error`, never "processing 0 of N".
    for (const response of await Promise.all(polls)) {
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ status: 'error', completed: 0, total: 1 });
    }
    const before = reads();
    expect(await (await call(batch)).json()).toMatchObject({ status: 'ended', results: [{ index: 0, errorCode: 'refused' }] });
    expect(reads()).toBe(before + 2);
    expect(Sentry.captureMessage).toHaveBeenCalledTimes(1);
  });

  it('US-12 AC24: a rejected read answers `error` with the last count it served, and the next good read moves on', async () => {
    let succeeded = 3;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => init?.method === 'POST'
      ? Response.json({ id: `batch_${++nextId}` })
      : Response.json({ ended_at: null, request_counts: { processing: 20 - succeeded, succeeded } }));
    const batch = await upload();
    expect(await (await call(batch)).json()).toEqual({ status: 'processing', completed: 3, total: 20 });
    await vi.advanceTimersByTimeAsync(2000);
    fetchMock.mockImplementationOnce(async () => new Response('synthetic outage', { status: 529 }));
    const failed = await call(batch);
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ status: 'error', completed: 3, total: 20 });
    succeeded = 5;
    expect(await (await call(batch)).json()).toEqual({ status: 'processing', completed: 5, total: 20 });
  });

  // The deploy-window guard. A widget from before AC24 (f5c3e6001, upload-pipeline.ts:349-352) set
  // `realCompleted = poll.completed`, threw only on `poll.error`, finished only on `ended` with results,
  // and polled on for any other status. So the route's `error` answer must carry a numeric `completed`:
  // without it that widget's bar reads NaN. This test puts the route's real answers through the
  // schema, which requires the count, so it guards both the new widget and the old one.
  it('US-12 AC24: every poll answer the route gives passes the widget\'s poll schema, where it enters', async () => {
    const { batchPollAnswer } = await import('../../widget-src/src/lib/upload-api');
    ended = false;
    const batch = await upload();
    const answers = [await (await call(batch)).json()];
    await vi.advanceTimersByTimeAsync(2000);
    fetchMock.mockImplementationOnce(async () => new Response('synthetic outage', { status: 529 }));
    answers.push(await (await call(batch)).json());
    ended = true;
    answers.push(await (await call(batch)).json());
    expect(answers.map(a => a.status)).toEqual(['processing', 'error', 'ended']);
    for (const answer of answers) expect(batchPollAnswer.safeParse(answer).success, JSON.stringify(answer.status)).toBe(true);
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
  // The poll-token compare is pinned: an equal length goes through
  // timingSafeEqual, any other length is refused without it and never throws.
  it('compares an equal-length poll token in constant time and refuses another length without throwing', async () => {
    const batch = await upload();
    const expected = Buffer.from(batch.pollToken);
    const tse = vi.spyOn(crypto, 'timingSafeEqual');
    const tokenCalls = () => tse.mock.calls.filter(([a]) => expected.equals(a as Buffer));
    try {
      const wrong = (batch.pollToken[0] === 'A' ? 'B' : 'A') + batch.pollToken.slice(1);
      expect((await call({ batchId: batch.batchId, pollToken: wrong })).status).toBe(404);
      expect(tokenCalls()).toEqual([[expected, Buffer.from(wrong)]]);
      tse.mockClear();
      for (const pollToken of [batch.pollToken.slice(1), `${batch.pollToken}A`]) {
        expect((await call({ batchId: batch.batchId, pollToken })).status).toBe(404);
      }
      expect(tokenCalls()).toEqual([]);
    } finally {
      tse.mockRestore();
    }
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

describe('US-12 AC25: the same files sent again while their batch runs join it, uncharged', () => {
  const IP = '203.0.113.7';
  const page = (content: string) => ({ type: 'image', content, mimeType: 'image/png' });
  const twoFiles = [{ pages: [page('AAAA')] }, { pages: [page('BBBB')] }];
  const post = (body: object, ip = IP) => action({ request: request(body, undefined, true, ip) } as never);
  const send = async (files: object[] = twoFiles, flags: object = {}, ip = IP) => {
    const response = await post({ batch: true, files, ...flags }, ip);
    expect(response.status).toBe(200);
    return response.json() as Promise<{ success: true; batchId: string; pollToken: string; totalFiles: number }>;
  };
  const remaining = async (ip = IP) => (await (await loader({ request: request({}, undefined, true, ip, 'GET') } as never)).json()).remaining;
  const creates = () => fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST').length;
  const pollWith = (batchId: string, pollToken: string) => post({ batchId, pollToken });

  it('US-12 AC25: joins a live unserved batch with a new poll token, no charge and no provider batch', async () => {
    ended = false;
    const first = await send();
    const left = await remaining();
    const joined = await send();
    expect(joined).toEqual({ success: true, batchId: first.batchId, pollToken: expect.any(String), totalFiles: 2 });
    expect(joined.pollToken).not.toBe(first.pollToken);
    expect(creates()).toBe(1);
    expect(await remaining()).toBe(left);
    expect(left).toBe(200 - 2);
  });

  it('US-12 AC25: each token is its own bearer: the first still reads after a join, both read the results, both die with the batch', async () => {
    ended = false;
    const first = await send();
    expect((await pollWith(first.batchId, 'x'.repeat(first.pollToken.length))).status).toBe(404);
    const joined = await send();
    ended = true;
    const a = await (await pollWith(first.batchId, first.pollToken)).json();
    const b = await (await pollWith(first.batchId, joined.pollToken)).json();
    expect(a).toMatchObject({ status: 'ended', results: [{ index: 0, errorCode: 'refused' }] });
    expect(b).toEqual(a);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect((await pollWith(first.batchId, first.pollToken)).status).toBe(404);
    expect((await pollWith(first.batchId, joined.pollToken)).status).toBe(404);
  });

  it('US-12 AC25: a join never extends the batch life: the unserved hour runs from the first upload', async () => {
    ended = false;
    const first = await send();
    await vi.advanceTimersByTimeAsync(50 * MIN);
    const joined = await send();
    expect(joined.batchId).toBe(first.batchId);
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect((await pollWith(first.batchId, joined.pollToken)).status).toBe(404);
  });

  it('US-12 AC25: two identical POSTs in one tick make one provider batch and one charge', async () => {
    ended = false;
    const [a, b] = await Promise.all([send(), send()]);
    expect(b.batchId).toBe(a.batchId);
    expect(b.pollToken).not.toBe(a.pollToken);
    expect(creates()).toBe(1);
    expect(await remaining()).toBe(200 - 2);
  });

  it.each([
    ['reordered (the match is order-sensitive: results map by position)', [twoFiles[1], twoFiles[0]], {}, IP],
    ['one byte different', [twoFiles[0], { pages: [page('BBBC')] }], {}, IP],
    ['one page fewer', [twoFiles[0]], {}, IP],
    ['with a different flag', twoFiles, { ownDates: true }, IP],
    ['from another IP', twoFiles, {}, '203.0.113.8'],
  ] as const)('US-12 AC25: a set %s is a new batch, charged', async (_, files, flags, ip) => {
    ended = false;
    const first = await send();
    const other = await send(files as unknown as object[], flags, ip);
    expect(other.batchId).not.toBe(first.batchId);
    expect(creates()).toBe(2);
    expect(await remaining(ip)).toBe(ip === IP ? 200 - 2 - files.length : 200 - files.length);
  });

  it('US-12 AC25: a served batch, failed files and all, never blocks a fresh upload', async () => {
    const first = await send();
    expect(await (await pollWith(first.batchId, first.pollToken)).json()).toMatchObject({ status: 'ended' });
    const again = await send();
    expect(again.batchId).not.toBe(first.batchId);
    expect(creates()).toBe(2);
    expect(await remaining()).toBe(200 - 4);
  });

  it('US-12 AC25: after the sweep drops an unserved batch, the same files are a new batch, charged', async () => {
    ended = false;
    const first = await send();
    await vi.advanceTimersByTimeAsync(70 * MIN);
    const again = await send();
    expect(again.batchId).not.toBe(first.batchId);
    expect(creates()).toBe(2);
  });

  it('US-12 AC25: three tokens per batch; a fourth upload gets the existing busy answer, uncharged', async () => {
    ended = false;
    await send();
    await send();
    await send();
    const left = await remaining();
    const refused = await post({ batch: true, files: twoFiles });
    expect(refused.status).toBe(429);
    expect(await refused.json()).toEqual({ success: false, error: 'Server busy. Please try again later.' });
    expect(creates()).toBe(1);
    expect(await remaining()).toBe(left);
  });

  it('US-12 AC25: a join is answered when the machine holds 200 batches; a new set is still busy', async () => {
    ended = false;
    const first = await send();
    for (let i = 0; i < 199; i++) await upload();
    expect(creates()).toBe(200);
    const joined = await send();
    expect(joined.batchId).toBe(first.batchId);
    const busy = await post({ batch: true, files: [twoFiles[1]] });
    expect(busy.status).toBe(429);
    expect(creates()).toBe(200);
  });

  it('US-12 AC25: logs nothing of the pages or the match key', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(level => vi.spyOn(console, level).mockImplementation(() => {}));
    try {
      ended = false;
      const marker = 'c3ludGhldGljLWxhYi1wYWdl';
      await send([{ pages: [page(marker)] }]);
      await send([{ pages: [page(marker)] }]);
      const out = JSON.stringify(spies.flatMap(spy => spy.mock.calls));
      expect(out).not.toContain(marker);
      expect(out).not.toMatch(/[0-9a-f]{64}/);
      expect(creates()).toBe(1);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
