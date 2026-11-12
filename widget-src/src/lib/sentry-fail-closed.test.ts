// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://drbradstanfield.github.io/roadmap/"}
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as Sentry from '@sentry/react';
import * as realScrub from '@roadmap/health-core/sentry-scrub';
import { initSentry } from './sentry';

// US-09 AC7i: a scrub hook that throws sends nothing. The real initSentry
// options go through the real SDK with a capturing transport; the shared
// scrub helpers throw on demand, so the throw happens inside our hooks.
const envelopes = vi.hoisted(() => [] as unknown[]);
const boom = vi.hoisted(() => ({ text: null as unknown, url: null as unknown }));
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
vi.mock('@roadmap/health-core/sentry-scrub', async (original) => {
  const real = await original<typeof import('@roadmap/health-core/sentry-scrub')>();
  return {
    ...real,
    scrubEventText: (event: Parameters<typeof real.scrubEventText>[0]) => {
      if (boom.text !== null) throw boom.text;
      return real.scrubEventText(event);
    },
    scrubUrl: (url: string) => {
      if (boom.url !== null) throw boom.url;
      return real.scrubUrl(url);
    },
  };
});

const SENTINEL = 'MSG_SENTINEL_4e1b';
const FIXED = (name: string) => `Sentry scrub failed (${name}); event dropped`;
type Item = [{ type: string }, Record<string, any>];
const items = () => (envelopes as Array<[unknown, Item[]]>).flatMap(([, list]) => list);
let errorLog: ReturnType<typeof vi.spyOn>;
let internalCaptures: unknown[];

beforeAll(() => {
  vi.stubGlobal('crypto', webcrypto);
  initSentry();
  const client = Sentry.getClient()!;
  const capture = client.captureException.bind(client);
  internalCaptures = [];
  vi.spyOn(client, 'captureException').mockImplementation((exception, hint, scope) => {
    if ((hint?.data as { __sentry__?: unknown } | undefined)?.__sentry__ === true) internalCaptures.push(exception);
    return capture(exception, hint, scope);
  });
});

beforeEach(() => {
  envelopes.length = 0;
  internalCaptures.length = 0;
  boom.text = null;
  boom.url = null;
  errorLog?.mockRestore();
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(async () => {
  errorLog?.mockRestore();
  await Sentry.close();
  vi.unstubAllGlobals();
});

describe('US-09 AC7i: a browser scrub hook that throws sends nothing', () => {
  it('beforeSend: a throw sends no envelope and no internal event, and logs the error name only', async () => {
    const error = new TypeError(`scrub broke on ${SENTINEL}`);
    error.stack = `TypeError: scrub broke on ${SENTINEL}\n    at stack-${SENTINEL}`;
    boom.text = error;
    // A message, not an exception: allowUrls drops an error thrown from this test file.
    Sentry.captureMessage(`probe ${SENTINEL}`);
    await Sentry.flush(1000);
    expect(items()).toEqual([]);
    expect(internalCaptures).toEqual([]);
    expect(errorLog.mock.calls).toEqual([[FIXED('TypeError')]]);
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain(SENTINEL);
  });

  it('beforeSend: a thrown non-Error is named by its type', async () => {
    boom.text = `thrown string ${SENTINEL}`;
    Sentry.captureMessage('probe string throw');
    await Sentry.flush(1000);
    expect(items()).toEqual([]);
    expect(internalCaptures).toEqual([]);
    expect(errorLog.mock.calls).toEqual([[FIXED('string')]]);
  });

  it('beforeBreadcrumb: a throw drops the breadcrumb and logs the error name only', () => {
    boom.url = new RangeError(`url broke on ${SENTINEL}`);
    const hook = Sentry.getClient()!.getOptions().beforeBreadcrumb!;
    const out = hook({ category: 'navigation', data: { from: '/a', to: `/b?code=${SENTINEL}` } }, {});
    expect(out).toBeNull();
    expect(errorLog.mock.calls).toEqual([[FIXED('RangeError')]]);
  });

  it('a hook that returns normally sends the same scrubbed event as before', async () => {
    const text = 'My LDL is 3.2 mmol/L';
    const expected = { message: text };
    realScrub.scrubEventText(expected as Parameters<typeof realScrub.scrubEventText>[0]);
    expect(expected.message).not.toBe(text);
    Sentry.captureMessage(text);
    await Sentry.flush(1000);
    expect(items().map(([h]) => h.type)).toEqual(['event']);
    expect(items()[0][1].message).toBe(expected.message);
    expect(errorLog).not.toHaveBeenCalled();
  });

  it('SDK pin: a null from beforeSend sends nothing and creates no internal event', async () => {
    // scrubEvent returns null for an error thrown inside a third-party fetch wrapper.
    Sentry.captureEvent({
      exception: { values: [{ type: 'TypeError', value: 'third-party probe', stacktrace: { frames: [
        { filename: 'https://cdn.shopify.com/s/upcart-bundle.js', lineno: 1 },
        { filename: 'https://drbradstanfield.github.io/roadmap/assets/index-abc.js', lineno: 1 },
      ] } }] },
    });
    await Sentry.flush(1000);
    expect(items()).toEqual([]);
    expect(internalCaptures).toEqual([]);
    expect(errorLog).not.toHaveBeenCalled();
  });
});
