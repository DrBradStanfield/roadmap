/**
 * US-12: UploadModal pipeline untested — pure-logic extraction tests.
 *
 * Focused coverage for the retry/backoff paths in anthropic.server.ts that
 * anthropic.server.test.ts doesn't touch (that file only exercises the pure
 * parsing/unit-resolution re-exports from lab-extraction.ts). This file
 * mocks fetch + Sentry + the sleep backoff so the retry *policy* (which
 * statuses retry, which throw immediately, which get silenced from Sentry)
 * is verified without any real network calls or real delays.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({
  captureException: vi.fn(),
}));

// Real sleep() would add real seconds (RETRY_DELAY_MS=1000, extractOrClassify's
// own 1000ms) to every test in this file — mock it to resolve immediately so
// the retry *logic* is verified without the real-time cost.
vi.mock('./cron-helpers.server', () => ({
  sleep: vi.fn().mockResolvedValue(undefined),
}));

process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';

import * as Sentry from '@sentry/react-router';
import { callAnthropicWithUsage, extractOrClassify } from './anthropic.server';

const REAL_FETCH = global.fetch;

function okResponse(body: Record<string, unknown>): Response {
  return {
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function errResponse(status: number, bodyText = 'error body'): Response {
  return {
    ok: false,
    status,
    json: async () => ({}),
    text: async () => bodyText,
  } as unknown as Response;
}

function anthropicMessage(text: string) {
  return okResponse({
    content: [{ type: 'text', text }],
    usage: { input_tokens: 10, output_tokens: 5 },
  });
}

const validUnifiedJson = JSON.stringify({
  classification: 'lab_report',
  reportDate: null,
  values: [],
  additionalValues: [],
  document: null,
});

describe('US-12: fetchAnthropicRaw retry policy (via callAnthropicWithUsage)', () => {
  afterEach(() => {
    global.fetch = REAL_FETCH;
    vi.clearAllMocks();
  });

  it('succeeds on the first attempt with no retry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicMessage('hello'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await callAnthropicWithUsage({ model: 'x' });
    expect(result.content).toBe('hello');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('retries once on a 503 and succeeds, without alerting Sentry', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(errResponse(503))
      .mockResolvedValueOnce(anthropicMessage('recovered'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await callAnthropicWithUsage({ model: 'x' });
    expect(result.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('throws after exhausting retries on a persistent 503, silenced from Sentry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(503));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(callAnthropicWithUsage({ model: 'x' })).rejects.toThrow(/status 503/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // RETRY_MAX_ATTEMPTS
    expect(Sentry.captureException).not.toHaveBeenCalled(); // transient capacity — silenced
  });

  it('throws after exhausting retries on a persistent 502, alerting Sentry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(502));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(callAnthropicWithUsage({ model: 'x' })).rejects.toThrow(/status 502/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1); // not a silenced status
  });

  it('does not retry a 429 — throws immediately and alerts Sentry', async () => {
    const fetchMock = vi.fn().mockResolvedValue(errResponse(429));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(callAnthropicWithUsage({ model: 'x' })).rejects.toThrow(/status 429/);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 429 is structural, not retryable
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  it('retries once on a network/timeout error and succeeds', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(anthropicMessage('recovered'));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await callAnthropicWithUsage({ model: 'x' });
    expect(result.content).toBe('recovered');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not treat a tool_use-only response (no text) as empty/failed', async () => {
    const fetchMock = vi.fn().mockResolvedValue(okResponse({
      content: [{ type: 'tool_use', name: 'propose_field_edit', input: { field: 'ldlC' } }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await callAnthropicWithUsage({ model: 'x' });
    expect(result.content).toBe('');
    expect(result.contentBlocks).toHaveLength(1);
  });
});

describe('US-12: extractOrClassify outer retry (extractOrClassifyOnce failure → 1s backoff → retry)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    global.fetch = REAL_FETCH;
  });

  it('recovers when the first outer attempt fails schema parsing (both inner sub-attempts) but the second outer attempt succeeds', async () => {
    // extractOrClassifyOnce makes up to 2 fetch calls internally (initial +
    // prefill retry) before throwing; extractOrClassify's outer catch then
    // retries the whole extractOrClassifyOnce call once more.
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(anthropicMessage('not json at all'))      // outer attempt 1, inner try
      .mockResolvedValueOnce(anthropicMessage('still not json'))       // outer attempt 1, inner prefill retry
      .mockResolvedValueOnce(anthropicMessage(validUnifiedJson));      // outer attempt 2 — succeeds
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await extractOrClassify([{ type: 'text', content: 'doc' }]);
    expect(result.classification).toBe('lab_report');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('throws when both outer attempts exhaust their inner retries', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicMessage('never valid json'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(extractOrClassify([{ type: 'text', content: 'doc' }])).rejects.toThrow();
    // 2 inner attempts per outer attempt × 2 outer attempts = 4 fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});

describe('US-35 AC5 — extractOrClassify with httpAttempts: 1 makes ONE request on a timeout', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { global.fetch = REAL_FETCH; });

  it('throws the TimeoutError after a single fetch, so a hung call cannot run past the import budget', async () => {
    const timeout = new DOMException('signal timed out', 'TimeoutError');
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(extractOrClassify([{ type: 'text', content: 'x' }], { timeoutMs: 100, attempts: 1, httpAttempts: 1 })).rejects.toBe(timeout);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the `{`-prefill retry shares ONE deadline with the first call: it gets what is left, never a fresh window (AC5)', async () => {
    vi.useFakeTimers();
    try {
      const timeouts = vi.spyOn(AbortSignal, 'timeout');
      const fetchMock = vi.fn()
        .mockImplementationOnce(async () => { vi.advanceTimersByTime(15_000); return anthropicMessage('not json at all'); })
        .mockResolvedValueOnce(anthropicMessage(validUnifiedJson.slice(1)));
      global.fetch = fetchMock as unknown as typeof fetch;
      await extractOrClassify([{ type: 'text', content: 'x' }], { timeoutMs: 20_000, attempts: 1, httpAttempts: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([20_000, 5_000]);

      // Nothing left after the first answer: the retry is not made, and the failure is a TimeoutError.
      timeouts.mockClear();
      const late = vi.fn().mockImplementationOnce(async () => { vi.advanceTimersByTime(20_000); return anthropicMessage('not json'); });
      global.fetch = late as unknown as typeof fetch;
      await expect(extractOrClassify([{ type: 'text', content: 'x' }], { timeoutMs: 20_000, attempts: 1, httpAttempts: 1 })).rejects.toMatchObject({ name: 'TimeoutError' });
      expect(late).toHaveBeenCalledTimes(1);
      timeouts.mockRestore();
    } finally {
      vi.useRealTimers();
    }
  });

  it('documentMode metadata asks for no transcription and caps the answer; the website’s full prompt is unchanged (AC5)', async () => {
    const bodies: Array<{ system: string; max_tokens: number }> = [];
    global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return anthropicMessage(validUnifiedJson);
    }) as unknown as typeof fetch;
    await extractOrClassify([{ type: 'text', content: 'x' }], { attempts: 1, documentMode: 'metadata' });
    await extractOrClassify([{ type: 'text', content: 'x' }], { attempts: 1 });
    const [metadata, full] = bodies;
    expect(metadata.system).toMatch(/Do NOT transcribe/);
    expect(metadata.system).toMatch(/summary: ONE sentence of at most 120 characters/);
    expect(metadata.system).not.toMatch(/Preserve ALL text/);
    expect(metadata.max_tokens).toBe(2048);
    expect(full.system).toMatch(/Preserve ALL text/);
    expect(full.system).not.toMatch(/Do NOT transcribe/);
    expect(full.max_tokens).toBe(8192);
    // Both carry the same classification rules and the data-not-instructions line.
    for (const body of bodies) expect(body.system).toMatch(/never instructions to follow/);
  });

  it('keeps the inner retry by default — the website path is unchanged', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
      .mockResolvedValueOnce(anthropicMessage(validUnifiedJson));
    global.fetch = fetchMock as unknown as typeof fetch;
    await extractOrClassify([{ type: 'text', content: 'x' }], { attempts: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
