// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://drbradstanfield.github.io/roadmap/"}
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as Sentry from '@sentry/react';
import { initSentry, scrubBreadcrumb } from './sentry';
import { isSelfReportBreadcrumb } from '../../../instrument-self-report.mjs';

// US-09 AC7i: a scrub that throws sends nothing. A report the SDK makes about
// its own pipeline is rebuilt at the transport from a fixed allow-list. The
// real initSentry options, transport wrapper included, go through the real SDK;
// only the fetch transport beneath the wrapper captures instead of sending.
const envelopes = vi.hoisted(() => [] as unknown[]);
vi.mock('@sentry/react', async (original) => ({
  ...await original<typeof import('@sentry/react')>(),
  makeFetchTransport: () => ({
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
/** Each `sentry.event` crumb at beforeBreadcrumb: its hint's event, and whether that event was already marked. */
const crumbs: Array<{ event: unknown; marked: boolean }> = [];
/** Every event at beforeSendEvent, in order. */
const sentEvents: object[] = [];
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
  const options = client.getOptions();
  const scrub = options.beforeBreadcrumb!;
  options.beforeBreadcrumb = (breadcrumb, hint) => {
    if (breadcrumb.category === 'sentry.event') crumbs.push({ event: hint?.event, marked: isSelfReportBreadcrumb(hint) });
    return scrub(breadcrumb, hint);
  };
  let own: object | undefined;
  client.on('beforeSendEvent', (event, hint) => {
    sentEvents.push(event);
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
  expect(event.sdk.name).toBe('sentry.javascript.react');
  const [headers] = (envelopes as Envelope[]).find(([, list]) => list.some(([, p]) => p === event))!;
  expect(headers).not.toHaveProperty('trace');
  expect(items().map(([h]) => h.type)).not.toContain('attachment');
}

beforeEach(() => {
  envelopes.length = 0;
  seen.length = 0;
  built.length = 0;
  ownCaptures.length = 0;
  crumbs.length = 0;
  sentEvents.length = 0;
  Object.assign(plan, { lock: false, freeze: false, throwingGetter: false });
});

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
  initSentry();
  setup();
});

afterAll(async () => {
  await Sentry.close();
  vi.unstubAllGlobals();
});

describe('US-09 AC7i: the SDK\'s own report is rebuilt at the transport (browser)', () => {
  it('sends a fresh report: allowed fields, fixed words, no trace header, no attachment', async () => {
    trigger();
    await Sentry.flush(1000);
    expectRebuilt();
  });

  it('ordering pin: the report is marked before the breadcrumbs listener runs, so its crumb is dropped', async () => {
    trigger();
    await Sentry.flush(1000);
    // Fails if the Breadcrumbs integration's beforeSendEvent listener runs before the marking hook.
    expect(crumbs).toEqual([{ event: sentEvents[0], marked: true }]);
    envelopes.length = 0;
    Sentry.captureMessage('after the report');
    await Sentry.flush(1000);
    expect(events().map((e) => e.message)).toEqual(['after the report']);
    expect(JSON.stringify(envelopes)).not.toContain(MARKER);
  });

  it('contract pin: the Breadcrumbs integration passes the sent event as the crumb hint', async () => {
    Sentry.captureMessage('ordinary crumb source');
    await Sentry.flush(1000);
    expect(sentEvents).toHaveLength(1);
    expect(crumbs).toEqual([{ event: sentEvents[0], marked: false }]);
  });

  it('a hint that cannot be read marks the event, and its crumb is dropped', async () => {
    const hint = {};
    let reads = 0;
    Object.defineProperty(hint, 'data', { get() { if (reads++ === 0) throw new Error(MARKER); return undefined; } });
    Sentry.getClient()!.sendEvent({ event_id: 'a'.repeat(32), message: `planted ${MARKER}`, extra: { planted: MARKER } }, hint);
    await Sentry.flush(1000);
    expect(events()).toHaveLength(1);
    expect(events()[0].message).toBe(FIXED_MESSAGE);
    expect(events()[0].exception).toEqual(FIXED_EXCEPTION);
    expect(crumbs).toEqual([{ event: sentEvents[0], marked: true }]);
    expect(JSON.stringify(envelopes)).not.toContain(MARKER);
  });

  it('scrubBreadcrumb drops a crumb whose hint cannot be read, and keeps an ordinary one', () => {
    const unreadable = {};
    Object.defineProperty(unreadable, 'event', { get() { throw new Error(MARKER); } });
    expect(scrubBreadcrumb({ category: 'sentry.event', message: 'x' }, unreadable)).toBeNull();
    expect(scrubBreadcrumb({ category: 'sentry.event', message: 'kept' }, { event: { message: 'kept' } })).toEqual({ category: 'sentry.event', message: 'kept' });
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

  it('passes an ordinary message and error through byte-identical', async () => {
    Sentry.withScope((scope) => {
      scope.setTag('kept', 'yes');
      scope.captureMessage('ordinary message');
    });
    Sentry.captureEvent({ exception: { values: [{ type: 'Error', value: 'ordinary error', stacktrace: { frames: [
      { filename: 'https://drbradstanfield.github.io/roadmap/assets/index-abc.js', lineno: 1 },
    ] } }] } });
    await Sentry.flush(1000);
    const sent = events();
    expect(sent.map((e) => e.message ?? e.exception.values[0].value)).toEqual(['ordinary message', 'ordinary error']);
    expect(sent[0].tags).toMatchObject({ kept: 'yes' });
    expect(envelopes).toHaveLength(2);
    expect(envelopes.map((e) => built.find((b) => b.envelope === e)?.json)).toEqual(envelopes.map((e) => JSON.stringify(e)));
    expect(JSON.stringify(sent)).not.toContain('SentryPipelineError');
    expect(ownCaptures).toEqual([]);
  });
});
