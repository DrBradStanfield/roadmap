/**
 * US-12 AC18: a batch whose results nobody fetched (the tab closed) is still
 * deleted at Anthropic. The 10-minute sweep forgets a batch after an hour and
 * asks Anthropic to delete it, again each sweep until it is gone. `deleteBatch`
 * cancels a batch still running, so a later sweep can delete it.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';

const createBatch = vi.fn(async () => ({ batchId: 'batch_left' }));
const deleteBatch = vi.fn(async () => true);

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../lib/anthropic.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createBatch: (...a: unknown[]) => createBatch(...(a as [])),
  deleteBatch: (...a: unknown[]) => deleteBatch(...(a as [])),
}));
vi.mock('../lib/local-first-route.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAppProxySignature: () => true,
}));

const MIN = 60_000;
let action: typeof import('./api.lab-import-v2').action;

beforeAll(async () => {
  // The sweep is armed when the module loads: fake the clock first.
  vi.useFakeTimers({ toFake: ['setInterval', 'Date'] });
  ({ action } = await import('./api.lab-import-v2'));
});

async function upload(batchId: string): Promise<void> {
  createBatch.mockResolvedValueOnce({ batchId });
  const res = await action({ request: new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST', headers: { 'fly-client-ip': '10.3.0.1' },
    body: JSON.stringify({ batch: true, files: [{ pages: [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }] }] }),
  }) } as never);
  expect(res.status).toBe(200);
}

describe('US-12 AC18: an abandoned batch is deleted by the sweep', () => {
  it('leaves a batch younger than an hour alone, deletes it after, and stops once it is gone', async () => {
    await upload('batch_left');
    await vi.advanceTimersByTimeAsync(50 * MIN);
    expect(deleteBatch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20 * MIN);
    expect(deleteBatch).toHaveBeenCalledWith('batch_left');
    deleteBatch.mockClear();
    await vi.advanceTimersByTimeAsync(30 * MIN);
    expect(deleteBatch).not.toHaveBeenCalled();
  });

  it('tries again each sweep while the delete fails, and gives up a day after the upload', async () => {
    deleteBatch.mockClear();
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
