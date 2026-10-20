/**
 * US-09 AC24 and US-48 AC4, against the REAL Shopify library (Codex upgrade
 * R1/R2, adversary upgrade R1/R2). Other suites mock `authenticate`; this one
 * builds `shopifyApp(...)` as app/shopify.server.ts does, with a dummy secret
 * and a session store that holds nothing, so the version pinned in the lockfile
 * is what answers.
 *
 * Why it matters: @shopify/shopify-api 15 refuses a repeated `hmac`, `shop`,
 * `signature` or `timestamp`, but ACCEPTS a repeated `logged_in_customer_id`,
 * comma-joining the copies before the HMAC. A query Shopify signed after a
 * client put its own id in front therefore passes the library check. Our
 * `getCustomerId` must still refuse it as an identity. The upgrade must never
 * ship without that rule.
 */
import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';

const SECRET = vi.hoisted(() => 'test-shopify-secret');

vi.mock('../shopify.server', async () => {
  await import('@shopify/shopify-app-react-router/adapters/node');
  const { shopifyApp, ApiVersion, AppDistribution } = await import('@shopify/shopify-app-react-router/server');
  const noSessions = {
    storeSession: async () => true,
    loadSession: async () => undefined,
    deleteSession: async () => true,
    deleteSessions: async () => true,
    findSessionsByShop: async () => [],
  };
  const app = shopifyApp({
    apiKey: 'test-key',
    apiSecretKey: SECRET,
    apiVersion: ApiVersion.April26,
    scopes: [],
    appUrl: 'https://health-tool-app.fly.dev',
    authPathPrefix: '/auth',
    sessionStorage: noSessions as never,
    distribution: AppDistribution.AppStore,
    logger: { level: 0 } as never,
  });
  return { authenticate: app.authenticate };
});
vi.mock('./supabase.server', () => ({
  getOrCreateSupabaseUser: vi.fn(async () => 'user-1'),
  createUserClient: vi.fn(() => ({})),
}));

import { authenticate } from '../shopify.server';
import { getAuthenticatedUser, getCustomerId } from './route-helpers.server';
import { verifyAppProxySignature } from './local-first-route.server';
import { forgedQuery, proxyPairs, signedQuery, TEST_PROXY_SECRET } from './app-proxy.test-helpers';

const req = (query: string) => new Request(`https://health-tool-app.fly.dev/api/chat${query}`);

/** The real library's verdict: 'pass' or the status it threw. */
async function library(query: string): Promise<'pass' | number> {
  try {
    await authenticate.public.appProxy(req(query));
    return 'pass';
  } catch (thrown) {
    if (thrown instanceof Response) return thrown.status;
    throw thrown;
  }
}

let saved: string | undefined;
beforeAll(() => {
  expect(SECRET).toBe(TEST_PROXY_SECRET);
  saved = process.env.SHOPIFY_API_SECRET;
  process.env.SHOPIFY_API_SECRET = SECRET;
});
afterAll(() => { process.env.SHOPIFY_API_SECRET = saved; });

describe('the real authenticate.public.appProxy (shopify-api 15)', () => {
  it('passes a correctly signed request, and our verifier and getCustomerId agree', async () => {
    const q = signedQuery(proxyPairs('12345'));
    expect(await library(q)).toBe('pass');
    expect(verifyAppProxySignature(req(q))).toBe(true);
    expect(getCustomerId(req(q))).toBe('12345');
  });

  it('passes a signed guest request and a signed app param holding a space', async () => {
    const guest = signedQuery(proxyPairs(''));
    const spaced = signedQuery([...proxyPairs('12345'), ['note', 'two words']]);
    for (const q of [guest, spaced]) {
      expect(await library(q)).toBe('pass');
      expect(verifyAppProxySignature(req(q))).toBe(true);
    }
    expect(getCustomerId(req(guest))).toBeNull();
    expect(getCustomerId(req(spaced))).toBe('12345');
  });

  it('throws a 400 for an unsigned request, a wrong secret and a tampered value; our verifier agrees', async () => {
    const pairs = proxyPairs('12345');
    const unsigned = `?${new URLSearchParams(pairs)}`;
    const wrongSecret = signedQuery(pairs, 'wrong-secret');
    const tampered = signedQuery(pairs).replace('logged_in_customer_id=12345', 'logged_in_customer_id=999');
    for (const q of [unsigned, wrongSecret, tampered]) {
      expect(await library(q)).toBe(400);
      expect(verifyAppProxySignature(req(q))).toBe(false);
      expect(getCustomerId(req(q))).toBeNull();
    }
  });

  it.each(['shop', 'timestamp'])('throws a 400 for a repeated %s, even when signed over both copies', async (key) => {
    const pairs = proxyPairs('12345');
    const copy = pairs.find(([k]) => k === key)!;
    const q = signedQuery([...pairs, copy]);
    expect(await library(q)).toBe(400);
    expect(verifyAppProxySignature(req(q))).toBe(false);
  });

  it('throws a 400 for a repeated signature', async () => {
    const q = signedQuery(proxyPairs('12345'));
    const sig = new URLSearchParams(q).get('signature')!;
    expect(await library(`${q}&signature=${sig}`)).toBe(400);
    expect(verifyAppProxySignature(req(`${q}&signature=${sig}`))).toBe(false);
  });

  it('ACCEPTS a repeated logged_in_customer_id signed over both copies; getCustomerId still refuses it', async () => {
    // The adversary's case: the client sent 999, Shopify appended its own
    // (empty, logged-out) value and signed the comma-joined pair.
    const pairs = proxyPairs('');
    const q = signedQuery([['logged_in_customer_id', '999'], ...pairs]);
    expect(await library(q)).toBe('pass');
    expect(new URL(req(q).url).searchParams.get('logged_in_customer_id')).toBe('999');
    expect(verifyAppProxySignature(req(q))).toBe(false);
    expect(getCustomerId(req(q))).toBeNull();
    expect(await getAuthenticatedUser(req(q))).toBeNull();
  });

  it('refuses the prepended-id forgery signed over one copy only (a 400 on 15; 1.2.0 passed it)', async () => {
    const q = forgedQuery('999', '');
    expect(await library(q)).toBe(400);
    expect(getCustomerId(req(q))).toBeNull();
  });
});
