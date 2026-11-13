import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

// US-09 AC7i: the slow-import event processor (US-52 AC7d) that throws sends
// nothing. Real SDK, production's init options (instrument.server.mjs), a
// capturing transport; a global processor ahead of ours plants a field that
// throws when ours reads it.
const mocks = vi.hoisted(() => ({ clock: { now: 1_800_000_000_000 }, plant: false }));
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
  // A 70 s read: slow-success, so the slow-import event is captured.
  extractOrClassify: async () => {
    mocks.clock.now += 70_000;
    return {
      classification: 'lab_report', reportDate: '2026-10-01', unrecognized: [], document: null,
      values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
      additionalValues: [], refusedValues: [],
    };
  },
}));

import { appLabImport } from './app-routes.server';

const SENTINEL = 'MSG_SENTINEL_6c2d';
type Item = [{ type: string }, Record<string, any>];
const envelopes: Array<[unknown, Item[]]> = [];
const content = () => envelopes.flatMap(([, list]) => list).filter(([h]) => h.type !== 'client_report');
const internalCaptures: unknown[] = [];
let errorLog: ReturnType<typeof vi.spyOn>;

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
  Sentry.getGlobalScope().addEventProcessor((event) => {
    if (!mocks.plant || event.message !== 'App lab import slow') return event;
    const error = new TypeError(`processor broke on ${SENTINEL}`);
    return { ...event, contexts: { get trace(): never { throw error; } } };
  });
  const client = Sentry.getClient()!;
  const capture = client.captureException.bind(client);
  vi.spyOn(client, 'captureException').mockImplementation((exception, hint, scope) => {
    if ((hint?.data as { __sentry__?: unknown } | undefined)?.__sentry__ === true) internalCaptures.push(exception);
    return capture(exception, hint, scope);
  });
});

beforeEach(async () => {
  await Sentry.flush(500);
  envelopes.length = 0;
  internalCaptures.length = 0;
  errorLog?.mockRestore();
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  errorLog?.mockRestore();
  await Sentry.close();
});

async function slowImport() {
  const now = vi.spyOn(Date, 'now').mockImplementation(() => mocks.clock.now);
  process.env.ANTHROPIC_API_KEY = 'test-key-dummy';
  const body = { pages: [{ type: 'text', content: 'LDL 3.1 mmol/L' }], unitSystem: 'si', ownDates: true, refusedRows: true };
  const res = await appLabImport(new Request('https://example.invalid/api/app/v1/lab-import', { method: 'POST', body: JSON.stringify(body) }));
  now.mockRestore();
  expect(res.status).toBe(200);
  await Sentry.flush(1000);
}

describe('US-09 AC7i: the slow-import event processor that throws sends nothing', () => {
  it('a throw sends no envelope and no internal event, and logs the error name only', async () => {
    mocks.plant = true;
    try {
      await slowImport();
    } finally {
      mocks.plant = false;
    }
    expect(content()).toEqual([]);
    expect(internalCaptures).toEqual([]);
    const lines = errorLog.mock.calls.filter(([line]) => String(line).startsWith('Sentry scrub failed'));
    expect(lines).toEqual([['Sentry scrub failed (TypeError); event dropped']]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(SENTINEL);
  });

  it('a processor that returns normally still sends the slow-import event', async () => {
    await slowImport();
    const events = content().filter(([h]) => h.type === 'event');
    expect(events.map(([, p]) => p.message)).toEqual(['App lab import slow']);
    expect(internalCaptures).toEqual([]);
  });
});
