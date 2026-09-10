import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';
import { classifyChatError, getChatCompletion, reportChatFallback, type ChatErrorKind } from './chat.server';
import { routeQuery, reportRouterFailure } from './chat-router.server';
import { classifyMessage } from './chat-classifier.server';
import { createBatch, pollBatch } from './anthropic.server';

// US-15 AC4: inspect complete SDK transport envelopes, including exception
// values and extra context. No request ever reaches Sentry or Anthropic.
const marker = 'PHI_SENTINEL';
const secret = `${marker} synthetic patient Jane Example LDL 4.2 mmol/L`;
let envelopes: unknown[];

beforeEach(() => {
  envelopes = [];
  Sentry.init({
    dsn: 'https://public@example.invalid/1',
    defaultIntegrations: false,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
  vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-test-key');
});

afterEach(async () => {
  await Sentry.close();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('chat failure telemetry', () => {
  it.each(['api-error', 'empty-response'] as const)('keeps %s envelopes free of user/provider text', async (failureMode) => {
    const params = {
      completion: {
        content: secret,
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
        isFallback: true,
        failureMode,
        errorDetail: secret,
      },
      platform: 'shopify' as const,
      conversationId: secret,
      messagePreview: secret,
      matchedHandles: [secret],
      userId: secret,
      authorTag: secret,
      latencyMs: 123,
    };
    reportChatFallback(params);
    await Sentry.flush();
    expect(envelopes).toHaveLength(1);
    const payload = JSON.stringify(envelopes);
    expect(payload).not.toContain(marker);
    expect(payload).toContain(failureMode);
    expect(payload).toContain('123');
  });

  it('does not log a provider error body in the lower-level chat request', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(secret, { status: 400 })));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const completion = await getChatCompletion([], [{ role: 'user', content: secret }]);
    reportChatFallback({ completion, platform: 'discord', latencyMs: 10 });
    await Sentry.flush();
    expect(completion.isFallback).toBe(true);
    expect(envelopes.length).toBeGreaterThan(0);
    expect(JSON.stringify(envelopes)).not.toContain(marker);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(marker);
  });

  it.each(['transport', 'model'] as const)('keeps malformed %s JSON out of router telemetry', async (layer) => {
    const body = layer === 'transport' ? secret : JSON.stringify({
      content: [{ type: 'text', text: secret }], usage: {},
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(body)));
    const result = await routeQuery(secret);
    expect(result.error).toBeTruthy();
    reportRouterFailure(result);
    await Sentry.flush();
    expect(envelopes).toHaveLength(1);
    expect(JSON.stringify(envelopes)).not.toContain(marker);
  });

  it('keeps an unparseable classifier echo out of telemetry while preserving its result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      content: [{ type: 'text', text: secret }], usage: {},
    }))));
    const result = await classifyMessage(secret);
    expect(result.raw).toBe(secret); // conversation/audit storage policy is unchanged
    await Sentry.flush();
    expect(envelopes).toHaveLength(1);
    expect(JSON.stringify(envelopes)).not.toContain(marker);
  });

  it('tags api-error with a closed errorKind and keeps the opaque conversationId', async () => {
    const conversationId = '0f3d2c1a-6b7e-4a5d-9c8b-1e2f3a4b5c6d';
    reportChatFallback({
      completion: {
        content: secret, isFallback: true, failureMode: 'api-error', errorDetail: secret, errorKind: 'http_5xx',
        usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
      },
      platform: 'shopify', latencyMs: 5, conversationId,
    });
    await Sentry.flush();
    expect(envelopes).toHaveLength(1);
    const payload = JSON.stringify(envelopes);
    expect(payload).not.toContain(marker);
    expect(payload).toContain('"errorKind":"http_5xx"');
    expect(payload).toContain(conversationId);
  });

  it.each<[unknown, ChatErrorKind]>([
    [new DOMException(secret, 'TimeoutError'), 'timeout'],
    [new DOMException(secret, 'AbortError'), 'timeout'],
    [new TypeError('fetch failed'), 'timeout'],
    [new Error(`Anthropic API error (status 529)`), 'overloaded_529'],
    [new Error(`Anthropic API error (status 503)`), 'http_5xx'],
    [new Error(`Anthropic API error (status 400)`), 'other'],
    [new SyntaxError(`Unexpected token 'P', "${secret}" is not valid JSON`), 'parse'],
    [new Error('No text in Anthropic response'), 'parse'],
    [new Error(secret), 'other'],
    [secret, 'other'],
  ])('classifies %o as %s without carrying its text', (err, kind) => {
    expect(classifyChatError(err)).toBe(kind);
  });

  it.each([
    ['createBatch', () => createBatch([{ pages: [] } as never])],
    ['pollBatch', () => pollBatch('batch_synthetic')],
  ])('%s discards a provider 400 body instead of logging it', async (_name, call) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(secret, { status: 400 })));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(call()).rejects.toThrow(/status|error/);
    await Sentry.flush();
    expect(envelopes).toHaveLength(1);
    expect(JSON.stringify(envelopes)).not.toContain(marker);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(marker);
  });

  it.each([
    ['createBatch', () => createBatch([{ pages: [] } as never])],
    ['pollBatch', () => pollBatch('batch_synthetic')],
  ])('%s throws a fixed parse error when a 200 body is not JSON, quoting nothing', async (_name, call) => {
    // JSON.parse would put a fragment of this body in its message, and that
    // error reaches console.error + Sentry in api.lab-import-v2.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(secret, { status: 200 })));

    const error = await call().then(() => null, (e: unknown) => e as Error);

    expect(error).toBeInstanceOf(SyntaxError);
    expect(error!.message).toBe('Anthropic response was not JSON');
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(marker);
    expect(classifyChatError(error)).toBe('parse');
  });

  it('emits nothing for a successful completion', async () => {
    reportChatFallback({
      completion: { content: secret, isFallback: false, usage: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 } },
      platform: 'shopify', latencyMs: 1,
    });
    await Sentry.flush();
    expect(envelopes).toEqual([]);
  });
});
