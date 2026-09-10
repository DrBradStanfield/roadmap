/**
 * The batch poll is a capability, not a lookup. A batch id comes from
 * Anthropic and is not a secret; the poll it names returns EXTRACTED LAB TEXT.
 * So the POST that creates a batch hands back a random `pollToken`, and a poll
 * that cannot present it gets the same answer as a batch that never existed.
 *
 * And the poll itself is a POST: the server logs request URLs to stdout, so a
 * token in the query string is a logged capability. The GET side polls nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const createBatch = vi.fn(async () => ({ batchId: 'batch_abc' }));
const pollBatch = vi.fn(async () => ({ status: 'ended' as const, completed: 1, total: 1, results: [{ fileName: 'a.pdf' }] }));

vi.mock('../lib/anthropic.server', () => ({
  createBatch: (...a: unknown[]) => createBatch(...(a as [])),
  pollBatch: (...a: unknown[]) => pollBatch(...(a as [])),
  extractOrClassify: vi.fn(),
}));
vi.mock('../lib/local-first-route.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAppProxySignature: () => true,
}));

import { action, loader } from './api.lab-import-v2';

const FILES = [{ fileName: 'a.pdf', pages: [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }] }];

let ipCounter = 0;
/** A fresh IP per batch — the per-IP daily quota is module-global. */
function post(ip = `10.1.0.${++ipCounter}`): Request {
  return new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST',
    headers: { 'fly-client-ip': ip },
    body: JSON.stringify({ batch: true, files: FILES }),
  });
}

/** A poll: POST, token in the body, nothing identifying in the URL. */
function poll(body: Record<string, unknown>): Request {
  return new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST',
    headers: { 'fly-client-ip': '10.1.9.9' },
    body: JSON.stringify(body),
  });
}

async function newBatch(): Promise<{ batchId: string; pollToken: string }> {
  const created = await (await action({ request: post() } as never)).json();
  expect(created.success).toBe(true);
  return created;
}

beforeEach(() => {
  vi.clearAllMocks();
  createBatch.mockResolvedValue({ batchId: 'batch_abc' });
});

describe('the batch poll needs the token the upload was given', () => {
  it('hands back a token that is random per batch and not the id', async () => {
    const first = await newBatch();
    createBatch.mockResolvedValue({ batchId: 'batch_two' });
    const second = await newBatch();
    expect(first.pollToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(first.pollToken).not.toBe(first.batchId);
    expect(second.pollToken).not.toBe(first.pollToken);
  });

  it('404s a poll with no token, even though the batch exists', async () => {
    const { batchId } = await newBatch();
    const answer = await action({ request: poll({ batchId }) } as never);
    expect(answer.status).toBe(404);
    expect(pollBatch).not.toHaveBeenCalled();
  });

  it('404s a wrong token — a right-length guess and a short one answer alike', async () => {
    const { batchId, pollToken } = await newBatch();
    const wrongSameLength = 'a'.repeat(pollToken.length);
    for (const token of [wrongSameLength, 'x', `${pollToken}x`, '']) {
      const answer = await action({ request: poll({ batchId, pollToken: token }) } as never);
      expect(answer.status, token).toBe(404);
      expect(await answer.json()).toEqual({ error: 'Batch not found' });
    }
    expect(pollBatch).not.toHaveBeenCalled();
  });

  it('polls with the token', async () => {
    const { batchId, pollToken } = await newBatch();
    const answer = await action({ request: poll({ batchId, pollToken }) } as never);
    expect(answer.status).toBe(200);
    expect(await answer.json()).toMatchObject({ status: 'ended', completed: 1, total: 1 });
    expect(pollBatch).toHaveBeenCalledWith(batchId);
  });

  it('404s an id nobody created, token or not — the same answer as a bad token', async () => {
    const answer = await action({ request: poll({ batchId: 'batch_nope', pollToken: 'whatever' }) } as never);
    expect(answer.status).toBe(404);
    expect(await answer.json()).toEqual({ error: 'Batch not found' });
  });

  it('never polls from the GET side — a token in the query buys nothing', async () => {
    const { batchId, pollToken } = await newBatch();
    const query = `batchId=${batchId}&pollToken=${encodeURIComponent(pollToken)}`;
    const answer = await loader({
      request: new Request(`https://health-tool-app.fly.dev/api/lab-import-v2?${query}`, {
        headers: { 'fly-client-ip': '10.1.9.9' },
      }),
    } as never);
    expect(pollBatch).not.toHaveBeenCalled();
    expect(await answer.json()).toEqual({ allowed: true, remaining: expect.any(Number) });
  });

  it('a poll costs no quota — only the upload does', async () => {
    const { batchId, pollToken } = await newBatch();
    for (let i = 0; i < 5; i++) await action({ request: poll({ batchId, pollToken }) } as never);
    expect(pollBatch).toHaveBeenCalledTimes(5);
    expect(createBatch).toHaveBeenCalledTimes(1);
  });
});
