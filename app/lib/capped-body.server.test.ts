/**
 * US-09 AC25: one capped reader for every request body. It stops reading at
 * the cap and never trusts Content-Length.
 */
import { describe, it, expect } from 'vitest';
import { cappedBody, SMALL_BODY_CAP } from './capped-body.server';
import { streamingPost } from './capped-body.test-helpers';

const URL = 'https://drstanfield.com/apps/health-tool-1/api/x';
const CHUNK = 16 * 1024;

describe('cappedBody (US-09 AC25)', () => {
  it('returns a body at the cap whole', async () => {
    const { request } = streamingPost(URL, SMALL_BODY_CAP);
    expect((await cappedBody(request))?.length).toBe(SMALL_BODY_CAP);
  });

  it('refuses a chunked body with no Content-Length, and stops reading at the cap', async () => {
    const { request, pulled } = streamingPost(URL, 100 * SMALL_BODY_CAP);
    expect(request.headers.get('content-length')).toBeNull();
    expect(await cappedBody(request)).toBeNull();
    expect(pulled.bytes).toBeLessThanOrEqual(SMALL_BODY_CAP + 2 * CHUNK);
  });

  it('refuses a body whose Content-Length lies low, and stops reading at the cap', async () => {
    const { request, pulled } = streamingPost(URL, 100 * SMALL_BODY_CAP, { headers: { 'content-length': '10' } });
    expect(await cappedBody(request)).toBeNull();
    expect(pulled.bytes).toBeLessThanOrEqual(SMALL_BODY_CAP + 2 * CHUNK);
  });

  it('refuses a declared length over the cap without reading', async () => {
    const { request, pulled } = streamingPost(URL, 10, { headers: { 'content-length': String(SMALL_BODY_CAP + 1) } });
    expect(await cappedBody(request)).toBeNull();
    expect(pulled.bytes).toBeLessThanOrEqual(10);
  });

  it('takes a per-route cap', async () => {
    const { request } = streamingPost(URL, 2 * SMALL_BODY_CAP);
    expect((await cappedBody(request, 4 * SMALL_BODY_CAP))?.length).toBe(2 * SMALL_BODY_CAP);
  });

  it('decodes a multi-byte character split across two chunks', async () => {
    const bytes = new TextEncoder().encode('a😀b');
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.subarray(0, 3));
        c.enqueue(bytes.subarray(3));
        c.close();
      },
    });
    const request = new Request(URL, { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect(await cappedBody(request)).toBe('a😀b');
  });
});
