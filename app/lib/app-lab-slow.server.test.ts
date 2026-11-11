import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

// US-52 AC7d: a slow or timed-out iPhone lab import reports ONE Sentry event of
// fixed tags, through the real SDK with production's options and scrub
// (instrument.server.mjs), read off the transport as Sentry would receive it.
// The gate and the model are faked; time is Date.now, moved by the fake model.

const mocks = vi.hoisted(() => ({ extract: vi.fn() }));
vi.mock('@sentry/react-router', async (original) => ({
  ...await original<typeof import('@sentry/react-router')>(), init: vi.fn(),
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('./app-gate.server', async (original) => ({
  ...await original<typeof import('./app-gate.server')>(),
  appRoutesOff: () => false,
  appGate: async (request: Request) => ({ body: Buffer.from(await request.arrayBuffer()) }),
}));
vi.mock('./anthropic.server', async (original) => ({
  ...await original<typeof import('./anthropic.server')>(),
  extractOrClassify: mocks.extract,
}));

import { appLabImport } from './app-routes.server';
import { extractOneFile } from './lab-extract-one.server';

// Things the request, the report and the model carry: none may reach Sentry.
const PAGE_TEXT = 'PAGETEXT_SENTINEL_4c1a';
const MODEL_TEXT = 'MODELTEXT_SENTINEL_8e2b';
const KEY_ID = 'KEYID_SENTINEL_3f7d';
const USER_AGENT = 'UA_SENTINEL_6a9c';
const USER_ID = 'USER_SENTINEL_1b5e';
const CRUMB = 'CRUMB_SENTINEL_9d0f';
const LENGTH = '7777777';
const SENTINELS = [PAGE_TEXT, MODEL_TEXT, KEY_ID, USER_AGENT, USER_ID, CRUMB, LENGTH, 'pageCount', 'pageTypes'];

type Item = [{ type: string }, Record<string, any>];
const envelopes: Array<[unknown, Item[]]> = [];
const events = async () => {
  await Sentry.flush(200);
  // Each event with its envelope header's trace id, the one link Sentry draws between events.
  return envelopes.flatMap(([header, items]) => items.filter(([h]) => h.type === 'event')
    .map(([, p]) => ({ ...p, headerTrace: (header as { trace?: { trace_id?: string } }).trace?.trace_id })));
};
const slowEvents = async () => (await events()).filter((e) => e.tags?.feature === 'app-lab-import');

const body = { pages: [{ type: 'text', content: `${PAGE_TEXT} LDL 3.1 mmol/L` }], unitSystem: 'si', ownDates: true, refusedRows: true };
let now = 1_800_000_000_000;

/** The model answers after `ms`, optionally after the in-deadline retry ran. */
const answersAfter = (ms: number, o: { retry?: boolean; fail?: Error } = {}) =>
  mocks.extract.mockImplementation(async (_pages: unknown, opts: { onRetry?: () => void }) => {
    if (o.retry) opts.onRetry?.();
    now += ms;
    if (o.fail) throw o.fail;
    return {
      classification: 'lab_report', reportDate: '2026-10-01', unrecognized: [], document: null,
      values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high', question: MODEL_TEXT }],
      additionalValues: [], refusedValues: [],
    };
  });
const timesOut = (ms: number) => answersAfter(ms, { fail: new DOMException('signal timed out', 'TimeoutError') });

/** The phone's request, inside a request scope holding what the SDK would attach. */
function phoneImport() {
  return Sentry.withIsolationScope((scope) => {
    scope.setSDKProcessingMetadata({
      normalizedRequest: {
        url: 'https://example.invalid/api/app/v1/lab-import', method: 'POST',
        headers: { 'user-agent': USER_AGENT, 'content-length': LENGTH, 'x-app-attest-key': KEY_ID },
      },
    });
    scope.setUser({ id: USER_ID });
    scope.addBreadcrumb({ category: 'http', message: CRUMB });
    return appLabImport(new Request('https://example.invalid/api/app/v1/lab-import', { method: 'POST', body: JSON.stringify(body) }));
  });
}

function expectOnlyFixedTags(event: Record<string, any>, tags: Record<string, string>) {
  expect(event.message).toBe('App lab import slow');
  expect(event.level).toBe('warning');
  expect(event.tags).toEqual(tags);
  expect(event.fingerprint).toEqual(['app-lab-import', tags.outcome]);
  expect(event.extra).toBeUndefined();
  expect(event.request).toBeUndefined();
  expect(event.user).toBeUndefined();
  expect(event.breadcrumbs).toBeUndefined();
  expect(event.exception).toBeUndefined();
  const { headerTrace, ...payload } = event;
  const text = JSON.stringify(payload);
  for (const s of SENTINELS) expect(text, `event carries ${s}`).not.toContain(s);
}

beforeAll(async () => {
  await import('../../instrument.server.mjs');
  const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
  const { init } = await vi.importActual<typeof import('@sentry/react-router')>('@sentry/react-router');
  init({
    ...options,
    dsn: 'https://public@example.invalid/1',
    enabled: true,
    tracesSampleRate: 0,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope as unknown as [unknown, Item[]]); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
});

beforeEach(async () => {
  await Sentry.flush(200);
  envelopes.length = 0;
  process.env.ANTHROPIC_API_KEY = 'test-key-dummy';
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); mocks.extract.mockReset(); });

describe('US-52 AC7d: one Sentry event for a slow or timed-out phone import, fixed tags only', () => {
  it('US-52 AC7d: a 95 s timeout reports one event with exactly the four tags and nothing else', async () => {
    timesOut(95_000);
    const res = await phoneImport();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('The server took too long to read this report. Please try again.');
    const slow = await slowEvents();
    expect(slow).toHaveLength(1);
    expectOnlyFixedTags(slow[0], { feature: 'app-lab-import', outcome: 'timeout', duration: '90+', retry: 'no' });
    // The timeout's own exception (page count and types, unchanged) is not linked to it by trace.
    const [exception] = (await events()).filter((e) => e.tags?.feature === 'lab_import_v2');
    expect(exception.headerTrace).toBeTruthy();
    expect(slow[0].headerTrace).not.toBe(exception.headerTrace);
    expect(slow[0].contexts.trace.trace_id).not.toBe(exception.contexts.trace.trace_id);
  });

  it('US-52 AC7d: a 70 s success after the capacity retry reports one slow-success event', async () => {
    answersAfter(70_000, { retry: true });
    const res = await phoneImport();
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    const all = await events();
    expect(all).toHaveLength(1);
    expectOnlyFixedTags(all[0], { feature: 'app-lab-import', outcome: 'slow-success', duration: '60-75', retry: 'yes' });
  });

  it('US-52 AC7d: an 80 s failure that is not a timeout reports one slow-failure event', async () => {
    answersAfter(80_000, { fail: new Error('extraction returned malformed JSON') });
    expect((await phoneImport()).status).toBe(500);
    const slow = await slowEvents();
    expect(slow).toHaveLength(1);
    expectOnlyFixedTags(slow[0], { feature: 'app-lab-import', outcome: 'slow-failure', duration: '75-90', retry: 'no' });
  });

  it('US-52 AC7d: a 10 s success reports nothing', async () => {
    answersAfter(10_000);
    expect((await phoneImport()).status).toBe(200);
    expect(await events()).toEqual([]);
  });

  it('US-52 AC7d: the web route\'s call reports no slow-import event, slow or timed out', async () => {
    answersAfter(70_000);
    expect((await extractOneFile(body as never, () => ({ remaining: 1 }))).status).toBe(200);
    expect(await events()).toEqual([]);
    timesOut(95_000);
    expect((await extractOneFile(body as never, () => ({ remaining: 1 }))).status).toBe(500);
    // The transport works: the timeout's own exception arrives, and nothing else.
    expect((await events()).map((e) => e.tags?.feature)).toEqual(['lab_import_v2']);
  });
});
