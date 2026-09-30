import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

vi.mock('@sentry/react-router', async (original) => ({
  ...await original<typeof import('@sentry/react-router')>(), init: vi.fn(),
}));

// US-09 AC7 (2026-10-01): boot the real SDK with the options production
// passes (instrument.server.mjs), drive real requests through an
// instrumented http server, wait for every envelope each test's requests
// produce (the error event, each server transaction, each outgoing-call
// transaction), and read all of them. Neither error events nor sampled
// transactions (root span data and child spans included) may carry a body, a
// header outside the allowlist (the Authorization header, a cookie, a
// Referer), the client's address or a query string, and an outgoing call,
// child span or root, keeps only the origin of the URL it called.
const PASSWORD = 'PW_SENTINEL_7f3a';
const BEARER = 'BEARER_SENTINEL_9c1d';
const COOKIE = 'COOKIE_SENTINEL_4b2e';
const CODE = 'CODE_SENTINEL_5e8b';
const STATE = 'STATE_SENTINEL_2a6c';
const FETCH_QUERY = 'FETCH_SENTINEL_8d0f';
const FETCH_PATH = 'PATH_SENTINEL_3c7a';
const REFERER = 'REF_SENTINEL_6b1e';
const CUSTOM_HEADER = 'HDR_SENTINEL_0d4f';
const CLIENT_IP = '203.0.113.99';
const SET_COOKIE = 'SETCOOKIE_SENTINEL_5e7d';
const ROOT_PATH = 'ROOTPATH_SENTINEL_1f9a';
const ROOT_QUERY = 'ROOTQUERY_SENTINEL_7e2b';
type Item = [{ type: string }, Record<string, any>];
type Envelope = [unknown, Item[]];
const envelopes: Envelope[] = [];
// Events that still held a request body BEFORE beforeSend* ran: pins the
// http integration's `maxIncomingRequestBodySize: "none"` on its own.
const rawBodies: string[] = [];
let server: http.Server;
let base: string;

const items = () => envelopes.flatMap(([, list]) => list);
const op = (p: Record<string, any>) => p.contexts?.trace?.op;
const isServer = (name: string) => ([h, p]: Item) => h.type === 'transaction' && op(p) === 'http.server' && p.transaction.startsWith(name);
const isOutgoingRoot = ([h, p]: Item) => h.type === 'transaction' && op(p) === 'http.client';
const isError = ([h]: Item) => h.type === 'event';

async function waitForItems(expected: Record<string, (item: Item) => boolean>) {
  await vi.waitFor(async () => {
    // A span whose parent was already sent can sit in the exporter until
    // something flushes it; production flushes on the next span, the test
    // forces it.
    await Sentry.flush(100);
    for (const [label, match] of Object.entries(expected)) expect(items().some(match), label).toBe(true);
  }, { timeout: 2000 });
}

function expectClean(sentinels: string[]) {
  for (const [header, payload] of items()) {
    const text = JSON.stringify(payload);
    for (const sentinel of sentinels) {
      expect(text, `${header.type} ${payload.transaction ?? ''} carries ${sentinel}`).not.toContain(sentinel);
    }
    const request = payload.request;
    if (!request) continue;
    expect(request.data, `${header.type} request.data`).toBeUndefined();
    expect(request.cookies, `${header.type} request.cookies`).toBeUndefined();
    const headerNames = Object.keys(request.headers ?? {}).map((k) => k.toLowerCase());
    expect(headerNames, `${header.type} request.headers`).not.toContain('authorization');
    expect(headerNames, `${header.type} request.headers`).not.toContain('cookie');
  }
}

beforeAll(async () => {
  await import('../../instrument.server.mjs');
  const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
  const { init } = await vi.importActual<typeof import('@sentry/react-router')>('@sentry/react-router');
  init({
    ...options,
    dsn: 'https://public@example.invalid/1',
    enabled: true,
    // Production samples 20% of transactions; sample every one so the
    // transaction path is exercised on every run.
    tracesSampleRate: 1,
    transport: () => ({
      send: async (envelope) => { envelopes.push(envelope as unknown as Envelope); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
  Sentry.getGlobalScope().addEventProcessor((event) => {
    if (event.request?.data !== undefined) rawBodies.push(event.type ?? 'event');
    return event;
  });
  server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', async () => {
      try {
        if (req.url?.startsWith('/mcp/callback')) {
          // An outgoing call naming a document in its path and query: the
          // child span keeps the origin alone.
          await (await fetch(`${base}/upstream/${FETCH_PATH}.pdf?path=${FETCH_QUERY}`)).text();
        } else if (req.url === '/late') {
          // Fire-and-forget after the response, like the chat and audit
          // inserts: the SDK sends this span as its own root transaction.
          res.end('ok');
          await (await fetch(`${base}/upstream/${ROOT_PATH}.pdf?path=${ROOT_QUERY}`)).text();
        } else if (req.url === '/mcp/authorize') {
          // A session cookie set on the response: the SDK copies it into span
          // data by name, as it does a request cookie.
          res.setHeader('set-cookie', `sid=${SET_COOKIE}; HttpOnly`);
          Sentry.captureException(new Error(`synthetic failure after ${body.length} bytes`));
        }
      } finally {
        if (!res.writableEnded) res.end('ok');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => { envelopes.length = 0; });

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await Sentry.close();
});

describe('US-09 AC7: server Sentry envelopes carry no request body, credentials or query', () => {
  it('sends neither an error nor a transaction with the body, Authorization or cookies', async () => {
    const res = await fetch(`${base}/mcp/authorize`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Bearer ${BEARER}`,
        cookie: `theme=${COOKIE}`,
        referer: `https://drstanfield.com/pages/roadmap?code=${REFERER}`,
        'x-custom-session': CUSTOM_HEADER,
        'x-forwarded-for': `${CLIENT_IP}, 10.0.0.1`,
      },
      body: new URLSearchParams({ username: 'reviewer', password: PASSWORD }).toString(),
    });
    expect(await res.text()).toBe('ok');
    await waitForItems({ error: isError, server: isServer('POST /mcp/authorize') });
    expectClean([PASSWORD, BEARER, COOKIE, REFERER, CUSTOM_HEADER, CLIENT_IP, SET_COOKIE]);
    expect(rawBodies, 'a body was read before the scrub').toEqual([]);
  });

  it('sends no query string from the request or from an outgoing call', async () => {
    const res = await fetch(`${base}/mcp/callback?code=${CODE}&state=${STATE}`);
    expect(await res.text()).toBe('ok');
    await waitForItems({
      callback: isServer('GET /mcp/callback'), upstream: isServer('GET /upstream'),
    });
    expectClean([CODE, STATE, FETCH_QUERY]);
    const [, callback] = items().find(isServer('GET /mcp/callback'))!;
    expect(JSON.stringify(callback)).not.toContain(FETCH_PATH);
    const fetchSpan = callback.spans.find((s: { op?: string }) => s.op === 'http.client');
    expect(fetchSpan.description).toBe(`GET ${base}`);
  });

  it('gives an outgoing call that outlives its request the origin rule', async () => {
    await (await fetch(`${base}/late`)).text();
    await waitForItems({ late: isServer('GET /late'), upstream: isServer('GET /upstream'), outgoing: isOutgoingRoot });
    expectClean([ROOT_QUERY]);
    const [, outgoing] = items().find(isOutgoingRoot)!;
    expect(JSON.stringify(outgoing)).not.toContain(ROOT_PATH);
    expect(outgoing.transaction).toBe(`GET ${base}`);
  });
});
