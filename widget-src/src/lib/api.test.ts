import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock Sentry — api.ts imports it at module load (for sendFeedback / AB tracking).
vi.mock('./sentry', () => ({
  Sentry: {
    captureException: vi.fn(),
  },
}));

import { parseJsonResponse } from './api';

// The Shopify app proxy can return an HTML maintenance/error page with a 200
// status. parseJsonResponse is the guard every data call routes through — it
// must return null (not throw) on non-JSON, and still surface genuinely
// malformed JSON. (Before the legacy health-tool.js bundle was retired this
// was covered indirectly through loadLatestMeasurements/addMeasurement; those
// fetch wrappers now live in roadmap-data.ts as local-first store calls, so we
// test the guard directly.)
describe('parseJsonResponse — HTML response from Shopify proxy', () => {
  afterEach(() => {
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
