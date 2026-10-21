import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// US-52: the iPhone app's routes. The gate (AC1–AC4) with a fake Apple CA, the
// chat turn run by the widget's pipeline with nothing stored (AC5), and the
// web's lab extraction reused (AC7). Model calls are mocked: no spend.

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  guest: vi.fn(),
  audit: vi.fn(),
  getChatCompletion: vi.fn(),
  extract: vi.fn(),
  rootPem: '',
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('./supabase.server', () => ({
  supabaseAdmin: null,
  logAudit: mocks.audit, getProfile: vi.fn(async () => null), updateSubscriptionPlan: vi.fn(),
  createUserClient: vi.fn(() => ({ from: mocks.from })),
  getOrCreateGuestSession: mocks.guest,
  GuestRateLimitError: class extends Error {},
}));
vi.mock('./chat.server', async (original) => ({
  resolveChatContext: (inputs: unknown) => ({ healthDocuments: [], userContextJson: JSON.stringify(inputs ?? null) }),
  buildSystemBlocks: () => [],
  buildConversationMessages: (history: unknown[], message: string) => [...history, { role: 'user', content: message }],
  matchDocumentTitle: () => null,
  loadMatchedArticlesFromHandles: () => ({ content: 'x', titles: ['ApoB explained'], skipped: [], reduced: [] }),
  DOCTOR_POSTURE: 'doctor', BRAND_POSTURE: 'brand',
  getChatCompletion: mocks.getChatCompletion,
  reportChatFallback: vi.fn(), generateTitle: () => 't', CHAT_MODEL: 'test',
  MAX_MESSAGE_LENGTH: (await original<typeof import('./chat.server')>()).MAX_MESSAGE_LENGTH,
}));
vi.mock('./chat-router.server', async (original) => ({
  ...await original<typeof import('./chat-router.server')>(),
  routeQuery: vi.fn(async () => ({ handles: ['apob'], latencyMs: 0, cacheHit: false, usage: { inputTokens: 0, cacheReadTokens: 0 } })),
  reportRouterFailure: vi.fn(),
}));
vi.mock('./chat-classifier.server', () => ({ classifyMessage: async () => ({ routerSkipped: false, classification: 'ROUTE', latencyMs: 0 }), shouldFireRouter: () => true }));
vi.mock('./anthropic.server', async (original) => ({
  ...await original<typeof import('./anthropic.server')>(),
  extractOrClassify: mocks.extract,
}));
vi.mock('./app-attest.server', async (original) => {
  const real = await original<typeof import('./app-attest.server')>();
  // The test CA stands in for Apple's root; everything else is real.
  return { ...real, attestConfig: (env?: NodeJS.ProcessEnv) => { const c = real.attestConfig(env); return c && { ...c, rootPem: mocks.rootPem }; } };
});

import { appChallenge, appChat, appLabImport, appRegister as register } from './app-routes.server';
import { appLimits, ipBucket, type KeyStore, type UseOutcome } from './app-gate.server';
import { fakeDevice } from './app-attest.test-helpers';
import { requestClientData } from './app-attest.server';
import { machineFiles } from './rate-limiter';

const APP_ID = 'TEAM123456.com.drbrad.healthroadmap';
const device = fakeDevice(APP_ID);
mocks.rootPem = device.rootPem;
const BASE = 'https://health-tool-edu.fly.dev';
const saved = { ...process.env };

/** An in-memory store with the SQL function's semantics. */
function memoryStore(): KeyStore & { rows: Map<string, { publicKey: string; environment: 'production' | 'development'; count: number; uses: Record<string, number> }>; fail?: boolean } {
  const rows = new Map();
  const store = {
    rows,
    fail: false,
    async get(keyId: string) { if (store.fail) throw new Error('down'); const r = rows.get(keyId); return r ? { publicKey: r.publicKey, environment: r.environment } : null; },
    async insert(k: { keyId: string; publicKeyPem: string; environment: 'production' | 'development' }) {
      if (store.fail) throw new Error('down');
      if (rows.has(k.keyId)) return 'exists' as const;
      rows.set(k.keyId, { publicKey: k.publicKeyPem, environment: k.environment, count: 0, uses: { chat: 0, lab: 0 } });
      return 'ok' as const;
    },
    async use(keyId: string, counter: number, kind: 'chat' | 'lab', cap: number): Promise<UseOutcome> {
      if (store.fail) throw new Error('down');
      const r = rows.get(keyId);
      if (!r) return 'unknown';
      if (counter <= r.count) return 'stale';
      r.count = counter;
      if (r.uses[kind] + 1 > cap) return 'limit';
      r.uses[kind] += 1;
      return 'ok';
    },
  };
  return store;
}

let store: ReturnType<typeof memoryStore>;
let counter: number;

async function registered() {
  const { challenge } = await appChallenge(new Request(`${BASE}/api/app/v1/attest/challenge`, { method: 'POST' })).json();
  const res = await register(new Request(`${BASE}/api/app/v1/attest/register`, {
    method: 'POST', headers: { 'fly-client-ip': '203.0.113.9' },
    body: JSON.stringify({ keyId: device.keyId, attestation: device.attest(challenge).toString('base64'), challenge }),
  }), store);
  return res;
}

function signed(path: string, body: object, o: { counter?: number; tamper?: boolean; ip?: string } = {}) {
  const raw = Buffer.from(JSON.stringify(body));
  const c = o.counter ?? ++counter;
  const assertion = device.assert(requestClientData('POST', path, raw), c, APP_ID);
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'x-app-attest-key': device.keyId, 'x-app-attest-assertion': assertion, 'fly-client-ip': o.ip ?? '203.0.113.9' },
    body: o.tamper ? Buffer.from(JSON.stringify({ ...body, message: 'other' })) : raw,
  });
}

const chatBody = { message: 'What is ApoB?', history: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'hello' }], guestInputs: { unitSystem: 'si', medications: [], screenings: [], sex: 'female' }, stream: true };

async function lines(res: Response) {
  return (await res.text()).trimEnd().split('\n').map((l) => JSON.parse(l));
}

beforeEach(async () => {
  Object.assign(process.env, { APP_ATTEST_TEAM_ID: 'TEAM123456', SHOPIFY_API_SECRET: 'test-secret' });
  delete process.env.APP_ATTEST_DEV_BYPASS;
  delete process.env.CHAT_SURFACE;
  for (const c of [appLimits.failures, appLimits.register, appLimits.ip.chat, appLimits.ip.lab, appLimits.machine.chat, appLimits.machine.lab, appLimits.dev.chat, appLimits.dev.lab, machineFiles]) c.reset();
  store = memoryStore();
  counter = 0;
  mocks.getChatCompletion.mockReset().mockImplementation(async (_s: unknown, _m: unknown, _edits: boolean, onEvent?: (e: unknown) => void) => {
    onEvent?.({ type: 'text', text: 'Synthetic answer' });
    return { content: 'Synthetic answer', usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheCreationTokens: 0 }, isFallback: false, stopReason: 'end_turn' };
  });
  mocks.extract.mockReset().mockResolvedValue({
    classification: 'lab_report', reportDate: '2026-10-01', unrecognized: [], document: null,
    values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' },
      { metric: 'hba1c', valueSI: 40, displayValue: 40, displayUnit: 'mmol/mol', displaySystem: 'si', confidence: 'high', recordedAt: '2025-04-02' }],
    additionalValues: [], refusedValues: [{ metric: 'creatinine', value: 80, unit: '', reason: 'unit' }],
  });
  mocks.from.mockReset();
  mocks.guest.mockReset();
  mocks.audit.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
});

describe('US-52 AC1: registration', () => {
  it('stores a key whose attestation checks out, once', async () => {
    expect((await registered()).status).toBe(200);
    expect(store.rows.has(device.keyId)).toBe(true);
    const again = await registered();
    expect(again.status).toBe(409);
    expect((await again.json()).reason).toBe('key_exists');
  });

  it('refuses a forged challenge and caps attempts per IP', async () => {
    const res = await register(new Request(`${BASE}/x`, { method: 'POST', headers: { 'fly-client-ip': '198.51.100.1' }, body: JSON.stringify({ keyId: device.keyId, attestation: 'AA==', challenge: 'nope' }) }), store);
    expect(res.status).toBe(401);
    for (let i = 0; i < 9; i++) await register(new Request(`${BASE}/x`, { method: 'POST', headers: { 'fly-client-ip': '198.51.100.1' }, body: '{}' }), store);
    const capped = await register(new Request(`${BASE}/x`, { method: 'POST', headers: { 'fly-client-ip': '198.51.100.1' }, body: '{}' }), store);
    expect(capped.status).toBe(429);
  });
});

describe('US-52 AC1/AC2: the gate', () => {
  it('refuses an unsigned request before any model call', async () => {
    const res = await appChat(new Request(`${BASE}/api/app/v1/chat`, { method: 'POST', body: JSON.stringify(chatBody) }), store);
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe('missing_assertion');
    expect(mocks.getChatCompletion).not.toHaveBeenCalled();
  });

  it('refuses an unknown key without reading the body', async () => {
    const req = signed('/api/app/v1/chat', chatBody);
    const res = await appChat(req, store);
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe('unknown_key');
    expect(req.bodyUsed).toBe(false);
  });

  it('refuses an altered body, a replayed counter and another path', async () => {
    await registered();
    expect((await (await appChat(signed('/api/app/v1/chat', chatBody, { tamper: true }), store)).json()).reason).toBe('bad_signature');
    expect((await appChat(signed('/api/app/v1/chat', chatBody, { counter: 5 }), store)).status).toBe(200);
    expect((await (await appChat(signed('/api/app/v1/chat', chatBody, { counter: 5 }), store)).json()).reason).toBe('stale_counter');
    const labSigned = signed('/api/app/v1/lab-import', chatBody, { counter: 9 });
    const moved = new Request(`${BASE}/api/app/v1/chat`, { method: 'POST', headers: labSigned.headers, body: await labSigned.arrayBuffer() });
    expect((await (await appChat(moved, store)).json()).reason).toBe('bad_signature');
    expect(mocks.getChatCompletion).toHaveBeenCalledTimes(1);
  });

  it('stops reading after an IP\'s refused requests run out', async () => {
    await registered();
    for (let i = 0; i < 50; i++) await appChat(signed('/api/app/v1/chat', chatBody, { tamper: true }), store);
    const req = signed('/api/app/v1/chat', chatBody);
    const res = await appChat(req, store);
    expect(res.status).toBe(429);
    expect(req.bodyUsed).toBe(false);
    expect(mocks.getChatCompletion).not.toHaveBeenCalled();
  });

  it('charges an oversized body to the failure budget, still a 413 (Codex re-check R2)', async () => {
    await registered();
    const big = { message: 'x'.repeat(2 * 1024 * 1024 + 10) };
    for (let i = 0; i < 50; i++) expect((await appChat(signed('/api/app/v1/chat', big), store)).status).toBe(413);
    let reads = 0;
    const get = store.get.bind(store);
    store.get = async (keyId: string) => { reads++; return get(keyId); };
    const req = signed('/api/app/v1/chat', big);
    const res = await appChat(req, store);
    expect(res.status).toBe(429);
    expect(reads).toBe(0);
    expect(req.bodyUsed).toBe(false);
    expect(mocks.getChatCompletion).not.toHaveBeenCalled();
  });

  it('does not charge a dropped upload to the failure budget (re-check adversary R1)', async () => {
    await registered();
    const ok = signed('/api/app/v1/chat', chatBody);
    const broken = () => new Request(ok.url, {
      method: 'POST', headers: ok.headers, duplex: 'half',
      body: new ReadableStream({ pull(c) { c.error(new Error('connection reset')); } }),
    } as RequestInit);
    for (let i = 0; i < 60; i++) expect((await appChat(broken(), store)).status).toBe(400);
    expect(appLimits.failures.remaining(ipBucket('203.0.113.9'))).toBe(50);
  });

  it('answers 503, never a pass, with no team id, a store outage or on the brand surface', async () => {
    await registered();
    delete process.env.APP_ATTEST_TEAM_ID;
    expect((await appChat(signed('/api/app/v1/chat', chatBody), store)).status).toBe(503);
    process.env.APP_ATTEST_TEAM_ID = 'TEAM123456';
    store.fail = true;
    const down = await appChat(signed('/api/app/v1/chat', chatBody), store);
    expect(down.status).toBe(503);
    expect((await down.json()).reason).toBe('unavailable');
    store.fail = false;
    process.env.CHAT_SURFACE = 'brand';
    expect((await appChat(signed('/api/app/v1/chat', chatBody), store)).status).toBe(503);
    expect(mocks.getChatCompletion).not.toHaveBeenCalled();
  });
});

describe('US-52 AC3: the simulator bypass', () => {
  const dev = (path: string, body: object) => new Request(`${BASE}${path}`, { method: 'POST', headers: { 'x-app-attest-dev': 'sim-1', 'fly-client-ip': '203.0.113.9' }, body: JSON.stringify(body) });

  it('is refused in production even with the flag on', async () => {
    process.env.APP_ATTEST_DEV_BYPASS = '1';
    process.env.NODE_ENV = 'production';
    const res = await appChat(dev('/api/app/v1/chat', chatBody), store);
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe('dev_bypass_refused');
    delete process.env.NODE_ENV;
    expect((await appChat(dev('/api/app/v1/chat', chatBody), store)).status).toBe(401);
    expect(mocks.getChatCompletion).not.toHaveBeenCalled();
  });

  it('is refused without the flag, and accepted with it in development', async () => {
    process.env.NODE_ENV = 'development';
    expect((await appChat(dev('/api/app/v1/chat', chatBody), store)).status).toBe(401);
    process.env.APP_ATTEST_DEV_BYPASS = '1';
    expect((await appChat(dev('/api/app/v1/chat', chatBody), store)).status).toBe(200);
  });
});

describe('US-52 AC4: limits', () => {
  it('stops a key at its daily cap, before the model', async () => {
    await registered();
    for (let i = 0; i < 60; i++) expect((await appChat(signed('/api/app/v1/chat', { ...chatBody, stream: false }), store)).status).toBe(200);
    const over = await appChat(signed('/api/app/v1/chat', chatBody), store);
    expect(over.status).toBe(429);
    expect(mocks.getChatCompletion).toHaveBeenCalledTimes(60);
  });

  it('keys IPv6 on the /64', () => {
    expect(ipBucket('2001:db8:1:2:aaaa::1')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8:1:2:bbbb:cccc:dddd:eeee')).toBe('2001:db8:1:2::/64');
    expect(ipBucket('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(ipBucket('203.0.113.9')).toBe('203.0.113.9');
    expect(ipBucket('::ffff:203.0.113.9')).toBe('203.0.113.9');
  });
});

describe('US-52 AC5: the chat turn', () => {
  it('runs the widget pipeline and streams, storing nothing', async () => {
    await registered();
    const res = await appChat(signed('/api/app/v1/chat', { ...chatBody, canApplyEdits: true, sessionToken: 'x' }), store);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    const out = await lines(res);
    expect(out.find((l) => l.type === 'sources')).toEqual({ type: 'sources', titles: ['ApoB explained'] });
    expect(out.find((l) => l.type === 'text')).toEqual({ type: 'text', text: 'Synthetic answer' });
    const done = out.at(-1);
    expect(done).toMatchObject({ type: 'done', success: true, content: 'Synthetic answer' });
    // The widget's history and context reached the model; no form edits for the app.
    const [, messages, canApplyEdits] = mocks.getChatCompletion.mock.calls[0];
    expect(messages).toEqual([...chatBody.history, { role: 'user', content: 'What is ApoB?' }]);
    expect(canApplyEdits).toBe(false);
    // D9: no guest session, no row, no audit.
    expect(mocks.guest).not.toHaveBeenCalled();
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});

describe('US-52 AC7: lab import', () => {
  const body = { pages: [{ type: 'text', content: 'LDL 3.1 mmol/L' }], unitSystem: 'si', ownDates: true, refusedRows: true };

  it('runs the web extraction and returns proposed values, dated ones kept', async () => {
    await registered();
    const res = await appLabImport(signed('/api/app/v1/lab-import', body), store);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.values.map((v: { metric: string }) => v.metric)).toEqual(['ldl', 'hba1c']);
    expect(json.data.refusedValues).toHaveLength(1);
    expect(mocks.extract).toHaveBeenCalledWith(body.pages, { timeoutMs: 60_000 });
  });

  it('refuses an invalid body after the gate, without a model call', async () => {
    await registered();
    const res = await appLabImport(signed('/api/app/v1/lab-import', { pages: [] }), store);
    expect(res.status).toBe(400);
    expect(mocks.extract).not.toHaveBeenCalled();
  });

  it('stops at the shared per-machine file cap', async () => {
    await registered();
    machineFiles.take('machine', Number(process.env.AI_DAILY_FILE_CAP || 2000));
    expect((await appLabImport(signed('/api/app/v1/lab-import', body), store)).status).toBe(429);
    expect(mocks.extract).not.toHaveBeenCalled();
  });
});

it('the test key is a real P-256 key', () => {
  expect(crypto.createPublicKey(device.privateKey).asymmetricKeyDetails?.namedCurve).toBe('prime256v1');
});
