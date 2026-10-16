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
const extractOrClassify = vi.fn();

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../lib/anthropic.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createBatch: (...a: unknown[]) => createBatch(...(a as [])),
  pollBatch: (...a: unknown[]) => pollBatch(...(a as [])),
  extractOrClassify: (...a: unknown[]) => extractOrClassify(...(a as [])),
}));
vi.mock('../lib/local-first-route.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAppProxySignature: () => true,
}));

import * as Sentry from '@sentry/react-router';
import { ExtractionStopError } from '../lib/anthropic.server';
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

  // US-15 AC34: one Sentry message per stopped file, sent when the batch ends,
  // never again when the same ended batch is polled once more.
  it('reports each stopped file once, with its category, however often the ended batch is polled', async () => {
    const ended = {
      status: 'ended', completed: 2, total: 2,
      results: [{ index: 0, errorCode: 'refused' }, { index: 1, errorCode: 'too_long' }],
      stops: [new ExtractionStopError('refused', 'bio'), new ExtractionStopError('too_long')],
    } as never;
    pollBatch.mockResolvedValueOnce(ended).mockResolvedValueOnce(ended);
    const { batchId, pollToken } = await newBatch();
    const answer = await (await action({ request: poll({ batchId, pollToken }) } as never)).json();
    await action({ request: poll({ batchId, pollToken }) } as never);
    expect(answer).not.toHaveProperty('stops');
    expect(vi.mocked(Sentry.captureMessage).mock.calls).toEqual([
      ['Lab import: extraction refused', expect.objectContaining({ tags: expect.objectContaining({ path: 'batch', refusalCategory: 'bio' }) })],
      ['Lab import: extraction too_long', expect.objectContaining({ tags: expect.objectContaining({ path: 'batch', stopCode: 'too_long' }) })],
    ]);
  });

  it('a poll costs no quota — only the upload does', async () => {
    const { batchId, pollToken } = await newBatch();
    for (let i = 0; i < 5; i++) await action({ request: poll({ batchId, pollToken }) } as never);
    expect(pollBatch).toHaveBeenCalledTimes(5);
    expect(createBatch).toHaveBeenCalledTimes(1);
  });
});

// Privacy: a file name can hold a patient's name. The server reads results by
// request index, so it takes no name, and drops one an older widget still sends
// (and the `file-N` label the current widget sends for older servers).
describe('privacy: the batch takes no file name', () => {
  const PAGES = FILES[0].pages;
  const batch = (files: unknown[]) => new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST',
    headers: { 'fly-client-ip': `10.1.0.${++ipCounter}` },
    body: JSON.stringify({ batch: true, files }),
  });

  it('accepts a batch of pages alone', async () => {
    const created = await (await action({ request: batch([{ pages: PAGES }]) } as never)).json();
    expect(created.success).toBe(true);
    expect(createBatch).toHaveBeenCalledWith([{ pages: PAGES }]);
  });

  it('drops the name an older widget sends before the batch is built', async () => {
    await action({ request: batch([{ fileName: 'Jane Citizen bloods.pdf', pages: PAGES }]) } as never);
    expect(createBatch).toHaveBeenCalledWith([{ pages: PAGES }]);
  });

  it('drops the compatibility label the current widget sends (US-12 AC9)', async () => {
    await action({ request: batch([{ fileName: 'file-1', pages: PAGES }]) } as never);
    expect(createBatch).toHaveBeenCalledWith([{ pages: PAGES }]);
  });
});

// US-15 AC34: Haiku 5.5 can decline a file, or stop at its token cap, and the
// same request stops the same way again. The answer says which, so the widget
// does not say "try again", and carries no document text.
describe('a single file that stopped short', () => {
  const single = () => new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
    method: 'POST',
    headers: { 'fly-client-ip': `10.1.0.${++ipCounter}` },
    body: JSON.stringify({ pages: FILES[0].pages }),
  });

  it('answers a refusal 422 "refused" and reports its category, not an exception', async () => {
    extractOrClassify.mockRejectedValueOnce(new ExtractionStopError('refused', 'general_harms'));
    const answer = await action({ request: single() } as never);
    expect(answer.status).toBe(422);
    expect(await answer.json()).toEqual({ success: false, error: 'Not read', errorCode: 'refused' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.captureMessage).toHaveBeenCalledWith('Lab import: extraction refused', expect.objectContaining({
      tags: expect.objectContaining({ feature: 'lab_import_v2', path: 'single', refusalCategory: 'general_harms' }),
    }));
  });

  // One deadline for the file: a malformed answer's re-send gets what is left,
  // never a fresh 60 s.
  it('gives the file one 60 s deadline', async () => {
    extractOrClassify.mockResolvedValueOnce({ classification: 'other' });
    await action({ request: single() } as never);
    expect(extractOrClassify).toHaveBeenCalledWith(FILES[0].pages, { timeoutMs: 60_000 });
  });

  it('answers a max_tokens stop 422 "too_long"', async () => {
    extractOrClassify.mockRejectedValueOnce(new ExtractionStopError('too_long'));
    const answer = await action({ request: single() } as never);
    expect(answer.status).toBe(422);
    expect((await answer.json()).errorCode).toBe('too_long');
  });

  it('still answers any other failure 500', async () => {
    extractOrClassify.mockRejectedValueOnce(new Error('extraction returned malformed JSON'));
    expect((await action({ request: single() } as never)).status).toBe(500);
  });
});
