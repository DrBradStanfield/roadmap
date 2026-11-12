import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

// US-09 AC7i: a scrub that throws sends nothing. A report the SDK makes about
// its own pipeline is rebuilt at the transport from a fixed allow-list.
// Production's options (instrument.server.mjs), transport wrapper included, go
// through the real SDK; only the node transport beneath the wrapper captures.
const envelopes = vi.hoisted(() => [] as unknown[]);
vi.mock('@sentry/react-router', async (original) => ({
  ...await original<typeof import('@sentry/react-router')>(),
  init: vi.fn(),
  makeNodeTransport: () => ({
    send: async (envelope: unknown) => { envelopes.push(envelope); return { statusCode: 200 }; },
    flush: async () => true,
  }),
}));

const MARKER = 'MARKER_7b3e';
const FIXED_MESSAGE = 'Sentry scrub pipeline error';
const FIXED_EXCEPTION = { values: [{ type: 'SentryPipelineError', value: 'dropped' }] };
const ALLOWED = ['event_id', 'timestamp', 'platform', 'level', 'release', 'environment', 'sdk', 'message', 'exception'];
type Item = [{ type: string }, Record<string, any>];
type Envelope = [Record<string, unknown>, Item[]];
const items = () => (envelopes as Envelope[]).flatMap(([, list]) => list);
const events = () => items().filter(([h]) => h.type === 'event').map(([, p]) => p);
const plan = { lock: false, freeze: false, throwingGetter: false };
/** At the marking hook, per SDK self-report: the hint's flag, and whether the event held the planted content. */
const seen: Array<{ own: unknown; marker: boolean }> = [];
/** Every other envelope the client built, with its JSON at that moment. */
const built: Array<{ envelope: unknown; json: string }> = [];
const ownCaptures: unknown[] = [];
let n = 0;

function setup() {
  const client = Sentry.getClient()!;
  // A throwing processor makes the SDK report the fault as an event of its own.
  Sentry.getGlobalScope().addEventProcessor((event) => {
    if (event.message?.startsWith('trigger')) throw new Error(`processor broke on ${MARKER}`);
    return event;
  });
  // Plants what an integration could attach, and a field a future SDK might add.
  client.on('postprocessEvent', (event, hint) => {
    if ((hint?.data as { __sentry__?: unknown } | undefined)?.__sentry__ !== true) return;
    const e = event as Record<string, unknown>;
    e.request = { url: `https://example.invalid/${MARKER}`, headers: { cookie: MARKER } };
    e.futureField = MARKER;
    if (plan.lock) {
      const locked = { enumerable: true, writable: false, configurable: false };
      Object.defineProperty(e, 'exception', { ...locked, value: { values: [{ type: 'Error', value: MARKER }] } });
      Object.defineProperty(e, 'locked', { ...locked, value: MARKER });
    }
  });
  let own: object | undefined;
  client.on('beforeSendEvent', (event, hint) => {
    const flag = (hint?.data as { __sentry__?: unknown } | undefined)?.__sentry__;
    if (flag !== true) return;
    own = event;
    seen.push({ own: flag, marker: JSON.stringify(event).includes(MARKER) });
  });
  // Plants a trace header and an attachment on the self-report's envelope, and
  // locks or breaks its event after the SDK's last write to it.
  client.on('beforeEnvelope', (envelope) => {
    const [headers, list] = envelope as unknown as Envelope;
    const payload = list.find(([, p]) => p === own)?.[1];
    if (payload) {
      headers.trace = { trace_id: '0'.repeat(32), public_key: MARKER };
      list.push([{ type: 'attachment', filename: `${MARKER}.txt` } as Item[0], MARKER as unknown as Item[1]]);
      if (plan.freeze) Object.freeze(payload);
      if (plan.throwingGetter) {
        Object.defineProperty(payload, 'release', { enumerable: true, get() { throw new Error(MARKER); } });
      }
    } else {
      built.push({ envelope, json: JSON.stringify(envelope) });
    }
  });
  const capture = client.captureException.bind(client);
  vi.spyOn(client, 'captureException').mockImplementation((exception, hint, scope) => {
    if ((hint?.data as { __sentry__?: unknown } | undefined)?.__sentry__ === true) ownCaptures.push(exception);
    return capture(exception, hint, scope);
  });
}

function trigger() {
  Sentry.withScope((scope) => {
    scope.setUser({ id: MARKER, email: `${MARKER}@example.invalid` });
    scope.setTag('planted', MARKER);
    scope.setContext('planted', { value: MARKER });
    scope.setExtra('planted', MARKER);
    scope.addBreadcrumb({ category: 'custom', message: MARKER });
    scope.addAttachment({ filename: `${MARKER}.txt`, data: MARKER });
    scope.captureMessage(`trigger ${n++}`);
  });
}

/** The contract: the hint still flags the SDK's own report, and no third event follows. */
function expectOneSelfReport() {
  expect(seen).toEqual([{ own: true, marker: true }]);
  expect(ownCaptures).toHaveLength(1);
  expect(JSON.stringify(envelopes)).not.toContain(MARKER);
}

function expectRebuilt() {
  expectOneSelfReport();
  expect(events()).toHaveLength(1);
  const [event] = events();
  for (const key of Object.keys(JSON.parse(JSON.stringify(event)))) expect(ALLOWED, key).toContain(key);
  expect(event.message).toBe(FIXED_MESSAGE);
  expect(event.exception).toEqual(FIXED_EXCEPTION);
  expect(event.sdk.name).toBe('sentry.javascript.react-router');
  const [headers] = (envelopes as Envelope[]).find(([, list]) => list.some(([, p]) => p === event))!;
  expect(headers).not.toHaveProperty('trace');
  expect(items().map(([h]) => h.type)).not.toContain('attachment');
}

beforeEach(() => {
  envelopes.length = 0;
  seen.length = 0;
  built.length = 0;
  ownCaptures.length = 0;
  Object.assign(plan, { lock: false, freeze: false, throwingGetter: false });
});

beforeAll(async () => {
  await import('../../instrument.server.mjs');
  const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
  const { init } = await vi.importActual<typeof import('@sentry/react-router')>('@sentry/react-router');
  init({ ...options, dsn: 'https://public@example.invalid/1', enabled: true, tracesSampleRate: 1 });
  setup();
});

afterAll(async () => {
  await Sentry.close();
});

describe('US-09 AC7i: the SDK\'s own report is rebuilt at the transport (server)', () => {
  it('sends a fresh report: allowed fields, fixed words, no trace header, no attachment', async () => {
    trigger();
    await Sentry.flush(1000);
    expectRebuilt();
  });

  it('a hint that cannot be read marks the event', async () => {
    const hint = {};
    let reads = 0;
    Object.defineProperty(hint, 'data', { get() { if (reads++ === 0) throw new Error(MARKER); return undefined; } });
    Sentry.getClient()!.sendEvent({ event_id: 'a'.repeat(32), message: `planted ${MARKER}`, extra: { planted: MARKER } }, hint);
    await Sentry.flush(500);
    expect(events()).toHaveLength(1);
    expect(events()[0].message).toBe(FIXED_MESSAGE);
    expect(events()[0].exception).toEqual(FIXED_EXCEPTION);
    expect(JSON.stringify(envelopes)).not.toContain(MARKER);
  });

  it('locked fields (not writable, not configurable) leave nothing of the original', async () => {
    plan.lock = true;
    trigger();
    await Sentry.flush(1000);
    expectRebuilt();
  });

  it('a frozen event leaves nothing of the original', async () => {
    plan.freeze = true;
    trigger();
    await Sentry.flush(1000);
    expectRebuilt();
  });

  it('a getter that throws on an allowed field drops the whole envelope', async () => {
    plan.throwingGetter = true;
    trigger();
    await Sentry.flush(1000);
    expectOneSelfReport();
    expect(items().map(([h]) => h.type)).toEqual([]);
  });

  it('passes an ordinary error, message and transaction through byte-identical', async () => {
    Sentry.withScope((scope) => {
      scope.setTag('kept', 'yes');
      scope.captureMessage('ordinary message');
    });
    Sentry.captureException(new Error('ordinary error'));
    Sentry.startSpan({ name: 'ordinary-transaction' }, () => {});
    await vi.waitFor(async () => {
      await Sentry.flush(100);
      expect(items().map(([h]) => h.type).filter((t) => t !== 'client_report').sort()).toEqual(['event', 'event', 'transaction']);
    }, { timeout: 2000 });
    const sent = events();
    expect(sent.map((e) => e.message ?? e.exception.values[0].value).sort()).toEqual(['ordinary error', 'ordinary message']);
    expect(sent.find((e) => e.message === 'ordinary message')!.tags).toMatchObject({ kept: 'yes' });
    expect(items().find(([h]) => h.type === 'transaction')![1].transaction).toBe('ordinary-transaction');
    expect(envelopes.map((e) => built.find((b) => b.envelope === e)?.json)).toEqual(envelopes.map((e) => JSON.stringify(e)));
    expect(JSON.stringify(items())).not.toContain('SentryPipelineError');
    expect(ownCaptures).toEqual([]);
  });
});
