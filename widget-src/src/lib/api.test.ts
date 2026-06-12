import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock Sentry before importing api functions
vi.mock('./sentry', () => ({
  Sentry: {
    captureException: vi.fn(),
  },
}));

import { loadLatestMeasurements, addMeasurement } from './api';
import { Sentry } from './sentry';

describe('parseJsonResponse — HTML response from Shopify proxy', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('loadLatestMeasurements returns null when proxy returns HTML', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<!doctype html><html><body>Maintenance</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const result = await loadLatestMeasurements();
    expect(result).toBeNull();
  });

  it('loadLatestMeasurements does NOT report HTML responses to Sentry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<!doctype html><html><body>Error</body></html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    await loadLatestMeasurements();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('loadLatestMeasurements DOES report genuine malformed JSON to Sentry', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('not valid json', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await loadLatestMeasurements();
    expect(result).toBeNull();
    expect(Sentry.captureException).toHaveBeenCalledOnce();
  });

  it('loadLatestMeasurements returns data for valid JSON', async () => {
    const mockPayload = {
      success: true,
      data: [{ metric_type: 'weight', value: 80, recorded_at: '2026-01-01' }],
      profile: { sex: 1, birth_year: 1985, birth_month: 6, unit_system: 1 },
      medications: [],
      screenings: [],
      reminderPreferences: [],
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(mockPayload), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await loadLatestMeasurements();
    expect(result).not.toBeNull();
    expect(result?.previousMeasurements).toHaveLength(1);
  });

  it('addMeasurement returns error status when proxy returns HTML', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('<!doctype html>', {
        status: 200,
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    const result = await addMeasurement('weight', 75);
    expect(result).toEqual({ status: 'error' });
  });

  it('addMeasurement returns duplicate status on 409', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ success: false, error: 'duplicate' }), {
        status: 409,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const result = await addMeasurement('weight', 75);
    expect(result).toEqual({ status: 'duplicate' });
  });

  it('handles missing content-type header as non-JSON', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('some text', { status: 200 }),
    );

    const result = await loadLatestMeasurements();
    expect(result).toBeNull();
    expect(Sentry.captureException).not.toHaveBeenCalled();
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
