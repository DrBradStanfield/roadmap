import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

// US-12 AC1a: a rescued 429 reports ONE Sentry warning holding its status and
// wait only, through the real SDK with production's options and scrub
// (instrument.server.mjs), read off the transport as Sentry would receive it.
// Request and scope sentinels are set; none may reach the event.

vi.mock('@sentry/react-router', async (original) => ({
  ...await original<typeof import('@sentry/react-router')>(), init: vi.fn(),
}));
vi.mock('./cron-helpers.server', () => ({ sleep: vi.fn(async () => {}) }));

import { extractOneFile } from './lab-extract-one.server';

const USER_AGENT = 'UA_SENTINEL_5e2d';
const LENGTH = '8888888';
const TAG = 'TAG_SENTINEL_4b7a';
const USER_ID = 'USER_SENTINEL_9c3e';
const CRUMB = 'CRUMB_SENTINEL_2f8b';
const EXTRA = 'EXTRA_SENTINEL_6d1c';
const CONTEXT = 'CONTEXT_SENTINEL_3a9f';
const PAGE_TEXT = 'PAGETEXT_SENTINEL_7e4d';
const RETRY_AFTER = 'RETRYAFTER_SENTINEL_1c6b';
const SENTINELS = [USER_AGENT, LENGTH, TAG, USER_ID, CRUMB, EXTRA, CONTEXT, PAGE_TEXT, RETRY_AFTER];
const ALLOWED = ['contexts', 'environment', 'event_id', 'extra', 'fingerprint', 'level', 'message', 'platform', 'sdk', 'timestamp'];

type Item = [{ type: string }, Record<string, any>];
const envelopes: Array<[unknown, Item[]]> = [];
const events = async () => {
  await Sentry.flush(2000);
  return envelopes.flatMap(([header, items]) => items.filter(([h]) => h.type === 'event')
    .map(([, p]) => ({ ...p, headerTrace: (header as { trace?: { trace_id?: string } }).trace?.trace_id })));
};

const validUnifiedJson = JSON.stringify({ classification: 'lab_report', reportDate: null, values: [], additionalValues: [], document: null });

beforeAll(async () => {
  await import('../../instrument.server.mjs');
  const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
  const { init } = await vi.importActual<typeof import('@sentry/react-router')>('@sentry/react-router');
  init({
    ...options,
    dsn: 'https://public@example.invalid/1',
    enabled: true,
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope as unknown as [unknown, Item[]]); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
});

const REAL_FETCH = global.fetch;
beforeEach(async () => {
  await Sentry.flush(2000);
  envelopes.length = 0;
  process.env.ANTHROPIC_API_KEY = 'test-key-dummy';
  vi.spyOn(Math, 'random').mockReturnValue(0);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  global.fetch = vi.fn()
    .mockResolvedValueOnce(Response.json({ type: 'error', error: { type: 'rate_limit_error' } }, { status: 429, headers: { 'retry-after': `3 ${RETRY_AFTER}` } }))
    .mockResolvedValueOnce(Response.json({ content: [{ type: 'text', text: validUnifiedJson }], usage: {} })) as unknown as typeof fetch;
});
afterEach(() => { global.fetch = REAL_FETCH; vi.restoreAllMocks(); });

/** A lab read inside a request scope holding what the SDK would attach. */
function labRead() {
  return Sentry.withIsolationScope((scope) => {
    scope.setSDKProcessingMetadata({
      normalizedRequest: { url: 'https://example.invalid/apps/health-tool-1/api/lab-import-v2', method: 'POST', headers: { 'user-agent': USER_AGENT, 'content-length': LENGTH } },
    });
    scope.setTag('marker', TAG);
    scope.setUser({ id: USER_ID });
    scope.addBreadcrumb({ category: 'http', message: CRUMB });
    scope.setExtra('note', EXTRA);
    scope.setContext('upload', { label: CONTEXT });
    return extractOneFile({ pages: [{ type: 'text', content: PAGE_TEXT }] } as Parameters<typeof extractOneFile>[0]);
  });
}

describe('US-12 AC1a: a rescued 429 reaches Sentry as one warning with status and wait only', () => {
  it('the outgoing event holds status and waitMs, and none of the request or scope sentinels', async () => {
    let requestTrace = '';
    await Sentry.startSpan({ name: 'POST /api/lab-import-v2', op: 'http.server', forceTransaction: true }, async (span) => {
      requestTrace = span.spanContext().traceId;
      expect((await labRead()).status).toBe(200);
    });
    const all = (await events()).filter((e) => e.message === 'Anthropic 429 retried');
    expect(all).toHaveLength(1);
    const { headerTrace, ...event } = all[0];
    expect(event.level).toBe('warning');
    expect(event.extra).toEqual({ status: 429, waitMs: 2_000 });
    expect(event.fingerprint).toEqual(['anthropic-429-retried']);
    expect(event.tags).toBeUndefined();
    expect(event.request).toBeUndefined();
    expect(event.user).toBeUndefined();
    expect(event.breadcrumbs).toBeUndefined();
    expect(Object.keys(event).sort()).toEqual(ALLOWED);
    expect(Object.keys(event.contexts)).toEqual(['trace']);
    // A trace of its own: nothing links it to the request's transaction.
    expect(event.contexts.trace.trace_id).not.toBe(requestTrace);
    expect(headerTrace).not.toBe(requestTrace);
    const text = JSON.stringify(event);
    for (const s of SENTINELS) expect(text, `event carries ${s}`).not.toContain(s);
  });
});
