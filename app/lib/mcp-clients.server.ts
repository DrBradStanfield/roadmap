/**
 * Who is allowed to ask: pinned vendor clients, CIMD, and DCR as the fallback
 * (US-32, design §2/§4).
 *
 * NOTHING HERE MAY LOG A URL.
 */
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import { clientHmacKey } from './mcp-config.server';
import { b64url } from './mcp-seal.server';

/**
 * Which assistant is calling, as a closed enum. Free text in a counter is how
 * a counter becomes a log, and a DCR client's name is attacker-chosen text —
 * so only a pinned client gets a label, and everything else is 'other'.
 */
export const MCP_CLIENT_LABELS = ['claude', 'claude_code', 'chatgpt', 'other'] as const;

export type McpClientLabel = (typeof MCP_CLIENT_LABELS)[number];

export interface McpClient {
  clientId: string;
  name: string;
  readonly redirectUris: readonly string[];
}

/** A pinned client, which alone carries a counter label. */
interface KnownClient extends McpClient {
  label: McpClientLabel;
}

/**
 * The only redirect targets we will send a user's browser to with an
 * authorization code. Client metadata is written by the client, so it can
 * claim any redirect it likes; this list is what actually decides.
 *
 * Loopback is the second entry route, per RFC 8252 §7.3: a command-line client
 * has no callback host of its own, so it listens on an ephemeral port on the
 * user's own machine. Enabled 2026-09-02 so Claude Code and Gemini CLI can
 * connect. It is not the CORS allow-list — nothing here grants a browser
 * origin anything — and the code that reaches such a URL is worthless without
 * the PKCE verifier, which never left the process that asked.
 */
const ALLOWED_REDIRECTS = [
  'https://claude.ai/api/mcp/auth_callback',
  'https://chatgpt.com/connector_platform_oauth_redirect',
  'https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback',
];

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Parse a redirect that may only be reached over loopback. `http:` is allowed
 * ONLY here, and the host is matched exactly — `localhost.evil.test` and
 * `127.0.0.1.evil.test` are ordinary public names and get nothing. Userinfo
 * and a fragment are refused outright: both are ways to make one URL read as
 * another.
 */
function parseLoopback(uri: string): URL | null {
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  if (url.username || url.password || url.hash) return null;
  return LOOPBACK_HOSTS.has(url.hostname) ? url : null;
}

/** RFC 8252 §7.3 — a loopback redirect matches on everything but the port. */
export function isLoopbackRedirect(uri: string): boolean {
  return parseLoopback(uri) !== null;
}

/**
 * The one comparison for "is this the redirect the client registered?" — used
 * at `/authorize`, at `/token`, and nowhere else. Exact string first; a
 * loopback pair may then differ in the port and in NOTHING else, because the
 * port is the one part the client cannot know until it binds.
 */
export function redirectMatches(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const a = parseLoopback(registered);
  const b = parseLoopback(requested);
  if (!a || !b) return false;
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

export function isAllowedRedirect(uri: string): boolean {
  return ALLOWED_REDIRECTS.includes(uri) || isLoopbackRedirect(uri);
}

/**
 * The canonical vendor clients, consulted BEFORE any network fetch.
 *
 * 2026-09-02: `https://claude.ai/oauth/mcp-oauth-client-metadata` answers a
 * datacenter fetch with a Cloudflare managed challenge — 403, `text/html`,
 * `cf-mitigated: challenge` — reproduced from inside the Fly machine, with and
 * without a browser User-Agent. The document is unfetchable from where we run,
 * so every Claude connection died at "We do not recognise the app".
 * `https://chatgpt.com/oauth/client.json` fetches fine today, and is the same
 * class of risk tomorrow.
 *
 * Pre-registration keyed by the client-id metadata document URL is one of the
 * spec's own sanctioned mechanisms: IETF draft-ietf-oauth-client-id-metadata-
 * document-00 §4 says a server SHOULD fetch the document and MAY apply its own
 * policy about which clients it accepts. This IS that policy. The redirect URIs
 * here are copied verbatim from the vendors' published documents, and every one
 * must pass `isAllowedRedirect` — a test asserts that, so the pins and the
 * policy cannot drift apart.
 *
 * Claude Code publishes a SECOND document, `claude-code-client-metadata`,
 * behind the same challenge. Its redirects are loopback: the port belongs to
 * the CLI and is not known until it binds one (RFC 8252 §7.3).
 */
export const KNOWN_CLIENTS: ReadonlyMap<string, Readonly<KnownClient>> = new Map([
  [
    'https://claude.ai/oauth/mcp-oauth-client-metadata',
    {
      clientId: 'https://claude.ai/oauth/mcp-oauth-client-metadata',
      name: 'Claude',
      label: 'claude',
      redirectUris: Object.freeze(['https://claude.ai/api/mcp/auth_callback']),
    },
  ],
  [
    'https://claude.ai/oauth/claude-code-client-metadata',
    {
      clientId: 'https://claude.ai/oauth/claude-code-client-metadata',
      name: 'Claude Code',
      label: 'claude_code',
      redirectUris: Object.freeze(['http://localhost/callback', 'http://127.0.0.1/callback']),
    },
  ],
  [
    'https://chatgpt.com/oauth/client.json',
    {
      clientId: 'https://chatgpt.com/oauth/client.json',
      name: 'ChatGPT',
      label: 'chatgpt',
      redirectUris: Object.freeze(['https://chatgpt.com/connector_platform_oauth_redirect']),
    },
  ],
]);

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

async function fetchClientMetadata(clientId: string, nowMs = Date.now()): Promise<McpClient | null> {
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
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  // A MUST in draft-ietf-oauth-client-id-metadata-document-00 §4: the document
  // has to claim the very URL we fetched it from, or a client could point us at
  // someone else's metadata and inherit their identity.
  if (doc?.client_id !== clientId) return null;
  const metadata = canonicalMetadata(doc);
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
 * Read at most `cap` bytes of a request or a response body, or throw. A
 * `content-length` is the sender's claim, so it is checked where it exists but
 * never believed — a chunked body has none at all.
 */
export async function readCapped(source: { body: ReadableStream<Uint8Array> | null }, cap: number): Promise<string> {
  const reader = source.body?.getReader();
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
 * Resolve whatever the client called itself. A `c.` prefix is our own
 * self-contained DCR id; a pinned URL is answered from KNOWN_CLIENTS without
 * touching the network; any other URL is a CIMD document we fetch. Nothing
 * else is a client.
 */
export async function resolveClient(clientId: string, nowMs = Date.now()): Promise<McpClient | null> {
  if (!clientId || clientId.length > 4096) return null;
  if (clientId.startsWith('c.')) return verifySelfContainedClient(clientId);
  // Exact string only: a lookalike id falls through to the fetch path below.
  const known = KNOWN_CLIENTS.get(clientId);
  if (known) return known;
  if (clientId.startsWith('https://')) return fetchClientMetadata(clientId, nowMs);
  return null;
}

/** Test seam — the CIMD cache is process-global. */
export function resetCimdCache(): void {
  cimdCache.clear();
}
