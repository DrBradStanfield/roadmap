/**
 * The iPhone app's four routes (US-52, ios/architecture.md D8), as plain
 * handlers. The route files under app/routes/api.app.v1.* only call these: a
 * route module's extra exports would pull server code into the client build.
 */
import { labImportRequestSchema } from '../../packages/health-core/src/validation';
import { action as webChatAction } from '../routes/api.chat';
import { attestConfig, AttestError, challengeValid, newChallenge, validKeyId, verifyAttestation } from './app-attest.server';
import { appGate, appLimits, appRoutesOff, ipBucket, supabaseKeyStore, type KeyStore } from './app-gate.server';
import { SMALL_BODY_CAP } from './capped-body.server';
import { extractOneFile } from './lab-extract-one.server';
import { BODY_TOO_LARGE, getClientIp, parseSimpleRequestJson } from './local-first-route.server';
import { machineFiles } from './rate-limiter';

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
  if (!appLimits.register.take(ipBucket(getClientIp(request, 'fly')), 1)) return registerRefused(429, 'limit');

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
  try {
    if ((await store.insert(key)) === 'exists') return registerRefused(409, 'key_exists');
  } catch {
    return registerRefused(503, 'store_unavailable');
  }
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

/** POST lab-import: the gate, then the web's single-file extraction; proposed values back, nothing stored (AC7). */
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
  // The web's and the connector's dollar ceiling, spent here too (AC4).
  if (!machineFiles.take('machine', 1)) {
    return json(429, { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.', reason: 'limit' });
  }
  return extractOneFile(validation.data);
}
