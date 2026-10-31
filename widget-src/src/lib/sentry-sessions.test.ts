// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://drbradstanfield.github.io/roadmap/"}
import { afterAll, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import * as Sentry from '@sentry/react';
import { initSentry } from './sentry';

// US-49 AC4: setting a release switches Sentry sessions on (@sentry/core drops
// a session without one, and @sentry/browser adds browserSessionIntegration by
// default). initSentry keeps every other default but drops that one, so a page
// load or a route change sends Sentry no session message. The real initSentry
// options go through the real SDK; only the transport is swapped for a
// capturing one.
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

afterAll(async () => {
  await Sentry.close();
  vi.unstubAllGlobals();
});

/** The item types (event, session, …) of every envelope sent so far. */
function sentItemTypes(): string[] {
  return (envelopes as Array<[unknown, Array<[{ type: string }, unknown]>]>)
    .flatMap(([, items]) => items.map(([header]) => header.type));
}

it('sends no session on page load or route change, while events still carry the release', async () => {
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('__SENTRY_RELEASE__', 'health-tool-widget@synthetic');
  initSentry();
  const client = Sentry.getClient()!;
  expect(client.getOptions().enabled).toBe(true);
  expect(client.getOptions().release).toBe('health-tool-widget@synthetic');

  // The page-load session goes out on the next idle tick (setTimeout in jsdom);
  // a route change sends one at once.
  await new Promise((resolve) => setTimeout(resolve, 50));
  window.history.pushState({}, '', '/roadmap/other');
  await Sentry.flush(1000);
  expect(sentItemTypes()).not.toContain('session');

  // Only that integration is dropped; every other default is kept.
  const names = client.getOptions().integrations.map((i) => i.name);
  expect(names).not.toContain('BrowserSession');
  expect(names).toEqual(expect.arrayContaining(['Breadcrumbs', 'GlobalHandlers', 'Dedupe']));

  // The transport is live: an event still goes out, tagged with the release.
  // A message, not an exception: allowUrls drops an error thrown from this test file.
  Sentry.captureMessage('synthetic session probe');
  await Sentry.flush(1000);
  expect(sentItemTypes()).toEqual(['event']);
  const [, [[, event]]] = envelopes[0] as [unknown, Array<[unknown, { release?: string }]>];
  expect(event.release).toBe('health-tool-widget@synthetic');
});
