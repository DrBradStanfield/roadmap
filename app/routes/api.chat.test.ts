import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

const mocks = vi.hoisted(() => ({ appProxy: vi.fn(async () => ({})) }));
vi.mock('../shopify.server', () => ({
  authenticate: { public: { appProxy: mocks.appProxy } },
}));

import { action, loader } from './api.chat';

// US-15 AC4: a malformed body is the client's error. Node's SyntaxError quotes
// the offending text, so the outer catch must never see it.
const marker = 'PHI_SENTINEL';
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
});

afterEach(async () => {
  await Sentry.close();
  vi.restoreAllMocks();
});

describe('api.chat malformed body', () => {
  it('returns 400 and reports nothing', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await action({
      request: new Request('https://drstanfield.com/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: `{"message": ${marker} synthetic LDL 4.2`,
      }),
      params: {},
    } as unknown as Parameters<typeof action>[0]);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).not.toContain(marker);
    await Sentry.flush();
    expect(envelopes).toEqual([]);
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(marker);
  });
});

// US-15 AC9 (Sentry JAVASCRIPT-REMIX-6E): a request without a valid app-proxy
// signature gets the framework's own 400, not a 500, and is never a Sentry
// error. `authenticate.public.appProxy` rejects by THROWING a Response
// (@shopify/shopify-app-react-router 1.2.0, authenticate.js:17), which the
// route's catch-all used to swallow as "Chat: Action failed".
// react-router returns a thrown Response from a resource route as-is, without
// calling handleError (7.18.3, handleQueryRouteError) — so the route must let
// it propagate rather than answer 500.
describe('api.chat unsigned request', () => {
  const url = 'https://health-tool-app.fly.dev/api/chat';
  const args = (request: Request) => ({ request, params: {} }) as unknown as Parameters<typeof action>[0];

  it.each([
    ['POST', () => action(args(new Request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hello' }),
    })))],
    ['GET with a session token', () => loader(args(new Request(`${url}?sessionToken=synthetic`)))],
  ])('%s lets the 400 the proxy check threw through and reports nothing', async (_, call) => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rejection = new Response(null, { status: 400 });
    mocks.appProxy.mockRejectedValueOnce(rejection);
    await expect(call()).rejects.toBe(rejection);
    await Sentry.flush();
    expect(envelopes).toEqual([]);
    expect(consoleError).not.toHaveBeenCalled();
  });
});
