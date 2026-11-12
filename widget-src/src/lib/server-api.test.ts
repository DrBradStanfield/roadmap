import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock Sentry — server-api.ts imports it at module load (for sendFeedback / AB tracking).
vi.mock('./sentry', () => ({
  Sentry: {
    captureException: vi.fn(),
  },
}));

import { parseJsonResponse } from './server-api';

// The Shopify app proxy can return an HTML maintenance/error page with a 200
// status. parseJsonResponse is the guard every data call routes through — it
// must return null (not throw) on non-JSON, and still surface genuinely
// malformed JSON. (Before the legacy health-tool.js bundle was retired this
// was covered indirectly through loadLatestMeasurements/addMeasurement; those
// fetch wrappers now live in roadmap-data.ts as local-first store calls, so we
// test the guard directly.)
describe('parseJsonResponse — HTML response from Shopify proxy', () => {
  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
  });

  it('returns null when the proxy returns HTML', async () => {
    const response = new Response('<!doctype html><html><body>Maintenance</body></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    });
    expect(await parseJsonResponse(response)).toBeNull();
  });

  it('throws on genuine malformed JSON (correct content-type)', async () => {
    const response = new Response('not valid json', {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    await expect(parseJsonResponse(response)).rejects.toThrow();
  });

  it('parses valid JSON', async () => {
    const response = new Response(JSON.stringify({ success: true, value: 42 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
    expect(await parseJsonResponse<{ value: number }>(response)).toEqual({ success: true, value: 42 });
  });

  it('treats a missing content-type header as non-JSON', async () => {
    const response = new Response('some text', { status: 200 });
    expect(await parseJsonResponse(response)).toBeNull();
  });
});

describe('Sentry ignoreErrors patterns', () => {
  it('matches Firefox NetworkError message', () => {
    const pattern = /NetworkError when attempting to fetch resource/;
    expect(pattern.test('NetworkError when attempting to fetch resource.')).toBe(true);
    expect(pattern.test('TypeError: NetworkError when attempting to fetch resource.')).toBe(true);
  });

  it('matches iOS WebKit DOMException message', () => {
    const pattern = /The string did not match the expected pattern/;
    expect(pattern.test('The string did not match the expected pattern.')).toBe(true);
    expect(pattern.test('SyntaxError: The string did not match the expected pattern.')).toBe(true);
  });

  it('matches Safari/WebKit Load failed message', () => {
    const pattern = /Load failed/;
    expect(pattern.test('Load failed')).toBe(true);
    expect(pattern.test('TypeError: Load failed')).toBe(true);
  });

  it('matches the storage adapters’ outage wording', () => {
    const pattern = /did not answer/;
    expect(pattern.test('Dropbox did not answer')).toBe(true);
    expect(pattern.test('Google Drive did not answer')).toBe(true);
  });

  it('matches AbortError message', () => {
    const pattern = /The operation was aborted/;
    expect(pattern.test('The operation was aborted.')).toBe(true);
    expect(pattern.test('AbortError: The operation was aborted.')).toBe(true);
  });

  it('patterns do not over-match unrelated errors', () => {
    const patterns = [
      /NetworkError when attempting to fetch resource/,
      /Load failed/,
      /The string did not match the expected pattern/,
      /The operation was aborted/,
      /did not answer/,
    ];
    const unrelated = [
      'TypeError: Cannot read property of undefined',
      'RangeError: Maximum call stack size exceeded',
      'SyntaxError: Unexpected identifier',
    ];
    for (const pattern of patterns) {
      for (const msg of unrelated) {
        expect(pattern.test(msg)).toBe(false);
      }
    }
  });
});

// US-09 AC46: the visitor id is kept only in the UUID form the server accepts.
describe('getVisitorId: stored only as a UUID', () => {
  afterEach(() => vi.unstubAllGlobals());

  const UUID_A = '0b5f1c2e-4d3a-4b6c-8d7e-9f0a1b2c3d4e';
  async function freshVisitorId(crypto: object | undefined, before?: string) {
    const values = new Map<string, string>(before ? [['hr_vid', before]] : []);
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => values.get(k) ?? null,
      setItem: (k: string, v: string) => void values.set(k, v),
      removeItem: (k: string) => void values.delete(k),
    });
    vi.stubGlobal('crypto', crypto);
    vi.resetModules();
    const { getVisitorId } = await import('./server-api');
    return { id: getVisitorId(), again: getVisitorId(), stored: values.get('hr_vid') ?? null };
  }

  it('with no crypto, the id lasts this page only and is not saved', async () => {
    const { id, again, stored } = await freshVisitorId(undefined);
    expect(id).not.toBe('');
    expect(again).toBe(id);
    expect(stored).toBeNull();
  });

  it('control: a UUID is saved', async () => {
    const { id, stored } = await freshVisitorId({ randomUUID: () => UUID_A });
    expect(stored).toBe(id);
  });

  it('a stored id that is not a UUID is replaced by a new UUID', async () => {
    const { id, stored } = await freshVisitorId({ randomUUID: () => UUID_A }, 'mwd2h3tg-1');
    expect([id, stored]).toEqual([UUID_A, UUID_A]);
  });

  it('a stored id that is not a UUID is removed when no UUID can replace it', async () => {
    const { id, stored } = await freshVisitorId(undefined, 'mwd2h3tg-1');
    expect(id).not.toBe('mwd2h3tg-1');
    expect(stored).toBeNull();
  });

  it('control: a stored UUID is kept', async () => {
    const kept = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
    const { id, stored } = await freshVisitorId({ randomUUID: () => UUID_A }, kept);
    expect([id, stored]).toEqual([kept, kept]);
  });
});
