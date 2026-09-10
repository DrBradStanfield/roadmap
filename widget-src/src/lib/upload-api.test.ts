/**
 * The poll client's half of the batch capability: the token the POST hands
 * back is kept here and presented on every poll. Without it the server answers
 * 404, so a client that forgets it never reads its own results.
 *
 * The poll is a POST with the token in the BODY. The server logs request URLs
 * to stdout, and a logged token reads the extracted lab text back.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { labImportBatch, pollBatchStatus } from './upload-api';

const FILES = [{ fileName: 'a.pdf', pages: [{ type: 'image' as const, content: 'AAAA', mimeType: 'image/png' }] }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

type Call = { url: string; body: Record<string, unknown> | null };
let calls: Call[];

/** Every call to the endpoint, with its parsed body. */
function stubFetch(reply: (call: Call) => Response) {
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const call: Call = { url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return reply(call);
  }));
}

beforeEach(() => { calls = []; });
afterEach(() => { vi.unstubAllGlobals(); });

describe('the batch poll carries the token the upload was given', () => {
  it('sends the pollToken in the body, never in the URL', async () => {
    stubFetch((call) =>
      call.body && 'batch' in call.body
        ? jsonResponse({ success: true, batchId: 'batch_abc', pollToken: 'tok-123' })
        : jsonResponse({ status: 'processing', completed: 0, total: 1 }));

    const { batchId } = await labImportBatch(FILES);
    expect(batchId).toBe('batch_abc');
    await pollBatchStatus('batch_abc');
    await pollBatchStatus('batch_abc');

    expect(calls.slice(1).map((c) => c.body)).toEqual([
      { batchId: 'batch_abc', pollToken: 'tok-123' },
      { batchId: 'batch_abc', pollToken: 'tok-123' },
    ]);
    // The URL is the bare endpoint — no query string to end up in a log line.
    for (const call of calls) {
      expect(call.url).not.toContain('?');
      expect(call.url).not.toContain('tok-123');
    }
  });

  it('polls a batch it never created with an empty token, and takes the 404 as a restart', async () => {
    stubFetch(() => jsonResponse({ error: 'Batch not found' }, 404));

    const poll = await pollBatchStatus('batch_stranger');
    expect(calls[0].body).toEqual({ batchId: 'batch_stranger', pollToken: '' });
    expect(poll).toMatchObject({ status: 'ended', errorCode: 'server_restart' });
  });
});
