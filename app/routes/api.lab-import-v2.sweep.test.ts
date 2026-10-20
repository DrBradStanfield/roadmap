/**
 * US-12 AC18: every batch is deleted at Anthropic by the 10-minute sweep, never
 * by the poll. A batch whose results were served goes at the next sweep, so a
 * re-poll after a lost answer still works until then. One nobody polled to the
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

beforeAll(async () => {
  // The sweep is armed when the module loads: fake the clock first.
  vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
  ({ action } = await import('./api.lab-import-v2'));
});

beforeEach(() => {
  deleteBatch.mockReset();
  deleteBatch.mockResolvedValue(true);
  pollBatch.mockResolvedValue({ status: 'ended', completed: 1, total: 1, results: [{ index: 0 }] });
});

async function upload(batchId: string): Promise<string> {
  createBatch.mockResolvedValueOnce({ batchId });
  const res = await action({ request: new Request(URL, {
    method: 'POST', headers: { 'fly-client-ip': '10.3.0.1' },
    body: JSON.stringify({ batch: true, files: [{ pages: [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }] }] }),
  }) } as never);
  expect(res.status).toBe(200);
  return (await res.json()).pollToken;
}

const poll = (batchId: string, pollToken: string) =>
  action({ request: new Request(URL, { method: 'POST', body: JSON.stringify({ batchId, pollToken }) }) } as never);

describe('US-12 AC18: the sweep deletes each batch at Anthropic', () => {
  it('deletes a served batch at the next sweep; until then a re-poll still gets its results', async () => {
    const token = await upload('batch_served');
    expect((await poll('batch_served', token)).status).toBe(200);
    expect(deleteBatch).not.toHaveBeenCalled();
    const again = await poll('batch_served', token);
    expect(await again.json()).toMatchObject({ status: 'ended', results: [{ index: 0 }] });
    await vi.advanceTimersByTimeAsync(10 * MIN);
    expect(deleteBatch).toHaveBeenCalledWith('batch_served');
    expect((await poll('batch_served', token)).status).toBe(404);
  });

  it('leaves an unserved batch an hour (a poll that only saw it processing serves nothing), deletes it after, and stops once it is gone', async () => {
    pollBatch.mockResolvedValueOnce({ status: 'processing', completed: 0, total: 1 });
    const token = await upload('batch_left');
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
    await upload('batch_running');
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
});
