import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// US-52 AC7e: /api/app/v1/lab-read runs /lab-import's gate in the same order and
// answers its headers once the App Attest counter is spent, then streams the
// read's answer as NDJSON. Model calls are mocked: no spend.

const mocks = vi.hoisted(() => ({ gateOpts: [] as Array<{ admit?: unknown }>, extract: vi.fn(), rootPem: '', extractOne: null as null | ((...a: unknown[]) => Promise<Response>) }));
vi.mock('@sentry/react-router', async (original) => ({ ...await original<typeof import('@sentry/react-router')>(), captureException: vi.fn() }));
vi.mock('./app-gate.server', async (original) => {
  const real = await original<typeof import('./app-gate.server')>();
  // A pass-through that records each call's options: which routes ask for capacity admission.
  return { ...real, appGate: (request: Request, opts: Parameters<typeof real.appGate>[1]) => { mocks.gateOpts.push(opts); return real.appGate(request, opts); } };
});
vi.mock('./lab-extract-one.server', async (original) => {
  const real = await original<typeof import('./lab-extract-one.server')>();
  // A stand-in only where a test sets one: a read that throws past extractOneFile's own catch.
  return { ...real, extractOneFile: (...a: Parameters<typeof real.extractOneFile>) => (mocks.extractOne ? mocks.extractOne(...a) : real.extractOneFile(...a)) };
});
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('./anthropic.server', async (original) => ({
  ...await original<typeof import('./anthropic.server')>(),
  extractOrClassify: mocks.extract,
}));
vi.mock('./app-attest.server', async (original) => {
  const real = await original<typeof import('./app-attest.server')>();
  // The test CA stands in for Apple's root; everything else is real.
  return { ...real, attestConfig: (env?: NodeJS.ProcessEnv) => { const c = real.attestConfig(env); return c && { ...c, rootPem: mocks.rootPem }; } };
});

import * as Sentry from '@sentry/react-router';
import { ExtractionStopError } from './anthropic.server';
import { appChallenge, appLabImport, appRegister } from './app-routes.server';
import { appLabRead } from './app-lab-read.server';
import { appLimits, ipBucket, type KeyStore, type UseOutcome } from './app-gate.server';
import { fakeDevice } from './app-attest.test-helpers';
import { requestClientData } from './app-attest.server';
import { machineFiles } from './rate-limiter';
import { createReadSlots } from './lab-read-slots.server';

const APP_ID = 'TEAM123456.com.drstanfield.healthroadmap';
const device = fakeDevice(APP_ID);
mocks.rootPem = device.rootPem;
const BASE = 'https://health-tool-edu.fly.dev';
const saved = { ...process.env };
const body = { pages: [{ type: 'text', content: 'LDL 3.1 mmol/L' }], unitSystem: 'si', ownDates: true, refusedRows: true };
const extraction = {
  classification: 'lab_report', reportDate: '2026-10-01', unrecognized: [], document: null,
  values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
  additionalValues: [], refusedValues: [],
};

type Row = { publicKey: string; environment: 'production' | 'development'; count: number; uses: Record<string, number> };
/** An in-memory store with the SQL function's semantics; `log` records each step in order. */
function memoryStore(log: string[]): KeyStore & { rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  return {
    rows,
    async get(keyId) { const r = rows.get(keyId); return r ? { publicKey: r.publicKey, environment: r.environment } : null; },
    async insert(k) {
      if (rows.has(k.keyId)) return 'exists';
      rows.set(k.keyId, { publicKey: k.publicKeyPem, environment: k.environment, count: 0, uses: { chat: 0, lab: 0 } });
      return 'ok';
    },
    async use(keyId, counter, kind, cap): Promise<UseOutcome> {
      log.push('counter spent');
      const r = rows.get(keyId);
      if (!r) return 'unknown';
      if (counter <= r.count) return 'stale';
      r.count = counter;
      if (r.uses[kind] + 1 > cap) return 'limit';
      r.uses[kind] += 1;
      return 'ok';
    },
  };
}

let store: ReturnType<typeof memoryStore>;
let log: string[];
let counter: number;
let slots: ReturnType<typeof createReadSlots>;

function reset() {
  for (const c of [appLimits.failures, appLimits.keyFailures, appLimits.register, appLimits.registered, appLimits.challenges, appLimits.ip.chat, appLimits.ip.lab, appLimits.machine.chat, appLimits.machine.lab, appLimits.dev.chat, appLimits.dev.lab, machineFiles]) c.reset();
  log = [];
  store = memoryStore(log);
  counter = 0;
}

async function registered() {
  const { challenge } = await appChallenge(new Request(`${BASE}/api/app/v1/attest/challenge`, { method: 'POST' })).json();
  await appRegister(new Request(`${BASE}/api/app/v1/attest/register`, {
    method: 'POST', headers: { 'fly-client-ip': '203.0.113.9' },
    body: JSON.stringify({ keyId: device.keyId, attestation: device.attest(challenge).toString('base64'), challenge }),
  }), store);
}

function signed(path: string, payload: object | string, o: { counter?: number; keyId?: string; assertion?: string } = {}) {
  const raw = Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload));
  const c = o.counter ?? ++counter;
  return new Request(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'x-app-attest-key': o.keyId ?? device.keyId,
      'x-app-attest-assertion': o.assertion ?? device.assert(requestClientData('POST', path, raw), c, APP_ID),
      'fly-client-ip': '203.0.113.9',
    },
    body: raw,
  });
}

/** The stream's lines, parsed; a blank keep-alive line is ''. */
async function lines(res: Response): Promise<unknown[]> {
  return (await res.text()).split('\n').slice(0, -1).map((l) => (l === '' ? '' : JSON.parse(l)));
}

const OLD = '/api/app/v1/lab-import';
const NEW = '/api/app/v1/lab-read';
const route = (path: string) => (path === OLD ? appLabImport : appLabRead);

beforeEach(() => {
  Object.assign(process.env, { APP_ATTEST_TEAM_ID: 'TEAM123456', SHOPIFY_API_SECRET: 'test-secret' });
  delete process.env.APP_ATTEST_DEV_BYPASS;
  delete process.env.CHAT_SURFACE;
  reset();
  slots = createReadSlots();
  mocks.extractOne = null;
  mocks.extract.mockReset().mockImplementation(async () => { log.push('read'); return extraction; });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  process.env = { ...saved };
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('US-52 AC7e: every gate or validation failure answers as /lab-import does, before any stream', () => {
  const cases: Array<{ name: string; arrange?: () => void | Promise<void>; request: (path: string) => Request; register?: false }> = [
    { name: 'routes switched off', arrange: () => { process.env.CHAT_SURFACE = 'brand'; }, request: (p) => signed(p, body) },
    { name: 'not POST', request: (p) => new Request(`${BASE}${p}`, { method: 'PUT', body: '{}' }) },
    { name: 'no assertion', request: (p) => new Request(`${BASE}${p}`, { method: 'POST', body: JSON.stringify(body) }) },
    { name: 'malformed assertion', request: (p) => signed(p, body, { assertion: 'AAAA' }) },
    { name: 'unknown key', register: false, request: (p) => signed(p, body) },
    { name: 'a counter already spent', arrange: () => { store.rows.get(device.keyId)!.count = 9; }, request: (p) => signed(p, body, { counter: 9 }) },
    { name: 'the key\'s daily cap', arrange: () => { store.rows.get(device.keyId)!.uses.lab = 30; }, request: (p) => signed(p, body) },
    { name: 'the shared file cap', arrange: () => { machineFiles.take('machine', machineFiles.remaining('machine')); }, request: (p) => signed(p, body) },
    { name: 'a store outage', arrange: () => { store.use = async () => { throw new Error('down'); }; }, request: (p) => signed(p, body) },
    { name: 'a body over 25 MB', request: (p) => signed(p, 'x'.repeat(25 * 1024 * 1024 + 1)) },
    { name: 'a body that is not JSON', request: (p) => signed(p, '{not json') },
    { name: 'a body the schema refuses', request: (p) => signed(p, { pages: [] }) },
  ];

  it.each(cases)('$name: same status, body and type on both routes, and no read', async ({ arrange, request, register }) => {
    const answers = [];
    for (const path of [OLD, NEW]) {
      reset();
      delete process.env.CHAT_SURFACE;
      if (register !== false) await registered();
      await arrange?.();
      const res = await route(path)(request(path), store);
      answers.push({ status: res.status, type: res.headers.get('content-type'), body: await res.json() });
    }
    expect(answers[0].status).toBeGreaterThanOrEqual(400);
    expect(answers[1]).toEqual(answers[0]);
    expect(mocks.extract).not.toHaveBeenCalled();
  });
});

describe('US-52 AC7e: an accepted read streams NDJSON', () => {
  it('spends the counter before the headers are sent, and sends them before the read ends', async () => {
    await registered();
    let finish!: (v: unknown) => void;
    mocks.extract.mockImplementation(() => { log.push('read started'); return new Promise((r) => { finish = r; }); });
    const res = await appLabRead(signed(NEW, body), store, slots);
    log.push('headers');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/x-ndjson');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(log).toEqual(['counter spent', 'read started', 'headers']);
    finish(extraction);
    expect((await lines(res)).at(-1)).toMatchObject({ status: 200 });
  });

  it('first line accepted, last line the old route\'s status and body for the same read', async () => {
    await registered();
    const old = await appLabImport(signed(OLD, body), store);
    const oldBody = await old.json();
    const res = await appLabRead(signed(NEW, body), store, slots);
    const got = await lines(res);
    expect(got[0]).toEqual({ accepted: true });
    expect(got.at(-1)).toEqual({ status: old.status, body: oldBody });
    expect(old.status).toBe(200);
    expect(got).toHaveLength(2);
  });

  it.each([
    { name: 'a timeout', fail: () => new DOMException('signal timed out', 'TimeoutError') },
    { name: 'a declined report', fail: () => new ExtractionStopError('refused', 'other') },
    { name: 'a server error', fail: () => new Error('extraction returned malformed JSON') },
  ])('$name: HTTP stays 200, the last line holds the old route\'s status and body', async ({ fail }) => {
    await registered();
    mocks.extract.mockImplementation(async () => { throw fail(); });
    const old = await appLabImport(signed(OLD, body), store);
    const oldBody = await old.json();
    const res = await appLabRead(signed(NEW, body), store, slots);
    expect(res.status).toBe(200);
    const got = await lines(res);
    expect(got[0]).toEqual({ accepted: true });
    expect(got.at(-1)).toEqual({ status: old.status, body: oldBody });
    expect(old.status).toBeGreaterThanOrEqual(422);
  });

  it('writes a blank keep-alive line every 15 s while the read runs, and stops after the answer', async () => {
    await registered();
    const request = signed(NEW, body);
    vi.useFakeTimers();
    let finish!: (v: unknown) => void;
    mocks.extract.mockImplementation(() => new Promise((r) => { finish = r; }));
    const res = await appLabRead(request, store, slots);
    await vi.advanceTimersByTimeAsync(46_000);
    finish(extraction);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    const got = await lines(res);
    expect(got.slice(0, 4)).toEqual([{ accepted: true }, '', '', '']);
    expect(got).toHaveLength(5);
    expect(got[4]).toMatchObject({ status: 200 });
  });

  it('a client that goes away clears the keep-alive timer', async () => {
    await registered();
    const request = signed(NEW, body);
    vi.useFakeTimers();
    mocks.extract.mockImplementation(() => new Promise(() => {}));
    const res = await appLabRead(request, store, slots);
    expect(vi.getTimerCount()).toBe(1);
    await res.body!.cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the read is the old route\'s call: one 90 s budget with the 429 retry', async () => {
    await registered();
    await lines(await appLabRead(signed(NEW, body), store, slots));
    expect(mocks.extract).toHaveBeenCalledWith(body.pages, { timeoutMs: 90_000, retryRateLimit: true, oneDeadline: true, onRetry: expect.any(Function) });
  });
});

const UNAVAILABLE = { success: false, error: 'This is not available right now. Please try again later.', reason: 'unavailable' };

describe('US-52 AC7e: reads in flight are capped, inside the gate', () => {
  /** A read the test ends: `finish` answers it. */
  function pendingRead() {
    const ends: Array<{ finish: (v: unknown) => void }> = [];
    mocks.extract.mockImplementation(() => new Promise((finish) => { ends.push({ finish }); }));
    return ends;
  }
  const IP = ipBucket('203.0.113.9');
  const allowances = () => ({
    spent: log.filter((l) => l === 'counter spent').length,
    count: store.rows.get(device.keyId)!.count,
    keyUses: store.rows.get(device.keyId)!.uses.lab,
    ip: appLimits.ip.lab.remaining(IP),
    machine: appLimits.machine.lab.remaining('machine'),
    files: machineFiles.remaining('machine'),
    failures: appLimits.failures.remaining(IP),
    keyFailures: appLimits.keyFailures.remaining(device.keyId),
  });

  it('uploads that never finish hold no slot: an 11th, valid request is admitted and read', async () => {
    await registered();
    for (let i = 0; i < 10; i++) {
      const path = NEW;
      const raw = Buffer.from(JSON.stringify(body));
      const never = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(raw.subarray(0, 10))); } });
      void appLabRead(new Request(`${BASE}${path}`, {
        method: 'POST', body: never, duplex: 'half',
        headers: { 'x-app-attest-key': device.keyId, 'x-app-attest-assertion': device.assert(requestClientData('POST', path, raw), ++counter, APP_ID), 'fly-client-ip': '203.0.113.9' },
      } as RequestInit), store, slots);
    }
    await new Promise((r) => setTimeout(r, 10));
    expect(slots.inFlight()).toBe(0);
    const res = await appLabRead(signed(NEW, body), store, slots);
    expect(res.status).toBe(200);
    expect((await lines(res)).at(-1)).toMatchObject({ status: 200 });
    expect(mocks.extract).toHaveBeenCalledTimes(1);
  });

  it.each([
    { name: 'the 6th for one key', slotsFor: () => createReadSlots(10, 5), open: 5 },
    { name: 'the 11th on a full machine', slotsFor: () => createReadSlots(10, 100), open: 10 },
  ])('$name gets HTTP 503 and spends nothing: no store use, no counter, no allowance', async ({ slotsFor, open }) => {
    await registered();
    slots = slotsFor();
    const ends = pendingRead();
    const reads = [];
    for (let i = 0; i < open; i++) reads.push(await appLabRead(signed(NEW, body), store, slots));
    expect(reads.every((r) => r.status === 200)).toBe(true);
    const before = allowances();
    const res = await appLabRead(signed(NEW, body), store, slots);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual(UNAVAILABLE);
    expect(allowances()).toEqual(before);
    expect(mocks.extract).toHaveBeenCalledTimes(open);
    for (const e of ends) e.finish(extraction);
    await Promise.all(reads.map(lines));
    expect(slots.inFlight()).toBe(0);
  });

  it.each([
    { name: 'the key\'s daily cap', arrange: () => { store.rows.get(device.keyId)!.uses.lab = 30; }, status: 429, payload: body },
    { name: 'a store outage', arrange: () => { store.use = async () => { throw new Error('down'); }; }, status: 503, payload: body },
    { name: 'a counter already spent', arrange: () => { store.rows.get(device.keyId)!.count = 99; }, status: 401, payload: body },
    { name: 'a body the schema refuses', arrange: () => {}, status: 400, payload: { pages: [] } },
  ])('admitted, then refused by $name: the slot is released', async ({ arrange, status, payload }) => {
    await registered();
    slots = createReadSlots(1, 1);
    arrange();
    expect((await appLabRead(signed(NEW, payload), store, slots)).status).toBe(status);
    expect(slots.inFlight()).toBe(0);
  });

  it.each([
    { name: 'a success' },
    { name: 'a read failure', arrange: () => { mocks.extract.mockRejectedValue(new Error('extraction returned malformed JSON')); } },
    { name: 'a throw', arrange: () => { mocks.extractOne = async () => { throw new TypeError('boom'); }; } },
  ])('slots are free after $name: the next read on a one-slot machine is accepted', async ({ arrange }) => {
    await registered();
    slots = createReadSlots(1, 1);
    arrange?.();
    await lines(await appLabRead(signed(NEW, body), store, slots));
    expect(slots.inFlight()).toBe(0);
    mocks.extractOne = null;
    mocks.extract.mockReset().mockResolvedValue(extraction);
    const next = await appLabRead(signed(NEW, body), store, slots);
    expect((await lines(next)).at(-1)).toMatchObject({ status: 200 });
  });

  it('a reader that goes away frees its slot once the read it started ends', async () => {
    await registered();
    slots = createReadSlots(1, 1);
    const ends = pendingRead();
    const res = await appLabRead(signed(NEW, body), store, slots);
    await res.body!.cancel();
    // The read still holds its pages until its budget ends it, so the slot is still taken.
    expect(slots.inFlight()).toBe(1);
    expect((await appLabRead(signed(NEW, body), store, slots)).status).toBe(503);
    ends[0].finish(extraction);
    await vi.waitFor(() => expect(slots.inFlight()).toBe(0));
    mocks.extract.mockReset().mockResolvedValue(extraction);
    const next = await appLabRead(signed(NEW, body), store, slots);
    expect((await lines(next)).at(-1)).toMatchObject({ status: 200 });
  });

  it('/lab-import passes no admission: it runs with every lab-read slot taken', async () => {
    await registered();
    slots = createReadSlots(0, 0);
    mocks.gateOpts.length = 0;
    expect((await appLabImport(signed(OLD, body), store)).status).toBe(200);
    expect(mocks.gateOpts.map((o) => 'admit' in o && o.admit !== undefined)).toEqual([false]);
    await appLabRead(signed(NEW, body), store, slots);
    expect(mocks.gateOpts.map((o) => o.admit !== undefined)).toEqual([false, true]);
  });
});

describe('US-52 AC7e: an unexpected throw reaches Sentry', () => {
  it('the error alone is captured, and the final line is a 500', async () => {
    await registered();
    const boom = new TypeError('boom');
    mocks.extractOne = async () => { throw boom; };
    const got = await lines(await appLabRead(signed(NEW, body), store, slots));
    expect(got.at(-1)).toEqual({ status: 500, body: { success: false, error: 'Failed to process request' } });
    expect(Sentry.captureException).toHaveBeenCalledWith(boom);
    expect(vi.mocked(Sentry.captureException).mock.calls.find((c) => c[0] === boom)).toHaveLength(1);
  });
});
