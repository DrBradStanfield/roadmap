/**
 * The poll client's half of the batch capability: the token the POST hands
 * back is kept here and presented on every poll. Without it the server answers
 * 404, so a client that forgets it never reads its own results.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { labImportBatch, pollBatchStatus } from './upload-api';

const FILES = [{ fileName: 'a.pdf', pages: [{ type: 'image' as const, content: 'AAAA', mimeType: 'image/png' }] }];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

let calls: string[];

beforeEach(() => {
  calls = [];
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the batch poll carries the token the upload was given', () => {
  it('sends the pollToken back on every poll for that batch', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(String(url));
      if (init?.method === 'POST') return jsonResponse({ success: true, batchId: 'batch_abc', pollToken: 'tok-123' });
      return jsonResponse({ status: 'processing', completed: 0, total: 1 });
    }));

    const { batchId } = await labImportBatch(FILES);
    expect(batchId).toBe('batch_abc');
    await pollBatchStatus('batch_abc');
    await pollBatchStatus('batch_abc');
    expect(calls.slice(1)).toEqual([
      expect.stringContaining('batchId=batch_abc&pollToken=tok-123'),
      expect.stringContaining('pollToken=tok-123'),
    ]);
  });

  it('polls a batch it never created with an empty token, and takes the 404 as a restart', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(String(url));
      return jsonResponse({ error: 'Batch not found' }, 404);
    }));

    const poll = await pollBatchStatus('batch_stranger');
    expect(calls[0]).toContain('pollToken=');
    expect(calls[0]).not.toMatch(/pollToken=.+/);
    expect(poll).toMatchObject({ status: 'ended', errorCode: 'server_restart' });
  });
});
