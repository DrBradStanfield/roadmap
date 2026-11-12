// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://drbradstanfield.github.io/roadmap/"}
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as Sentry from '@sentry/react';
import { initSentry } from './sentry';

// US-09 AC7i: a report the SDK makes about its own pipeline leaves with a
// fixed, content-free shape. The real initSentry options go through the real
// SDK with a capturing transport.
const envelopes = vi.hoisted(() => [] as unknown[]);
vi.mock('@sentry/react', async (original) => {
  const real = await original<typeof import('@sentry/react')>();
  return {
    ...real,
    init: (options: Parameters<typeof real.init>[0]) => real.init({
      ...options,
      transport: () => ({
        send: async (envelope: unknown) => { envelopes.push(envelope); return { statusCode: 200 }; },
        flush: async () => true,
      }),
    }),
  };
});

const MARKER = 'MARKER_7b3e';
const FIXED_MESSAGE = 'Sentry scrub pipeline error';
const FIXED_EXCEPTION = { values: [{ type: 'SentryPipelineError', value: 'dropped' }] };
const ALLOWED = ['event_id', 'timestamp', 'platform', 'level', 'release', 'environment', 'sdk', 'message', 'exception'];
type Item = [{ type: string }, Record<string, any>];
const items = () => (envelopes as Array<[unknown, Item[]]>).flatMap(([, list]) => list);
const events = () => items().filter(([h]) => h.type === 'event').map(([, p]) => p);
const plan = { stuck: false };
/** What the pipeline held just before our hook, per event: whether it was the SDK's own, and whether it carried the marker. */
const seen: Array<{ own: unknown; marker: boolean }> = [];
const ownCaptures: unknown[] = [];
let n = 0;

function setup() {
  const client = Sentry.getClient()!;
  // A throwing processor makes the SDK report the fault as an event of its own,
  // outside our wrapped hooks.
  Sentry.getGlobalScope().addEventProcessor((event) => {
    if (event.message?.startsWith('trigger')) throw new Error(`processor broke on ${MARKER}`);
    return event;
  });
  // Plants what an integration could attach, and a field a future SDK might add.
  client.on('postprocessEvent', (event, hint) => {
    const own = (hint?.data as { __sentry__?: unknown } | undefined)?.__sentry__;
    if (own === true) {
      const e = event as Record<string, unknown>;
      e.request = { url: `https://example.invalid/${MARKER}`, headers: { cookie: MARKER } };
      e.futureField = MARKER;
      if (plan.stuck) Object.defineProperty(e, 'stuck', { value: MARKER, enumerable: true, writable: true, configurable: false });
    }
    // Only the SDK's own report is read: an ordinary event can hold a circular timer.
    if (own === true) seen.push({ own, marker: JSON.stringify(event).includes(MARKER) });
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

function expectContentFree() {
  // Contract: the SDK still marks its own report, and it held the planted content before our hook.
  expect(seen).toEqual([{ own: true, marker: true }]);
  expect(ownCaptures).toHaveLength(1);
  const [event] = events();
  expect(events()).toHaveLength(1);
  for (const key of Object.keys(JSON.parse(JSON.stringify(event)))) expect(ALLOWED, key).toContain(key);
  expect(event.message).toBe(FIXED_MESSAGE);
  expect(event.exception).toEqual(FIXED_EXCEPTION);
  expect(JSON.stringify(envelopes)).not.toContain(MARKER);
  expect(items().map(([h]) => h.type)).not.toContain('attachment');
}

beforeEach(() => {
  envelopes.length = 0;
  seen.length = 0;
  ownCaptures.length = 0;
  plan.stuck = false;
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

describe('US-09 AC7i: the SDK\'s own report is content-free (browser)', () => {
  it('keeps only the allowed fields, a fixed message and exception, no marker and no attachment', async () => {
    trigger();
    await Sentry.flush(1000);
    expectContentFree();
    // The breadcrumb the SDK records for a sent event carries none of it either.
    envelopes.length = 0;
    Sentry.captureMessage('after the report');
    await Sentry.flush(1000);
    expect(events().map((e) => e.message)).toEqual(['after the report']);
    expect(JSON.stringify(envelopes)).not.toContain(MARKER);
  });

  it('a throw inside the hook still ends with one content-free report and no third event', async () => {
    plan.stuck = true;
    trigger();
    await Sentry.flush(1000);
    expectContentFree();
  });

  it('passes an ordinary message and error through untouched', async () => {
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
    expect(sent[1].exception.values[0].type).toBe('Error');
    expect(JSON.stringify(sent)).not.toContain('SentryPipelineError');
    expect(ownCaptures).toEqual([]);
  });
});
