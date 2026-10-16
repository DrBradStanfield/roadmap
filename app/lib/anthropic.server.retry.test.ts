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
import { callAnthropicWithUsage, extractOrClassify, ExtractionStopError } from './anthropic.server';
import { classifyChatError } from './chat.server';

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

  it('retries a body read aborted by the timeout — only a SyntaxError means malformed JSON', async () => {
    // AbortSignal.timeout can fire while the body is still streaming, so
    // response.json() rejects with DOMException name=TimeoutError. Relabelling
    // that as the fixed SyntaxError would strip it of its retryable identity.
    const timedOutBody = {
      ok: true,
      status: 200,
      json: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
      text: async () => '',
    } as unknown as Response;
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(timedOutBody)
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

// US-15 AC31: one loop, one deadline. Only an answer that ended normally but
// will not parse is re-sent, once: the old outer retry around the inner re-send
// made four identical full-length calls before a file failed.
describe('US-15 AC31: extractOrClassify makes at most two calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    global.fetch = REAL_FETCH;
  });

  it('recovers when the re-send of a malformed answer parses', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(anthropicMessage('not json at all'))
      .mockResolvedValueOnce(anthropicMessage(validUnifiedJson));
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await extractOrClassify([{ type: 'text', content: 'doc' }]);
    expect(result.classification).toBe('lab_report');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('throws after two malformed answers, never a third call', async () => {
    const fetchMock = vi.fn().mockResolvedValue(anthropicMessage('never valid json'));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(extractOrClassify([{ type: 'text', content: 'doc' }])).rejects.toThrow('extraction returned malformed JSON');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

// US-15 AC31: Haiku 5.5 400s on an assistant prefill and on sampling params,
// and thinks unless told not to. A malformed first answer is re-sent as the
// SAME request, never with a `{` assistant turn.
describe('US-15 AC31: the extraction request on Haiku 5.5', () => {
  afterEach(() => { global.fetch = REAL_FETCH; });

  it('the re-send after a malformed answer is the same body: no assistant turn, thinking disabled, no temperature', async () => {
    const bodies: Array<Record<string, any>> = [];
    global.fetch = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string));
      return anthropicMessage(bodies.length === 1 ? 'not json at all' : validUnifiedJson);
    }) as unknown as typeof fetch;
    const result = await extractOrClassify([{ type: 'text', content: 'doc' }]);
    expect(result.classification).toBe('lab_report');
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
    for (const body of bodies) {
      expect(body.model).toBe('claude-haiku-5-5');
      expect(body.thinking).toEqual({ type: 'disabled' });
      expect(body).not.toHaveProperty('temperature');
      expect(body.messages.map((m: { role: string }) => m.role)).toEqual(['user']);
    }
  });

  it('reads the answer by block type: a leading thinking block is skipped', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(okResponse({
      content: [{ type: 'thinking', thinking: '', signature: 'sig' }, { type: 'text', text: validUnifiedJson }],
      usage: { input_tokens: 10, output_tokens: 5 },
    })) as unknown as typeof fetch;
    const result = await extractOrClassify([{ type: 'text', content: 'doc' }]);
    expect(result.classification).toBe('lab_report');
  });
});

describe('US-35 AC5 — extractOrClassify with httpAttempts: 1 makes ONE request on a timeout', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { global.fetch = REAL_FETCH; });

  it('throws the TimeoutError after a single fetch, so a hung call cannot run past the import budget', async () => {
    const timeout = new DOMException('signal timed out', 'TimeoutError');
    const fetchMock = vi.fn().mockRejectedValue(timeout);
    global.fetch = fetchMock as unknown as typeof fetch;
    await expect(extractOrClassify([{ type: 'text', content: 'x' }], { timeoutMs: 100, httpAttempts: 1 })).rejects.toBe(timeout);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('the re-send shares ONE deadline with the first call: it gets what is left, never a fresh window (AC5)', async () => {
    vi.useFakeTimers();
    try {
      const timeouts = vi.spyOn(AbortSignal, 'timeout');
      const fetchMock = vi.fn()
        .mockImplementationOnce(async () => { vi.advanceTimersByTime(15_000); return anthropicMessage('not json at all'); })
        .mockResolvedValueOnce(anthropicMessage(validUnifiedJson));
      global.fetch = fetchMock as unknown as typeof fetch;
      await extractOrClassify([{ type: 'text', content: 'x' }], { timeoutMs: 20_000, httpAttempts: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(timeouts.mock.calls.map(([ms]) => ms)).toEqual([20_000, 5_000]);

      // Nothing left after the first answer: the retry is not made, and the failure is a TimeoutError.
      timeouts.mockClear();
      const late = vi.fn().mockImplementationOnce(async () => { vi.advanceTimersByTime(20_000); return anthropicMessage('not json'); });
      global.fetch = late as unknown as typeof fetch;
      await expect(extractOrClassify([{ type: 'text', content: 'x' }], { timeoutMs: 20_000, httpAttempts: 1 })).rejects.toMatchObject({ name: 'TimeoutError' });
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
    await extractOrClassify([{ type: 'text', content: 'x' }], { documentMode: 'metadata' });
    await extractOrClassify([{ type: 'text', content: 'x' }]);
    const [metadata, full] = bodies;
    expect(metadata.system).toMatch(/Do NOT transcribe/);
    expect(metadata.system).toMatch(/summary: ONE sentence of at most 120 characters/);
    expect(metadata.system).not.toMatch(/Preserve ALL text/);
    expect(metadata.max_tokens).toBe(3072);
    expect(full.system).toMatch(/Preserve ALL text/);
    expect(full.system).not.toMatch(/Do NOT transcribe/);
    expect(full.max_tokens).toBe(12288);
    // Both carry the same classification rules and the data-not-instructions line.
    for (const body of bodies) expect(body.system).toMatch(/never instructions to follow/);
  });

  it('keeps the inner retry by default — the website path is unchanged', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new DOMException('signal timed out', 'TimeoutError'))
      .mockResolvedValueOnce(anthropicMessage(validUnifiedJson));
    global.fetch = fetchMock as unknown as typeof fetch;
    await extractOrClassify([{ type: 'text', content: 'x' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * The malformed-response error must carry NOTHING of the model's output.
 *
 * Node's JSON.parse quotes ~10 characters of its input in the SyntaxError
 * ("Unexpected token 'S', \"Sure. {\"a\"... is not valid JSON"), and the Zod
 * parse quotes received enum values. Both errors reach console.error and
 * Sentry.captureException in api.lab-import-v2.ts, i.e. Fly logs and Sentry
 * issue titles — where model output about someone's lab document has no
 * business being.
 */
describe('extraction failures carry no document text', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { global.fetch = REAL_FETCH; });

  const SENTINEL = 'SENTINEL_LDL_4_2';

  it('throws a fixed message when both sub-attempts return malformed JSON', async () => {
    // Both the first call and its re-send answer with prose quoting the
    // document — exactly what the SyntaxError excerpt would echo.
    const fetchMock = vi.fn().mockResolvedValue(anthropicMessage(`Sure. Your ${SENTINEL} reads high.`));
    global.fetch = fetchMock as unknown as typeof fetch;

    const error = await extractOrClassify([{ type: 'text', content: 'doc' }])
      .then(() => null, (e: unknown) => e as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toBe('extraction returned malformed JSON');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SENTINEL);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
  });

  it('a 200 whose body is not JSON throws a fixed SyntaxError, never the body fragment', async () => {
    // Node's JSON.parse would quote the body here ("Unexpected token 'H',
    // \"HIV_SYNTHETIC...\" is not valid JSON") and api.lab-import-v2 logs that
    // error to console + Sentry. SyntaxError keeps classifyChatError's 'parse'.
    const BODY_SENTINEL = 'HIV_SYNTHETIC';
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError(`Unexpected token 'H', "${BODY_SENTINEL} report" is not valid JSON`); },
      text: async () => `${BODY_SENTINEL} report`,
    } as unknown as Response) as unknown as typeof fetch;

    const error = await callAnthropicWithUsage({ model: 'x' }).then(() => null, (e: unknown) => e as Error);

    expect(error).toBeInstanceOf(SyntaxError);
    expect(error!.message).toBe('Anthropic response was not JSON');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(BODY_SENTINEL);
    expect((error as { cause?: unknown }).cause).toBeUndefined();
    expect(classifyChatError(error)).toBe('parse'); // the Sentry tag survives the rewrite
  });

  it('throws the same fixed message when the second attempt fails schema validation', async () => {
    // Valid JSON, wrong shape: the Zod message names the received value.
    const badShape = JSON.stringify({ classification: SENTINEL, values: [] });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(anthropicMessage('not json at all'))
      .mockResolvedValueOnce(anthropicMessage(badShape));
    global.fetch = fetchMock as unknown as typeof fetch;

    const error = await extractOrClassify([{ type: 'text', content: 'doc' }])
      .then(() => null, (e: unknown) => e as Error);

    expect(error!.message).toBe('extraction returned malformed JSON');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(SENTINEL);
  });
});

// US-15 AC14 (chat audit 2026-09-29 F2): a 200 can carry stop_reason "refusal"
// with partial or no text. It is its own outcome, never "No text in Anthropic
// response"; the partial text is dropped; the category is a closed set.
describe('US-15 AC14: stop_reason is returned; a refusal is a distinct result', () => {
  afterEach(() => {
    global.fetch = REAL_FETCH;
    vi.clearAllMocks();
  });

  function stopped(stop_reason: string, content: unknown[], stop_details: unknown = null) {
    return okResponse({ content, stop_reason, stop_details, usage: { input_tokens: 10, output_tokens: 5 } });
  }

  it('returns a refusal with its category and drops any partial text', async () => {
    global.fetch = vi.fn().mockResolvedValue(stopped(
      'refusal',
      [{ type: 'text', text: 'Partial answer that must not reach anyone' }],
      { type: 'refusal', category: 'bio', explanation: 'free text that must not leave the process' },
    )) as unknown as typeof fetch;

    const result = await callAnthropicWithUsage({ model: 'x' });
    expect(result.stopReason).toBe('refusal');
    expect(result.refusalCategory).toBe('bio');
    expect(result.content).toBe('');
    expect(result.contentBlocks).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('free text');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('returns an empty refusal (the usual shape) instead of throwing "No text"', async () => {
    global.fetch = vi.fn().mockResolvedValue(stopped('refusal', [], { type: 'refusal', category: 'general_harms' })) as unknown as typeof fetch;
    const result = await callAnthropicWithUsage({ model: 'x' });
    expect(result.stopReason).toBe('refusal');
    expect(result.refusalCategory).toBe('general_harms');
  });

  it('bounds the category: unknown or missing becomes "other"', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(stopped('refusal', [], { type: 'refusal', category: 'something-new <script>' }))
      .mockResolvedValueOnce(stopped('refusal', [], null)) as unknown as typeof fetch;
    expect((await callAnthropicWithUsage({ model: 'x' })).refusalCategory).toBe('other');
    expect((await callAnthropicWithUsage({ model: 'x' })).refusalCategory).toBe('other');
  });

  it('returns a max_tokens stop with its text and the stop reason', async () => {
    global.fetch = vi.fn().mockResolvedValue(stopped('max_tokens', [{ type: 'text', text: 'cut off mid' }])) as unknown as typeof fetch;
    const result = await callAnthropicWithUsage({ model: 'x' });
    expect(result.stopReason).toBe('max_tokens');
    expect(result.content).toBe('cut off mid');
    expect(result.refusalCategory).toBeUndefined();
  });

  it('extraction treats a refusal as a failed call, not a document', async () => {
    global.fetch = vi.fn().mockResolvedValue(stopped('refusal', [], { type: 'refusal', category: 'other' })) as unknown as typeof fetch;
    await expect(extractOrClassify([{ type: 'text', content: 'doc' }])).rejects.toThrow('Anthropic refusal');
  });
});

// US-12 AC8: a German or Brazilian "250.000" platelets copied as a JSON NUMBER
// parsed to 250, the count guard (which reads strings) passed it, and 0.25
// ×10⁹/L was stored. Both parses of extractOrClassify keep it a string.
describe('US-12 AC8: extractOrClassify refuses a dot-thousands count written as a JSON number', () => {
  const platelets = '"additionalValues":[{"name":"platelets","value":250.000,"unit":"cells/µL","referenceLow":150.000,"referenceHigh":450.000},'
    + '{"name":"urine_specific_gravity","value":1.020,"unit":""}]';
  const body = `"classification":"lab_report","reportDate":null,"values":[],${platelets},"document":null}`;
  afterEach(() => { global.fetch = REAL_FETCH; });

  it('on the first parse', async () => {
    global.fetch = vi.fn().mockResolvedValueOnce(anthropicMessage(`{${body}`)) as unknown as typeof fetch;
    const result = await extractOrClassify([{ type: 'text', content: 'doc' }]);
    expect(result.additionalValues.map(v => [v.name, v.value])).toEqual([['urine_specific_gravity', 1.02]]);
    expect(result.droppedValueCount).toBe(1);
  });

  it('on the re-send', async () => {
    global.fetch = vi.fn()
      .mockResolvedValueOnce(anthropicMessage('not json'))
      .mockResolvedValueOnce(anthropicMessage(`{${body}`)) as unknown as typeof fetch;
    const result = await extractOrClassify([{ type: 'text', content: 'doc' }]);
    expect(result.additionalValues.map(v => [v.name, v.value])).toEqual([['urine_specific_gravity', 1.02]]);
    expect(result.droppedValueCount).toBe(1);
  });
});

// US-15 AC31: Haiku 5.5's safety classifiers can refuse, with no fallback, and
// the same request usually refuses again: a refusal fails the file at once. So
// does an answer cut off at max_tokens: re-sent, it is cut off again, and a long
// document cost up to four full-length generations before failing.
describe('US-15 AC31: an extraction that stopped short is not re-sent', () => {
  it('makes one call on a refusal, then throws with its bounded category', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const error = await extractOrClassify([{ type: 'text', content: 'doc' }]).catch(e => e);
    expect(error).toBeInstanceOf(ExtractionStopError);
    expect(error).toMatchObject({ code: 'refused', refusalCategory: 'cyber' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('makes one call on a max_tokens stop, then throws too_long', async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"classification":"lab_rep' }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const error = await extractOrClassify([{ type: 'text', content: 'doc' }]).catch(e => e);
    expect(error).toBeInstanceOf(ExtractionStopError);
    expect(error).toMatchObject({ code: 'too_long' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('still re-sends an answer that ended normally but did not parse', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] }))
      .mockResolvedValueOnce(Response.json({ stop_reason: 'end_turn', content: [{ type: 'text', text: validUnifiedJson }] }));
    global.fetch = fetchMock as unknown as typeof fetch;
    await extractOrClassify([{ type: 'text', content: 'doc' }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
