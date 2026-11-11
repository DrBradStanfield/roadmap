/**
 * The iPhone app's four routes (US-52, ios/architecture.md D8), as plain
 * handlers. The route files under app/routes/api.app.v1.* only call these: a
 * route module's extra exports would pull server code into the client build.
 */
import * as Sentry from '@sentry/react-router';
import { labImportRequestSchema } from '../../packages/health-core/src/validation';
import { action as webChatAction } from '../routes/api.chat';
import { attestConfig, AttestError, challengeValid, newChallenge, validKeyId, verifyAttestation } from './app-attest.server';
import { appGate, appLimits, appRoutesOff, ipBucket, supabaseKeyStore, type KeyStore } from './app-gate.server';
import { SMALL_BODY_CAP } from './capped-body.server';
import { extractOneFile, TOO_SLOW } from './lab-extract-one.server';
import { BODY_TOO_LARGE, getClientIp, parseSimpleRequestJson } from './local-first-route.server';

/** 2 MB, the web chat's own cap (api.chat.ts). */
const APP_CHAT_BODY_CAP = 2 * 1024 * 1024;
/** One file's pages: the web's 20 pages as JPEG or text fit well inside it (D8). */
const APP_LAB_BODY_CAP = 25 * 1024 * 1024;

const json = (status: number, body: object) => Response.json(body, { status, headers: { 'Cache-Control': 'no-store' } });
const unavailable = () => json(503, { success: false, error: 'This is not available right now. Please try again later.', reason: 'unavailable' });
export const postOnly = () => json(405, { success: false, error: 'POST only' });

/** POST attest/challenge: HMAC'd, 5 minutes, so issuing one stores nothing; using one spends it (AC1a). */
export function appChallenge(request: Request): Response {
  if (request.method !== 'POST') return postOnly();
  if (appRoutesOff() || !attestConfig()) return unavailable();
  return json(200, { challenge: newChallenge() });
}

const registerRefused = (status: number, reason: string) => {
  console.log(JSON.stringify({ evt: 'app_gate_refused', kind: 'register', reason }));
  return json(status, { success: false, error: 'Registration refused', reason });
};

/** POST attest/register { keyId, attestation, challenge }: attempts counted per IP before anything is verified (AC1, AC4). */
export async function appRegister(request: Request, store: KeyStore = supabaseKeyStore): Promise<Response> {
  if (request.method !== 'POST') return postOnly();
  const config = attestConfig();
  if (appRoutesOff() || !config) return unavailable();
  const ip = ipBucket(getClientIp(request, 'fly'));
  const attempt = appLimits.register.reserve(ip, 1);
  if (!attempt) return registerRefused(429, 'limit');

  const body = await parseSimpleRequestJson(request, SMALL_BODY_CAP) as { keyId?: unknown; attestation?: unknown; challenge?: unknown } | typeof BODY_TOO_LARGE | null;
  if (body === BODY_TOO_LARGE) return registerRefused(413, 'too_large');
  if (!body || typeof body !== 'object') return registerRefused(400, 'bad_request');
  // Checked and spent with no await between, so two requests cannot both use it, and
  // before the other fields, so a malformed attempt spends it too (AC1a, Codex R1).
  if (!challengeValid(body.challenge) || !appLimits.challenges.take(body.challenge, 1)) return registerRefused(401, 'bad_challenge');
  if (!validKeyId(body.keyId) || typeof body.attestation !== 'string') return registerRefused(400, 'bad_request');

  let key;
  try {
    key = verifyAttestation({ keyId: body.keyId, attestation: Buffer.from(body.attestation, 'base64'), challenge: body.challenge, config });
  } catch (error) {
    return registerRefused(401, error instanceof AttestError ? error.reason : 'bad_attestation');
  }
  // A success spends the larger success cap instead of an attempt, so an IP's
  // neighbours are blocked only by failing attempts (AC1b). Reserved before the insert.
  const success = appLimits.registered.reserve(ip, 1);
  if (!success) return registerRefused(429, 'limit');
  let inserted;
  try {
    inserted = await store.insert(key);
  } catch {
    // An outage is not a failed attempt: both units go back, as in the gate.
    success();
    attempt();
    return registerRefused(503, 'store_unavailable');
  }
  if (inserted === 'exists') { success(); return registerRefused(409, 'key_exists'); }
  attempt();
  return json(200, { success: true });
}

/**
 * POST chat: the gate, then the web widget's own turn (api.chat.ts), told by
 * a registered symbol in the server-built context that App Attest passed (AC5).
 */
export async function appChat(request: Request, store?: KeyStore): Promise<Response> {
  if (appRoutesOff()) return unavailable();
  const gate = await appGate(request, { kind: 'chat', bodyCap: APP_CHAT_BODY_CAP, store });
  if (gate instanceof Response) return gate;
  const inner = new Request(request.url, { method: 'POST', body: new Uint8Array(gate.body), headers: { 'Content-Type': 'application/json' } });
  const context = { [Symbol.for('roadmap.us52.app-attested')]: true };
  return webChatAction({ request: inner, params: {}, context } as unknown as Parameters<typeof webChatAction>[0]);
}

/** POST lab-import: the gate (which also spends the web's file cap, AC4d), then the web's single-file extraction; proposed values back, nothing stored (AC7). */
export async function appLabImport(request: Request, store?: KeyStore): Promise<Response> {
  if (appRoutesOff()) return unavailable();
  const gate = await appGate(request, { kind: 'lab', bodyCap: APP_LAB_BODY_CAP, store });
  if (gate instanceof Response) return gate;
  let parsed: unknown;
  try {
    parsed = JSON.parse(gate.body.toString('utf8'));
  } catch {
    return json(400, { success: false, error: 'Invalid request' });
  }
  const validation = labImportRequestSchema.safeParse(parsed);
  if (!validation.success) return json(400, { success: false, error: 'Invalid request' });
  const start = Date.now();
  let retried = false;
  const res = await extractOneFile(validation.data, undefined, { timeoutMs: 90_000, oneDeadline: true, onRetry: () => { retried = true; } });
  await reportSlowImport(res, Date.now() - start, retried);
  return res;
}

/**
 * A timed-out or slow (over 60 s) phone import reports one Sentry warning of four
 * fixed tags (US-52 AC7d). The request, breadcrumbs, user and trace link the SDK
 * would attach are dropped from it: the request's headers name the key and the upload's size.
 */
async function reportSlowImport(res: Response, ms: number, retried: boolean): Promise<void> {
  const timedOut = res.status === 500 && await res.clone().json().then((b) => b?.error === TOO_SLOW, () => false);
  if (!timedOut && ms <= 60_000) return;
  const outcome = timedOut ? 'timeout' : res.ok ? 'slow-success' : 'slow-failure';
  const duration = ms <= 60_000 ? '0-60' : ms < 75_000 ? '60-75' : ms < 90_000 ? '75-90' : '90+';
  const tags = { feature: 'app-lab-import', outcome, duration, retry: retried ? 'yes' : 'no' };
  // A trace of its own, so the event cannot be joined to the request's transaction or exception.
  Sentry.startNewTrace(() => Sentry.withScope((scope) => {
    // Runs after the SDK's own processors, so it also drops their `runtime` tag.
    scope.addEventProcessor(({ request: _r, breadcrumbs: _b, user: _u, ...event }) => ({ ...event, tags }));
    Sentry.captureMessage('App lab import slow', { level: 'warning', fingerprint: ['app-lab-import', outcome] });
  }));
}
