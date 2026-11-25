import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// US-15 AC65 at the iPhone's real entry: with the chat system prompt missing (or
// CHAT_ENABLED=false), appChat refuses before the App Attest gate. No key read, no
// body read, no daily turn, no IP or machine unit. Real appChat, real appGate, a
// spy key store and a signed request built as in app-routes.server.test.ts.
// Model calls are mocked: no spend.

const mocks = vi.hoisted(() => ({
  prompt: { kind: 'loaded', text: 'synthetic prompt' } as { kind: 'loaded'; text: string } | { kind: 'missing' },
  getChatCompletion: vi.fn(),
  rootPem: '',
}));
vi.mock('./chat-system-prompt.server', () => ({ get CHAT_PROMPT() { return mocks.prompt; } }));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('./supabase-client.server', () => ({ supabaseAdmin: null, createUserClient: supa.createUserClient }));
// api.chat.ts imports these from their defining modules (S-14).
const supa = vi.hoisted(() => ({
  logAudit: vi.fn(), getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  createUserClient: vi.fn(), getOrCreateGuestSession: vi.fn(),
  GuestRateLimitError: class extends Error {},
}));
vi.mock('./supabase-identity.server', async (o) => ({ ...await o<object>(), logAudit: supa.logAudit }));
vi.mock('./supabase-guest.server', async (o) => ({ ...await o<object>(), getOrCreateGuestSession: supa.getOrCreateGuestSession, GuestRateLimitError: supa.GuestRateLimitError }));
vi.mock('./supabase-account.server', async (o) => ({ ...await o<object>(), getProfile: supa.getProfile, updateSubscriptionPlan: supa.updateSubscriptionPlan }));
vi.mock('./chat.server', async (original) => (await import('./chat-server.test-helpers')).chatServerStub(await original<typeof import('./chat.server')>(), {
  resolveChatContext: () => ({ userContextJson: 'null' }),
  buildConversationMessages: (history: unknown[], message: string) => [...history, { role: 'user', content: message }],
  DOCTOR_POSTURE: 'doctor', BRAND_POSTURE: 'brand',
  getChatCompletion: mocks.getChatCompletion,
  generateTitle: () => 't',
}));
vi.mock('./chat-router.server', async (original) => ({
  ...await original<typeof import('./chat-router.server')>(),
  routeQuery: vi.fn(), reportRouterFailure: vi.fn(),
}));
vi.mock('./product-events.server', async (original) => ({
  ...await original<typeof import('./product-events.server')>(),
  recordServerEvent: vi.fn(),
}));
vi.mock('./chat-classifier.server', () => ({ classifyMessage: async () => ({ routerSkipped: true, classification: 'SKIP', latencyMs: 0 }), shouldFireRouter: () => false }));
vi.mock('./app-attest.server', async (original) => {
  const real = await original<typeof import('./app-attest.server')>();
  return { ...real, attestConfig: (env?: NodeJS.ProcessEnv) => { const c = real.attestConfig(env); return c && { ...c, rootPem: mocks.rootPem }; } };
});

import { appChallenge, appChat, appRegister } from './app-routes.server';
import { appLimits, ipBucket, type KeyStore, type UseOutcome } from './app-gate.server';
import { fakeDevice } from './app-attest.test-helpers';
import { requestClientData } from './app-attest.server';
import { machineFiles } from './rate-limiter';

const APP_ID = 'TEAM123456.com.drstanfield.healthroadmap';
const device = fakeDevice(APP_ID);
mocks.rootPem = device.rootPem;
const BASE = 'https://health-tool-edu.fly.dev';
const IP = '203.0.113.9';
const saved = { ...process.env };

function memoryStore() {
  const rows = new Map<string, { publicKey: string; environment: 'production' | 'development'; count: number; uses: Record<string, number> }>();
  const store = {
    get: vi.fn(async (keyId: string) => { const r = rows.get(keyId); return r ? { publicKey: r.publicKey, environment: r.environment } : null; }),
    insert: vi.fn(async (k: { keyId: string; publicKeyPem: string; environment: 'production' | 'development' }) => {
      if (rows.has(k.keyId)) return 'exists' as const;
      rows.set(k.keyId, { publicKey: k.publicKeyPem, environment: k.environment, count: 0, uses: { chat: 0, lab: 0 } });
      return 'ok' as const;
    }),
    use: vi.fn(async (keyId: string, counter: number, kind: 'chat' | 'lab', cap: number): Promise<UseOutcome> => {
      const r = rows.get(keyId);
      if (!r) return 'unknown';
      if (counter <= r.count) return 'stale';
      r.count = counter;
      if (r.uses[kind] + 1 > cap) return 'limit';
      r.uses[kind] += 1;
      return 'ok';
    }),
  };
  return store satisfies KeyStore;
}

let store: ReturnType<typeof memoryStore>;
let counter = 0;

async function registered() {
  const { challenge } = await appChallenge(new Request(`${BASE}/api/app/v1/attest/challenge`, { method: 'POST' })).json();
  const res = await appRegister(new Request(`${BASE}/api/app/v1/attest/register`, {
    method: 'POST', headers: { 'fly-client-ip': IP },
    body: JSON.stringify({ keyId: device.keyId, attestation: device.attest(challenge).toString('base64'), challenge }),
  }), store);
  expect(res.status).toBe(200);
  store.get.mockClear(); store.insert.mockClear(); store.use.mockClear();
}

function signed(body: object) {
  const path = '/api/app/v1/chat';
  const raw = Buffer.from(JSON.stringify(body));
  const assertion = device.assert(requestClientData('POST', path, raw), ++counter, APP_ID);
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'x-app-attest-key': device.keyId, 'x-app-attest-assertion': assertion, 'fly-client-ip': IP },
    body: raw,
  });
}

const chatBody = { message: 'What is ApoB?', history: [], guestInputs: { unitSystem: 'si' }, stream: true };
const units = () => ({
  ip: appLimits.ip.chat.remaining(ipBucket(IP)),
  machine: appLimits.machine.chat.remaining('machine'),
  failures: appLimits.failures.remaining(ipBucket(IP)),
  keyFailures: appLimits.keyFailures.remaining(device.keyId),
});

beforeEach(async () => {
  Object.assign(process.env, { APP_ATTEST_TEAM_ID: 'TEAM123456', SHOPIFY_API_SECRET: 'test-secret' });
  delete process.env.APP_ATTEST_DEV_BYPASS;
  delete process.env.CHAT_SURFACE;
  delete process.env.CHAT_ENABLED;
  for (const c of [appLimits.failures, appLimits.keyFailures, appLimits.register, appLimits.registered, appLimits.challenges, appLimits.ip.chat, appLimits.ip.lab, appLimits.machine.chat, appLimits.machine.lab, appLimits.dev.chat, appLimits.dev.lab, machineFiles]) c.reset();
  mocks.prompt = { kind: 'loaded', text: 'synthetic prompt' };
  mocks.getChatCompletion.mockReset().mockImplementation(async (_s: unknown, _m: unknown, _e: boolean, onEvent?: (e: unknown) => void) => {
    onEvent?.({ type: 'text', text: 'Synthetic answer' });
    return { content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, isFallback: false, stopReason: 'end_turn' };
  });
  store = memoryStore();
  counter = 0;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await registered();
});
afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

const UNAVAILABLE = { success: false, error: 'This is not available right now. Please try again later.', reason: 'unavailable' };

describe('US-15 AC65: an iPhone chat turn is refused before the App Attest gate', () => {
  it('prompt missing: a signed POST gets 503 with no key read, no daily turn and no unit spent', async () => {
    mocks.prompt = { kind: 'missing' };
    const before = units();
    const res = await appChat(signed(chatBody), store);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE);
    expect(store.get).not.toHaveBeenCalled();
    expect(store.use).not.toHaveBeenCalled();
    expect(units()).toEqual(before);
    expect(mocks.getChatCompletion).not.toHaveBeenCalled();
  });

  it('prompt missing: 61 signed POSTs all get 503, never 429', async () => {
    mocks.prompt = { kind: 'missing' };
    const statuses = [];
    for (let i = 0; i < 61; i++) statuses.push((await appChat(signed(chatBody), store)).status);
    expect(new Set(statuses)).toEqual(new Set([503]));
  });

  it('prompt missing: the simulator bypass leaves its daily count unspent', async () => {
    mocks.prompt = { kind: 'missing' };
    process.env.APP_ATTEST_DEV_BYPASS = '1';
    const dev = new Request(`${BASE}/api/app/v1/chat`, { method: 'POST', headers: { 'x-app-attest-dev': 'sim-1', 'fly-client-ip': IP }, body: JSON.stringify(chatBody) });
    const before = appLimits.dev.chat.remaining('sim-1');
    expect((await appChat(dev, store)).status).toBe(503);
    expect(appLimits.dev.chat.remaining('sim-1')).toBe(before);
    expect(units().ip).toBe(200);
  });

  it('CHAT_ENABLED=false: refused before the gate too', async () => {
    process.env.CHAT_ENABLED = 'false';
    const before = units();
    const res = await appChat(signed(chatBody), store);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE);
    expect(store.get).not.toHaveBeenCalled();
    expect(store.use).not.toHaveBeenCalled();
    expect(units()).toEqual(before);
  });

  it('control: with the prompt loaded the gate runs and spends one daily turn', async () => {
    const res = await appChat(signed(chatBody), store);
    expect(res.status).toBe(200);
    await res.text();
    expect(store.use).toHaveBeenCalledTimes(1);
    expect(mocks.getChatCompletion).toHaveBeenCalledTimes(1);
  });
});
