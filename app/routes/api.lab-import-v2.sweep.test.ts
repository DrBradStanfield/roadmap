/**
 * US-12 AC18: every batch is deleted at Anthropic by the 10-minute sweep, never
 * by the poll. A batch whose results were served goes at the first sweep at
 * least 10 minutes later, so a re-poll after a lost answer has that long. One nobody polled to the
 * end (the tab closed) goes an hour after its upload. The sweep retries a failed
 * delete each time (`deleteBatch` cancels a batch still running, so a later
 * sweep can delete it) and gives up 25 hours after the upload.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';

const createBatch = vi.fn(async () => ({ batchId: 'batch_left' }));
const pollBatch = vi.fn();
const deleteBatch = vi.fn(async () => true);

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../lib/anthropic.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createBatch: (...a: unknown[]) => createBatch(...(a as [])),
  pollBatch: (...a: unknown[]) => pollBatch(...(a as [])),
  deleteBatch: (...a: unknown[]) => deleteBatch(...(a as [])),
}));
vi.mock('../lib/local-first-route.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAppProxySignature: () => true,
}));

const MIN = 60_000;
const URL = 'https://health-tool-app.fly.dev/api/lab-import-v2';
let action: typeof import('./api.lab-import-v2').action;
let sweepStartedAt = 0;
let sweepTimerCount: () => number;
/** Time until the next sweep: every 10 minutes from the first successful upload. */
const toNextSweep = () => 10 * MIN - ((Date.now() - sweepStartedAt) % (10 * MIN));

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
  const intervals = vi.spyOn(globalThis, 'setInterval');
  sweepTimerCount = () => intervals.mock.calls.filter(([, delay]) => delay === 10 * MIN).length;
  ({ action } = await import('./api.lab-import-v2'));
});

beforeEach(() => {
  createBatch.mockReset(); // a busy answer leaves its queued id unused
  createBatch.mockResolvedValue({ batchId: 'batch_left' });
  deleteBatch.mockReset();
  deleteBatch.mockResolvedValue(true);
  pollBatch.mockResolvedValue({ status: 'ended', completed: 1, total: 1, results: [{ index: 0 }] });
});

async function upload(batchId: string, ip = '10.3.0.1'): Promise<Response> {
  createBatch.mockResolvedValueOnce({ batchId });
  return action({ request: new Request(URL, {
    method: 'POST', headers: { 'fly-client-ip': ip },
    body: JSON.stringify({ batch: true, files: [{ pages: [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }] }] }),
  }) } as never);
}

async function uploaded(batchId: string): Promise<string> {
  const res = await upload(batchId);
  expect(res.status).toBe(200);
  return (await res.json()).pollToken;
}

const poll = (batchId: string, pollToken: string) =>
  action({ request: new Request(URL, { method: 'POST', body: JSON.stringify({ batchId, pollToken }) }) } as never);

describe('US-12 AC18: the sweep deletes each batch at Anthropic', () => {
  it('arms once on the first upload after an idle start, and cleans uploads never polled', async () => {
    await vi.advanceTimersByTimeAsync(7 * MIN + 1234);
    expect(sweepTimerCount()).toBe(0);
    sweepStartedAt = Date.now();
    await uploaded('batch_idle_first');
    expect(sweepTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(3 * MIN);
    await uploaded('batch_idle_second');
    expect(sweepTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(57 * MIN);
    expect(deleteBatch).not.toHaveBeenCalled(); // exactly one hour is not older than an hour
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(deleteBatch.mock.calls).toEqual([['batch_idle_first'], ['batch_idle_second']]);
    expect(pollBatch).not.toHaveBeenCalled();
    expect(sweepTimerCount()).toBe(1);
  });

  it('a sweep right after the first answer keeps a served batch; the first sweep 10 minutes on deletes it', async () => {
    const token = await uploaded('batch_served');
    await vi.advanceTimersByTimeAsync(toNextSweep() - 1);
    expect((await poll('batch_served', token)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(1); // a sweep 1 ms after the answer
    expect(deleteBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * MIN - 2); // just short of 10 minutes on
    const again = await poll('batch_served', token);
    expect(await again.json()).toMatchObject({ status: 'ended', results: [{ index: 0 }] });
    expect(deleteBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(deleteBatch).toHaveBeenCalledWith('batch_served');
    expect((await poll('batch_served', token)).status).toBe(404);
  });

  it('leaves an unserved batch an hour (a poll that only saw it processing serves nothing), deletes it after, and stops once it is gone', async () => {
    pollBatch.mockResolvedValueOnce({ status: 'processing', completed: 0, total: 1 });
    const token = await uploaded('batch_left');
    await poll('batch_left', token);
    await vi.advanceTimersByTimeAsync(50 * MIN);
    expect(deleteBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(deleteBatch).toHaveBeenCalledWith('batch_left');
    deleteBatch.mockClear();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(deleteBatch).not.toHaveBeenCalled();
  });

  it('tries again each sweep while the delete fails, and gives up a day after the upload', async () => {
    deleteBatch.mockResolvedValue(false);
    await uploaded('batch_running');
    await vi.advanceTimersByTimeAsync(70 * MIN);
    const first = deleteBatch.mock.calls.length;
    expect(first).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(deleteBatch.mock.calls.length).toBe(first + 1);
    // A batch ends within 24 hours at Anthropic, cancelled or not: past 25 the sweep stops.
    await vi.advanceTimersByTimeAsync(25 * 60 * MIN);
    deleteBatch.mockClear();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(deleteBatch).not.toHaveBeenCalled();
  });

  // PR #201 review R2: a busy answer charges nothing.
  it('a full batch table answers busy and charges the IP nothing', async () => {
    deleteBatch.mockResolvedValue(true);
    for (let i = 0; i < 200; i++) expect((await upload(`batch_fill_${i}`, `10.5.${i >> 8}.${i & 255}`)).status).toBe(200);
    const busy = await upload('batch_busy', '10.5.9.9');
    expect(busy.status).toBe(429);
    expect(await busy.json()).toEqual({ success: false, error: 'Server busy. Please try again later.' });
    const { loader } = await import('./api.lab-import-v2');
    const preflight = await loader({ request: new Request(URL, { headers: { 'fly-client-ip': '10.5.9.9' } }) } as never);
    expect((await preflight.json()).remaining).toBe(200);
    await vi.advanceTimersByTimeAsync(70 * MIN); // the sweep clears them
  });

  // Codex re-check R1: a batch first served just past its hour keeps 10 minutes.
  it('a first answer just after the 1-hour mark still gets its 10 minutes', async () => {
    await vi.advanceTimersByTimeAsync(toNextSweep()); // upload at a sweep
    const token = await uploaded('batch_late');
    await vi.advanceTimersByTimeAsync(60 * MIN + 1);
    expect(deleteBatch).not.toHaveBeenCalled();
    expect((await poll('batch_late', token)).status).toBe(200); // served at 1 h + 1 ms
    await vi.advanceTimersByTimeAsync(10 * MIN - 1); // the 70-minute sweep
    expect(deleteBatch).not.toHaveBeenCalled();
    expect((await poll('batch_late', token)).status).toBe(200);
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(deleteBatch).toHaveBeenCalledWith('batch_late');
  });
});
