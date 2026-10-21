/**
 * The front door of the iPhone app's AI routes (US-52, ios/architecture.md D8):
 * an App Attest assertion over this request, then the limits, then the route.
 * Order matters (adversary R2): the cheap checks and the key lookup run before
 * the body is read, so a script with no key never makes us buffer its upload.
 * Fails closed: no config or no key store is a 503, never a pass.
 */
import { readCappedBytes } from './capped-body.server';
import { getClientIp } from './local-first-route.server';
import { createQuotaCounter, DAY_MS } from './rate-limiter';
import { supabaseAdmin } from './supabase.server';
import {
  assertionSignatureValid, attestConfig, AttestError, devBypassAllowed, parseAssertion,
  requestClientData, validKeyId, type AttestEnvironment, type AttestedKey,
} from './app-attest.server';

export type AppUseKind = 'chat' | 'lab';

/** What one key may do per UTC day (D8 Limits). */
export const PER_KEY_DAILY: Record<AppUseKind, number> = { chat: 60, lab: 30 };

export type UseOutcome = 'ok' | 'stale' | 'limit' | 'unknown';

/** Where attested keys live. Throws when unreachable: the gate answers 503. */
export interface KeyStore {
  get(keyId: string): Promise<{ publicKey: string; environment: AttestEnvironment } | null>;
  /** 'exists' when the key id is already stored: a replayed attestation never resets a counter. */
  insert(key: AttestedKey): Promise<'ok' | 'exists'>;
  /** Advance the counter if higher and count one use against the key's daily cap, atomically (`app_attest_use`). */
  use(keyId: string, counter: number, kind: AppUseKind, cap: number): Promise<UseOutcome>;
}

/** The Supabase store (migration supabase/app-attest-2026-10.sql). Service role only. */
export const supabaseKeyStore: KeyStore = {
  async get(keyId) {
    if (!supabaseAdmin) throw new Error('key store not configured');
    const { data, error } = await supabaseAdmin.from('app_attest_keys')
      .select('public_key, environment').eq('key_id', keyId).maybeSingle();
    if (error) throw new Error('key store read failed');
    return data ? { publicKey: data.public_key as string, environment: data.environment as AttestEnvironment } : null;
  },
  async insert(key) {
    if (!supabaseAdmin) throw new Error('key store not configured');
    const { error } = await supabaseAdmin.from('app_attest_keys')
      .insert({ key_id: key.keyId, public_key: key.publicKeyPem, environment: key.environment, sign_count: 0 });
    if (!error) return 'ok';
    if (error.code === '23505') return 'exists';
    throw new Error('key store write failed');
  },
  async use(keyId, counter, kind, cap) {
    if (!supabaseAdmin) throw new Error('key store not configured');
    // An RPC returning the outcome, never `.update().select()` (CLAUDE.md gotcha).
    const { data, error } = await supabaseAdmin.rpc('app_attest_use', { p_key_id: keyId, p_count: counter, p_kind: kind, p_cap: cap });
    if (error || !['ok', 'stale', 'limit', 'unknown'].includes(data as string)) throw new Error('key store use failed');
    return data as UseOutcome;
  },
};

/**
 * The per-IP bucket. IPv6 is keyed on its /64, which one subscriber holds
 * whole (adversary R4); IPv4 on the address, so many phones behind one
 * carrier NAT share a bucket, the price of having one at all.
 */
export function ipBucket(ip: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  const [head] = ip.split('%');
  const halves = head.split('::');
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length > 1 && halves[1] ? halves[1].split(':') : [];
  const groups = halves.length > 1 ? [...left, ...Array(8 - left.length - right.length).fill('0'), ...right] : left;
  return groups.slice(0, 4).map((g) => g.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** The app's routes run on the education app only: on the brand surface they answer 503 (AC2, adversary R13). */
export function appRoutesOff(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CHAT_SURFACE === 'brand';
}

const num = (v: string | undefined, d: number) => (v && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);

/** Per IP per day, and per machine per day: in memory (D8 says why). */
export const appLimits = {
  ip: { chat: createQuotaCounter(200, DAY_MS, 30 * 60_000), lab: createQuotaCounter(200, DAY_MS, 30 * 60_000) },
  machine: {
    chat: createQuotaCounter(num(process.env.APP_CHAT_DAILY_CAP, 500), DAY_MS, 30 * 60_000),
    // Never more than 15% of the web's shared file cap, whatever the env says (AC4, Codex R7).
    lab: createQuotaCounter(Math.min(num(process.env.APP_LAB_DAILY_CAP, 300), Math.floor(0.15 * num(process.env.AI_DAILY_FILE_CAP, 2000))), DAY_MS, 30 * 60_000),
  },
  /** Refused signed requests per IP per day; past it, no key lookup or body read (adversary code R3). */
  failures: createQuotaCounter(50, DAY_MS, 30 * 60_000),
  /** Registration attempts per IP per day, counted before verifying (R11). */
  register: createQuotaCounter(10, DAY_MS, 30 * 60_000),
  /** The dev bypass's per-key count, since no key row exists for it. */
  dev: { chat: createQuotaCounter(PER_KEY_DAILY.chat, DAY_MS, 30 * 60_000), lab: createQuotaCounter(PER_KEY_DAILY.lab, DAY_MS, 30 * 60_000) },
};

const refuse = (status: number, reason: string, error: string) =>
  Response.json({ success: false, error, reason }, { status, headers: { 'Cache-Control': 'no-store' } });

const unauthorized = (reason: string) => refuse(401, reason, 'This request was not signed by the app.');
const unavailable = () => refuse(503, 'unavailable', 'This is not available right now. Please try again later.');
const overLimit = () => refuse(429, 'limit', 'Daily limit reached. Please try again tomorrow.');

/** One closed word per refusal, for the ops log (no key id, IP or content). */
function logRefusal(kind: AppUseKind, reason: string): void {
  console.log(JSON.stringify({ evt: 'app_gate_refused', kind, reason }));
}

export interface GateOptions { kind: AppUseKind; bodyCap: number; store?: KeyStore; env?: NodeJS.ProcessEnv }

/**
 * Checks the request and returns its raw body, or the refusal to send.
 * The caller parses the body it is given; the request's own body is spent.
 */
export async function appGate(request: Request, opts: GateOptions): Promise<{ body: Buffer } | Response> {
  const { kind } = opts;
  const env = opts.env ?? process.env;
  const store = opts.store ?? supabaseKeyStore;
  if (request.method !== 'POST') return refuse(405, 'method', 'POST only');
  const ip = ipBucket(getClientIp(request, 'fly'));
  const path = new URL(request.url).pathname;

  const dev = request.headers.get('x-app-attest-dev');
  if (dev !== null) {
    // AC3: the simulator's header, only where the bypass is allowed. Anywhere else it is a 401.
    if (!devBypassAllowed(env) || !/^[A-Za-z0-9-]{1,64}$/.test(dev)) { logRefusal(kind, 'dev_bypass_refused'); return unauthorized('dev_bypass_refused'); }
    const body = await readBody(request, opts.bodyCap);
    if (!body) return refuse(413, 'too_large', 'Request too large');
    if (!appLimits.dev[kind].take(dev, 1)) return overLimit();
    return takeShared(kind, ip) ? { body } : overLimit();
  }

  const config = attestConfig(env);
  if (!config) { logRefusal(kind, 'not_configured'); return unavailable(); }
  const keyId = request.headers.get('x-app-attest-key');
  const header = request.headers.get('x-app-attest-assertion');
  if (!validKeyId(keyId) || !header) { logRefusal(kind, 'missing_assertion'); return unauthorized('missing_assertion'); }

  // A refused signed request costs a key read and maybe a body read: past
  // the IP's failure budget, nothing more is read.
  if (appLimits.failures.remaining(ip) === 0) { logRefusal(kind, 'failure_limit'); return overLimit(); }
  const failed = (reason: string) => { appLimits.failures.take(ip, 1); logRefusal(kind, reason); return unauthorized(reason); };

  let assertion;
  try {
    assertion = parseAssertion(header, config.appId);
  } catch (error) {
    return failed(error instanceof AttestError ? error.reason : 'bad_assertion');
  }

  let key;
  try {
    key = await store.get(keyId);
  } catch {
    logRefusal(kind, 'store_unavailable');
    return unavailable(); // an outage is never "unknown key", or every app would re-attest (R11)
  }
  if (!key) return failed('unknown_key');
  // A development key stops working the day the flag goes off (R10).
  if (!config.environments.includes(key.environment)) { appLimits.failures.take(ip, 1); logRefusal(kind, 'environment_refused'); return unauthorized('unknown_key'); }

  const body = await readBody(request, opts.bodyCap);
  if (!body) {
    // Charged like any refused signed request, so it cannot repeat forever (Codex re-check R2).
    appLimits.failures.take(ip, 1);
    logRefusal(kind, 'too_large');
    return refuse(413, 'too_large', 'Request too large');
  }
  if (!assertionSignatureValid(assertion, requestClientData(request.method, path, body), key.publicKey)) return failed('bad_signature');

  let outcome: UseOutcome;
  try {
    outcome = await store.use(keyId, assertion.counter, kind, PER_KEY_DAILY[kind]);
  } catch {
    logRefusal(kind, 'store_unavailable');
    return unavailable();
  }
  if (outcome === 'unknown') return failed('unknown_key');
  if (outcome === 'stale') return failed('stale_counter');
  if (outcome === 'limit') { logRefusal(kind, 'key_limit'); return overLimit(); }
  return takeShared(kind, ip) ? { body } : overLimit();
}

/** The per-IP and per-machine counts, all or nothing. */
function takeShared(kind: AppUseKind, ip: string): boolean {
  if (!appLimits.ip[kind].take(ip, 1)) { logRefusal(kind, 'ip_limit'); return false; }
  if (appLimits.machine[kind].take('machine', 1)) return true;
  appLimits.ip[kind].refund(ip, 1);
  logRefusal(kind, 'machine_limit');
  return false;
}

/** The raw bytes, as the app hashed them (R2: never a UTF-8 round trip). Null past the cap. */
async function readBody(request: Request, cap: number): Promise<Buffer | null> {
  try {
    return await readCappedBytes(request, cap);
  } catch {
    return null;
  }
}
