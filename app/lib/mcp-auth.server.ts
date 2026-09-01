/**
 * The hosted MCP server's authorization server, with no storage anywhere
 * (US-32, design §4).
 *
 * We are the OAuth 2.1 authorization server for `https://mcp.drstanfield.com`.
 * An IdP would mean user accounts, which this product does not have; the
 * identity we actually need is "the person who can authorize this Dropbox
 * folder", and Dropbox proves that for us. So every piece of state an OAuth
 * server normally keeps in a table — the `state`, the authorization code, the
 * access token, the refresh token — is instead SEALED into the value we hand
 * the client. We hold the key and no blob; the AI vendor holds a blob and no
 * key. Neither organisation alone can read a user's record.
 *
 * The provider refresh token lives inside the access and refresh blobs. That
 * is the sharp edge of the design and it is stated plainly in §4: a leaked
 * `MCP_SEAL_KEYS` opens every blob ever issued, including expired ones, so
 * no-overlap rotation is the standing incident response.
 *
 * NOTHING HERE MAY LOG A URL. OAuth secrets travel in query strings; the
 * scrubber (`sentry-scrub.ts`) is a backstop, not a licence.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { createRateLimiter } from './rate-limiter';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The whole feature's on switch. Unset (the state of production until Brad
 * sets the Fly secret) and every `/mcp` route 404s, so this code can ship
 * inert and be turned on by adding a secret rather than by deploying again.
 */
export function isMcpEnabled(): boolean {
  return sealKeys().length > 0;
}

/** Public origin. The PRM `resource` must equal the URL a user types, exactly. */
export function issuer(): string {
  return process.env.MCP_ISSUER || 'https://mcp.drstanfield.com';
}

export function resourceUrl(): string {
  return `${issuer()}/mcp`;
}

function callbackUrl(): string {
  return `${issuer()}/mcp/callback`;
}

/**
 * `MCP_SEAL_KEYS` is an ordered, comma-separated list of base64 32-byte keys.
 * We seal with the FIRST and accept ANY, so rotation is one atomic
 * `fly secrets set` that prepends a key — there is no window in which a machine
 * holds half a view of the key set.
 *
 * `kid` is a FINGERPRINT of the key, not its index. The design says "index",
 * and index cannot survive the rotation the same paragraph prescribes:
 * prepending a key renumbers every key, so every blob already issued would
 * decrypt under the wrong one. A fingerprint names the key itself, so prepend
 * and append both work and "accept any" stays literally true.
 */
function sealKeys(): Buffer[] {
  const raw = process.env.MCP_SEAL_KEYS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const key = Buffer.from(part, 'base64');
      if (key.length !== 32) throw new Error('MCP_SEAL_KEYS holds a key that is not 32 bytes');
      return key;
    });
}

// ---------------------------------------------------------------------------
// Seal / unseal
// ---------------------------------------------------------------------------

export type BlobType = 'state' | 'code' | 'access' | 'refresh';

/**
 * Fixed-length buckets for the padded plaintext. Without padding the blob's
 * length leaks which provider and roughly which credential is inside. The
 * design names four buckets; the 4096 rung is here so an unusually long
 * provider refresh token fails to leak rather than failing to work.
 */
const BUCKETS = [256, 512, 1024, 2048, 4096];

/** HKDF-SHA256 per blob type, so a `state` blob can never be read as an `access`. */
function typeKey(key: Buffer, typ: BlobType): Buffer {
  return Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), `mcp/${typ}/v1`, 32));
}

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('base64url');
}

/** Names one seal key without revealing it. Public — it rides in the header. */
function fingerprint(key: Buffer): string {
  return crypto.createHash('sha256').update(key).digest('base64url').slice(0, 11);
}

/**
 * The blob's cleartext header, and its own AAD. It carries `kid` (which key),
 * `typ` (which HKDF context) and the HASHES of the client id and the resource
 * — hashes, not the values, because the header is public and the client id
 * does not need to be. Authenticating it as AAD is what binds one blob to one
 * client and one audience: present an access blob to a different client and
 * the tag check fails before any plaintext exists.
 */
interface SealHeader {
  k: string;
  t: BlobType;
  c: string;
  r: string;
}

function padToBucket(plaintext: Buffer): Buffer {
  const framed = Buffer.concat([Buffer.alloc(4), plaintext]);
  framed.writeUInt32BE(plaintext.length, 0);
  const size = BUCKETS.find((bucket) => bucket >= framed.length);
  if (!size) throw new Error('Sealed payload is too large');
  return Buffer.concat([framed, Buffer.alloc(size - framed.length)]);
}

function unpad(padded: Buffer): Buffer {
  const length = padded.readUInt32BE(0);
  if (length > padded.length - 4) throw new Error('Sealed payload is malformed');
  return padded.subarray(4, 4 + length);
}

export interface SealAudience {
  clientId: string;
  resource: string;
}

/**
 * Seal a payload. The wire form is `base64url(header) + "." +
 * base64url(nonce ‖ ciphertext ‖ tag)` — the header must travel in the clear
 * because unsealing has to know which key and which context to try, and it is
 * authenticated rather than trusted.
 */
export function seal(typ: BlobType, payload: unknown, audience: SealAudience): string {
  const keys = sealKeys();
  if (keys.length === 0) throw new Error('MCP_SEAL_KEYS is not configured');
  const header: SealHeader = { k: fingerprint(keys[0]), t: typ, c: hash(audience.clientId), r: hash(audience.resource) };
  const aad = Buffer.from(JSON.stringify(header), 'utf8');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', typeKey(keys[0], typ), nonce, { authTagLength: 16 });
  cipher.setAAD(aad);
  const body = Buffer.concat([
    cipher.update(padToBucket(Buffer.from(JSON.stringify(payload), 'utf8'))),
    cipher.final(),
  ]);
  return `${b64url(aad)}.${b64url(Buffer.concat([nonce, body, cipher.getAuthTag()]))}`;
}

/**
 * Unseal, or return null. Every failure — a bad tag, the wrong type, another
 * client, an unknown key, a rotated-away key — is one `null`, because telling
 * an attacker which check failed is telling them how to pass it.
 *
 * `exp` is checked here and nowhere else, which is the honest position: it is
 * OUR expiry, advisory, enforced only by this function. Anyone holding the
 * seal key can read an "expired" blob.
 */
export function unseal<T>(typ: BlobType, token: string, audience: SealAudience, nowMs = Date.now()): T | null {
  const [headerPart, bodyPart, ...rest] = token.split('.');
  if (!headerPart || !bodyPart || rest.length > 0) return null;
  let header: SealHeader;
  let aad: Buffer;
  try {
    aad = Buffer.from(headerPart, 'base64url');
    header = JSON.parse(aad.toString('utf8')) as SealHeader;
  } catch {
    return null;
  }
  if (header.t !== typ) return null;
  if (header.c !== hash(audience.clientId) || header.r !== hash(audience.resource)) return null;
  const key = sealKeys().find((candidate) => fingerprint(candidate) === header.k);
  if (!key) return null;

  const raw = Buffer.from(bodyPart, 'base64url');
  if (raw.length < 12 + 16) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', typeKey(key, typ), raw.subarray(0, 12), {
      authTagLength: 16,
    });
    decipher.setAAD(aad);
    decipher.setAuthTag(raw.subarray(raw.length - 16));
    const padded = Buffer.concat([decipher.update(raw.subarray(12, raw.length - 16)), decipher.final()]);
    const payload = JSON.parse(unpad(padded).toString('utf8')) as T & { exp?: number };
    if (typeof payload.exp === 'number' && payload.exp * 1000 <= nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Every value we hand out carries its client id in front, base64url, before a
 * `~`: `<client id>~<sealed blob>`.
 *
 * The AAD binds a blob to one client, and unsealing therefore has to know
 * which client — but a bearer token arrives alone, and Dropbox echoes exactly
 * one opaque `state`. So the id travels with the blob. It is not trusted: it
 * feeds the AAD, so changing it makes the GCM tag fail and the blob will not
 * open. Where the request states the client independently — `/token`, which
 * takes `client_id` in the form body — the route compares the two, and that
 * comparison is a real check rather than a carried claim. On `/mcp` there is
 * nothing to compare against, so the binding is only carried: a stolen bearer
 * token is a stolen bearer token, and no framing fixes that.
 */
export function packSealed(typ: BlobType, clientId: string, payload: unknown): string {
  const sealed = seal(typ, payload, { clientId, resource: resourceUrl() });
  return `${b64url(Buffer.from(clientId, 'utf8'))}~${sealed}`;
}

export function unpackSealed<T extends { clientId: string }>(
  typ: BlobType,
  token: string,
  nowMs = Date.now(),
): T | null {
  const at = token.indexOf('~');
  if (at <= 0 || token.length > 16384) return null;
  let clientId: string;
  try {
    clientId = Buffer.from(token.slice(0, at), 'base64url').toString('utf8');
  } catch {
    return null;
  }
  const payload = unseal<T>(typ, token.slice(at + 1), { clientId, resource: resourceUrl() }, nowMs);
  // The AAD already proves this; the explicit check keeps the invariant
  // readable at every call site that depends on it.
  return payload && payload.clientId === clientId ? payload : null;
}

// ---------------------------------------------------------------------------
// Blob payloads
// ---------------------------------------------------------------------------

export const CODE_LIFETIME_SECONDS = 60;
export const ACCESS_LIFETIME_SECONDS = 60 * 60;
export const REFRESH_LIFETIME_SECONDS = 90 * 24 * 60 * 60;
const STATE_LIFETIME_SECONDS = 10 * 60;

/**
 * Weighted write budget (design §3, mitigation 4). `PER_ACCESS_WRITES` is what
 * one hour-long access token may spend; `CONNECTION_WRITES` is the whole
 * connection's pool, carried in the refresh blob and spent by refreshing —
 * the only durable quota statelessness allows, because a blob already in a
 * vendor's hands can never be updated by us.
 *
 * A correction costs five adds. The silent-falsification attack needs one
 * correction per metric, so weighting corrections is what actually bounds it,
 * while a real session adds in batches (a lab panel is ONE add of many rows)
 * and corrects a handful of times.
 */
export const PER_ACCESS_WRITES = 60;
export const CONNECTION_WRITES = 3000;
export const WRITE_COST = { add: 1, correct: 5 } as const;

export interface StatePayload {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  clientState: string;
  exp: number;
}

export interface CodePayload {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  /** The Dropbox refresh token. Never leaves a sealed blob. */
  rt: string;
  jti: string;
  exp: number;
}

export interface AccessPayload {
  clientId: string;
  rt: string;
  /** Weighted writes this access token may spend before it must refresh. */
  writes: number;
  jti: string;
  exp: number;
}

export interface RefreshPayload {
  clientId: string;
  rt: string;
  /** Weighted writes left in the whole connection's pool. */
  budget: number;
  exp: number;
}

function nowSeconds(nowMs: number): number {
  return Math.floor(nowMs / 1000);
}

/**
 * Mint the access/refresh pair a `/token` response carries. The access token
 * draws its allowance from the connection pool, so an attacker who wants more
 * writes per hour cannot get them: they must refresh, and refreshing drains
 * the pool that bounds the connection's whole 90 days.
 */
export function issueTokens(clientId: string, rt: string, budget: number, nowMs: number) {
  const granted = Math.min(PER_ACCESS_WRITES, Math.max(0, budget));
  const access: AccessPayload = {
    clientId,
    rt,
    writes: granted,
    jti: crypto.randomUUID(),
    exp: nowSeconds(nowMs) + ACCESS_LIFETIME_SECONDS,
  };
  const refresh: RefreshPayload = {
    clientId,
    rt,
    budget: Math.max(0, budget - granted),
    exp: nowSeconds(nowMs) + REFRESH_LIFETIME_SECONDS,
  };
  return {
    access_token: packSealed('access', clientId, access),
    refresh_token: packSealed('refresh', clientId, refresh),
    token_type: 'Bearer',
    // Honest, because Claude refreshes proactively five minutes before this.
    expires_in: ACCESS_LIFETIME_SECONDS,
    scope: 'health.read health.append',
  };
}

// ---------------------------------------------------------------------------
// Best-effort in-memory state — counted, not free (design §2)
// ---------------------------------------------------------------------------

/**
 * Authorization codes are single-use in OAuth 2.1 and statelessness cannot
 * enforce that. This set is per-machine and NOT authoritative: across Fly
 * machines a code could be redeemed twice inside its 60-second window.
 * Redemption still needs the PKCE `code_verifier`, which never leaves the
 * client, so a passive interceptor gains nothing. Documented in §4, not
 * papered over.
 */
const spentCodes = new Map<string, number>();

export function claimCode(jti: string, nowMs = Date.now()): boolean {
  for (const [id, at] of spentCodes) if (nowMs - at > CODE_LIFETIME_SECONDS * 1000) spentCodes.delete(id);
  if (spentCodes.has(jti)) return false;
  spentCodes.set(jti, nowMs);
  return true;
}

/**
 * Writes already spent under one access token, per machine. The durable bound
 * is the connection pool spent by refresh; this is the within-the-hour half,
 * and like the code set it is best-effort across machines.
 */
const spentWrites = new Map<string, { used: number; at: number }>();

export function spendWrites(jti: string, allowance: number, cost: number, nowMs = Date.now()): boolean {
  for (const [id, entry] of spentWrites) {
    if (nowMs - entry.at > ACCESS_LIFETIME_SECONDS * 1000) spentWrites.delete(id);
  }
  const entry = spentWrites.get(jti) ?? { used: 0, at: nowMs };
  if (entry.used + cost > allowance) return false;
  entry.used += cost;
  spentWrites.set(jti, entry);
  return true;
}

/** Test seam — the maps are process-global and would leak between cases. */
export function resetMcpMemory(): void {
  spentCodes.clear();
  spentWrites.clear();
  cimdCache.clear();
}

// ---------------------------------------------------------------------------
// Clients: CIMD, and DCR as the fallback
// ---------------------------------------------------------------------------

export interface McpClient {
  clientId: string;
  name: string;
  redirectUris: string[];
}

/**
 * The only redirect targets we will send a user's browser to with an
 * authorization code. Client metadata is written by the client, so it can
 * claim any redirect it likes; this list is what actually decides.
 *
 * RFC 8252 loopback is implemented below but OFF. CLAUDE.md's hard rule —
 * localhost is never on an allow-list — and design §4's "loopback with port
 * ignored" genuinely disagree, and the stricter reading is the one that ships.
 * A local client has the stdio server (US-32 Phase 0) and needs no OAuth.
 * Turning it on is this constant plus a redeploy.
 */
const ALLOWED_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback',
];
const ALLOW_LOOPBACK_REDIRECT = false;

/** RFC 8252 §7.3 — a loopback redirect matches on everything but the port. */
export function isLoopbackRedirect(uri: string): boolean {
  try {
    const url = new URL(uri);
    // `localhost` resolves through DNS and is explicitly not allowed anywhere
    // in this codebase; the literal addresses are the RFC's own form.
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1');
  } catch {
    return false;
  }
}

export function isAllowedRedirect(uri: string): boolean {
  if (ALLOWED_REDIRECTS.includes(uri)) return true;
  return ALLOW_LOOPBACK_REDIRECT && isLoopbackRedirect(uri);
}

/**
 * A DCR `client_id` that carries its own registration: `c.<metadata>.<HMAC>`.
 * RFC 7591 §3.2.1 permits a self-contained id, so there is no registry and no
 * row — the HMAC under `MCP_CLIENT_HMAC_KEY` is what makes the metadata ours.
 *
 * Rotating that key is USER-VISIBLE: Anthropic freezes a connector's auth
 * settings after it is added, so every affected user must remove and re-add
 * the connector. Rotate only with a comms plan (§2).
 */
function clientHmacKey(): Buffer {
  const raw = process.env.MCP_CLIENT_HMAC_KEY;
  if (!raw) throw new Error('MCP_CLIENT_HMAC_KEY is not configured');
  return Buffer.from(raw, 'base64');
}

interface ClientMetadata {
  client_name: string;
  redirect_uris: string[];
}

/** Only these fields survive registration, in this order, so the id is stable. */
function canonicalMetadata(input: unknown): ClientMetadata | null {
  if (!input || typeof input !== 'object') return null;
  const raw = input as Record<string, unknown>;
  const uris = Array.isArray(raw.redirect_uris) ? raw.redirect_uris : [];
  const redirect_uris = uris.filter((u): u is string => typeof u === 'string' && u.length <= 512).slice(0, 5);
  if (redirect_uris.length === 0) return null;
  if (!redirect_uris.every(isAllowedRedirect)) return null;
  const name = typeof raw.client_name === 'string' ? raw.client_name.slice(0, 120) : 'An AI assistant';
  return { client_name: name, redirect_uris };
}

export function registerClient(input: unknown): McpClient | null {
  const metadata = canonicalMetadata(input);
  if (!metadata) return null;
  const body = Buffer.from(JSON.stringify(metadata), 'utf8');
  const tag = crypto.createHmac('sha256', clientHmacKey()).update(body).digest();
  return {
    clientId: `c.${b64url(body)}.${b64url(tag)}`,
    name: metadata.client_name,
    redirectUris: metadata.redirect_uris,
  };
}

function verifySelfContainedClient(clientId: string): McpClient | null {
  const [prefix, bodyPart, tagPart, ...rest] = clientId.split('.');
  if (prefix !== 'c' || !bodyPart || !tagPart || rest.length > 0) return null;
  let body: Buffer;
  let tag: Buffer;
  try {
    body = Buffer.from(bodyPart, 'base64url');
    tag = Buffer.from(tagPart, 'base64url');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', clientHmacKey()).update(body).digest();
  if (tag.length !== expected.length || !crypto.timingSafeEqual(tag, expected)) return null;
  const metadata = canonicalMetadata(JSON.parse(body.toString('utf8')) as unknown);
  if (!metadata) return null;
  return { clientId, name: metadata.client_name, redirectUris: metadata.redirect_uris };
}

// --- CIMD ------------------------------------------------------------------

/** Bounded cache, 256 entries, oldest evicted first, TTL capped at an hour (design §2). */
const cimdCache = new Map<string, { client: McpClient; until: number }>();
const CIMD_CACHE_MAX = 256;
const CIMD_MAX_TTL_MS = 60 * 60 * 1000;

/**
 * Fetching a URL the caller chose is an SSRF gun pointed at Fly's internal
 * network, so the policy is mandatory and every clause below is load-bearing:
 * https only, every resolved address public, zero redirects, 5-second timeout,
 * 64 KB cap, `application/json` required, no credentials sent, and the result
 * into the bounded cache above.
 *
 * Residual, stated: `fetch` resolves DNS again after our check, so a rebinding
 * attacker has a window. §4 asks for the re-check at connect time and that is
 * what this is; pinning the connection to a checked address is not available
 * through `fetch`.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const records = await dns.lookup(hostname, { all: true });
  if (records.length === 0) throw new Error('unresolvable');
  for (const { address, family } of records) {
    if (!isPublicAddress(address, family)) throw new Error('non-public address');
  }
}

export function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local, and Fly's metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a >= 224) return false; // multicast + reserved
    return true;
  }
  const ip = address.toLowerCase();
  if (ip === '::' || ip === '::1') return false;
  if (ip.startsWith('fc') || ip.startsWith('fd')) return false; // unique-local
  if (ip.startsWith('fe80')) return false; // link-local
  if (ip.startsWith('::ffff:')) return isPublicAddress(ip.slice(7), 4); // v4-mapped
  return true;
}

export async function fetchClientMetadata(clientId: string, nowMs = Date.now()): Promise<McpClient | null> {
  const cached = cimdCache.get(clientId);
  if (cached && cached.until > nowMs) return cached.client;

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  try {
    await assertPublicHost(url.hostname);
  } catch {
    return null;
  }

  const abort = AbortSignal.timeout(5000);
  let res: Response;
  try {
    res = await fetch(url, {
      redirect: 'error',
      signal: abort,
      credentials: 'omit',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  if (!(res.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json')) return null;
  const length = Number(res.headers.get('content-length') ?? 0);
  if (length > 65536) return null;

  let text: string;
  try {
    text = await readCapped(res, 65536);
  } catch {
    return null;
  }
  let metadata: ClientMetadata | null;
  try {
    metadata = canonicalMetadata(JSON.parse(text) as unknown);
  } catch {
    return null;
  }
  if (!metadata) return null;

  const client: McpClient = { clientId, name: metadata.client_name, redirectUris: metadata.redirect_uris };
  const ttl = Math.min(cacheTtlMs(res.headers.get('cache-control')), CIMD_MAX_TTL_MS);
  if (cimdCache.size >= CIMD_CACHE_MAX) cimdCache.delete(cimdCache.keys().next().value as string);
  cimdCache.set(clientId, { client, until: nowMs + ttl });
  return client;
}

function cacheTtlMs(header: string | null): number {
  const match = /max-age=(\d+)/.exec(header ?? '');
  return match ? Number(match[1]) * 1000 : 5 * 60 * 1000;
}

/**
 * Read at most `cap` bytes. `content-length` is the server's claim, so it is
 * checked but never believed — a chunked response has none at all.
 */
async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      await reader.cancel();
      throw new Error('body too large');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf8');
}

/**
 * Resolve whatever the client called itself. A URL is a CIMD document; a `c.`
 * prefix is our own self-contained DCR id. Nothing else is a client.
 */
export async function resolveClient(clientId: string, nowMs = Date.now()): Promise<McpClient | null> {
  if (!clientId || clientId.length > 4096) return null;
  if (clientId.startsWith('c.')) return verifySelfContainedClient(clientId);
  if (clientId.startsWith('https://')) return fetchClientMetadata(clientId, nowMs);
  return null;
}

// ---------------------------------------------------------------------------
// Authorize
// ---------------------------------------------------------------------------

/** Per-IP, before any CIMD fetch — the fetch is the expensive, abusable half. */
export const allowAuthorize = createRateLimiter(20, 60_000, 10 * 60_000);

export interface AuthorizeRequest {
  client: McpClient;
  redirectUri: string;
  codeChallenge: string;
  clientState: string;
}

export type AuthorizeCheck =
  | { ok: true; request: AuthorizeRequest }
  | { ok: false; error: string; description: string; redirectable: boolean };

/**
 * Validate an `/authorize` query. A fault in `redirect_uri` or `client_id` can
 * NEVER be reported by redirecting — that would make us an open redirector —
 * so `redirectable` tells the route which errors may go back to the client and
 * which must be rendered here.
 */
export function checkAuthorize(params: URLSearchParams, client: McpClient): AuthorizeCheck {
  const redirectUri = params.get('redirect_uri') ?? '';
  if (!client.redirectUris.includes(redirectUri) || !isAllowedRedirect(redirectUri)) {
    return { ok: false, error: 'invalid_request', description: 'Unknown redirect_uri', redirectable: false };
  }
  const fail = (error: string, description: string): AuthorizeCheck =>
    ({ ok: false, error, description, redirectable: true });

  if (params.get('response_type') !== 'code') return fail('unsupported_response_type', 'Only response_type=code');
  if (params.get('code_challenge_method') !== 'S256') return fail('invalid_request', 'PKCE S256 is required');
  const codeChallenge = params.get('code_challenge') ?? '';
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeChallenge)) return fail('invalid_request', 'Malformed code_challenge');
  // RFC 8707. The audience must be this server, or a token we mint here could
  // be replayed somewhere else — the confused-deputy the MCP spec warns about.
  const resource = params.get('resource');
  if (resource !== null && resource !== resourceUrl()) {
    return fail('invalid_target', 'This server is not that resource');
  }
  return {
    ok: true,
    request: {
      client,
      redirectUri,
      codeChallenge,
      clientState: (params.get('state') ?? '').slice(0, 512),
    },
  };
}

export function sealState(request: AuthorizeRequest, nowMs: number): string {
  const payload: StatePayload = {
    clientId: request.client.clientId,
    redirectUri: request.redirectUri,
    codeChallenge: request.codeChallenge,
    clientState: request.clientState,
    exp: nowSeconds(nowMs) + STATE_LIFETIME_SECONDS,
  };
  return packSealed('state', request.client.clientId, payload);
}

// ---------------------------------------------------------------------------
// Dropbox, as a confidential client
// ---------------------------------------------------------------------------

const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';

/** Scopes: read and write the app folder, and nothing else. */
const DROPBOX_SCOPES = 'files.content.read files.content.write files.metadata.read';

export function dropboxConfigured(): boolean {
  return Boolean(process.env.DROPBOX_APP_KEY && process.env.DROPBOX_APP_SECRET);
}

export function dropboxAuthorizeUrl(state: string): string {
  const url = new URL(DROPBOX_AUTHORIZE_URL);
  url.searchParams.set('client_id', process.env.DROPBOX_APP_KEY ?? '');
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', callbackUrl());
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('scope', DROPBOX_SCOPES);
  url.searchParams.set('state', state);
  return url.toString();
}

async function dropboxToken(body: URLSearchParams): Promise<Record<string, unknown> | null> {
  body.set('client_id', process.env.DROPBOX_APP_KEY ?? '');
  body.set('client_secret', process.env.DROPBOX_APP_SECRET ?? '');
  const res = await fetch(DROPBOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) return null;
  return (await res.json().catch(() => null)) as Record<string, unknown> | null;
}

/** Exchange Dropbox's authorization code for the refresh token we will seal. */
export async function dropboxExchange(code: string): Promise<string | null> {
  const json = await dropboxToken(
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: callbackUrl() }),
  );
  const refresh = json?.refresh_token;
  return typeof refresh === 'string' && refresh.length > 0 ? refresh : null;
}

/**
 * A short-lived Dropbox access token for ONE tool call. Neither Dropbox nor
 * Google rotates refresh tokens on refresh (verified 2026-09-01) — the whole
 * design rests on that, because we hold no row we could update if they did.
 */
export async function dropboxAccessToken(refreshToken: string): Promise<string | null> {
  const json = await dropboxToken(new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }));
  const access = json?.access_token;
  return typeof access === 'string' && access.length > 0 ? access : null;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

export function verifyPkce(codeVerifier: string, challenge: string): boolean {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(codeVerifier)) return false;
  const derived = crypto.createHash('sha256').update(codeVerifier, 'ascii').digest('base64url');
  const a = Buffer.from(derived);
  const b = Buffer.from(challenge);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
