/**
 * Who is allowed to ask: pinned vendor clients, CIMD, and DCR as the fallback
 * (US-32, design §2/§4).
 *
 * NOTHING HERE MAY LOG A URL.
 */
import crypto from 'node:crypto';
import dns from 'node:dns';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { pipeline, type Transform } from 'node:stream';
import zlib from 'node:zlib';
import type { McpOAuthDetail } from '../../packages/health-core/src/product-events';
import { clientHmacKey } from './mcp-config.server';
import { b64url } from './mcp-seal.server';

/**
 * Which assistant is calling, as a closed enum. Free text in a counter is how
 * a counter becomes a log, and a DCR client's name is attacker-chosen text —
 * so only a pinned client gets a label, and everything else is 'other'.
 */
export const MCP_CLIENT_LABELS = ['claude', 'claude_code', 'chatgpt', 'codex', 'other'] as const;

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
export const ALLOWED_REDIRECTS = [
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

/** Which way a refused redirect missed, as the counter's closed word (US-32 AC48). Never the URL. */
export function redirectMiss(registered: readonly string[], requested: string): McpOAuthDetail<'redirect-uri'> {
  if (!requested) return 'missing';
  if (registered.some((r) => redirectMatches(r, requested))) return 'not-allowed';
  const host = (uri: string) => URL.canParse(uri) ? new URL(uri).hostname : null;
  const asked = host(requested);
  if (!asked || !registered.some((r) => host(r) === asked)) return 'unknown-host';
  return isLoopbackRedirect(requested) ? 'loopback-other-path' : 'known-host-other-path';
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
 * here are the vendors' published redirects PLUS any path we have observed one
 * of them actually use (see ChatGPT below), and every one must pass
 * `isAllowedRedirect` — a test asserts that, so the pins and the policy cannot
 * drift apart — in BOTH directions since 2026-09-16: an allow-listed redirect
 * on a pinned vendor's host that its pin omits is unreachable by that vendor,
 * which is how ChatGPT spent two weeks getting a dead window.
 *
 * Claude Code publishes a SECOND document, `claude-code-client-metadata`,
 * behind the same challenge. Its redirects are loopback: the port belongs to
 * the CLI and is not known until it binds one (RFC 8252 §7.3). Codex, OpenAI's
 * command-line agent, publishes a third — `chatgpt.com/oauth/codex/client.json`,
 * loopback for the same reason. It fetches today; pinning it buys the same two
 * things as the others, a counter label of its own and immunity to the day
 * Cloudflare decides our datacenter is a bot.
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
      // Two callbacks, and only the first is in OpenAI's published document.
      // The second is the Connectors ("links") flow: it has been in
      // ALLOWED_REDIRECTS since the hosted server shipped (548c1c5), so the
      // policy already trusted it — but the pin did not carry it, and a pinned
      // client is refused any redirect its own entry omits. That combination
      // answers `/authorize` with a NON-redirectable 400: ChatGPT gets a dead
      // window rather than an error it can show the user. Observed in
      // production 2026-09-15. Pinned rather than dropped because the pin is
      // our record of what a vendor USES, not a mirror of what it publishes —
      // which is the whole reason pinning exists (Cloudflare, above).
      redirectUris: Object.freeze([
        'https://chatgpt.com/connector_platform_oauth_redirect',
        'https://chatgpt.com/backend-api/aip/connectors/links/oauth/callback',
      ]),
    },
  ],
  [
    'https://chatgpt.com/oauth/codex/client.json',
    {
      clientId: 'https://chatgpt.com/oauth/codex/client.json',
      name: 'Codex',
      label: 'codex',
      redirectUris: Object.freeze(['http://127.0.0.1/callback', 'http://localhost/callback']),
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
 * https only, every resolved address public, none of the ports `fetch` refused,
 * zero redirects, one 5-second deadline over the whole request, 64 KB cap on
 * the decoded body, `application/json` required, no credentials sent, and the
 * result into the bounded cache above.
 *
 * The address check runs where the socket is opened (US-32 AC47): Node calls
 * this lookup for the connection, every address in the answer must be public,
 * and the socket can only go to an address in that answer. There is no second
 * resolution for a rebinding resolver to answer differently. Node calls no
 * lookup for an IP-literal host, so `fetchClientMetadata` checks those itself.
 */
const lookupPublic: LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, records) => {
    if (err) return callback(err, '');
    if (records.length === 0) return callback(new Error('unresolvable'), '');
    if (!records.every(({ address, family }) => isPublicAddress(address, family))) {
      return callback(new Error('non-public address'), '');
    }
    if (options.all) return callback(null, records);
    callback(null, records[0].address, records[0].family);
  });
};

/**
 * No TLS session cache: Node keys a cached session by server name, not
 * address, so a ticket an attacker's server issued could ride a later
 * connection to an internal ip:port ("TLS poison"). No keep-alive either.
 */
const CIMD_AGENT = new https.Agent({ maxCachedSessions: 0 });

/** The WHATWG fetch "bad port" list, which `fetch` refused before connecting, plus port 0, which no host serves. */
const BAD_PORTS = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109,
  110, 111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530,
  531, 532, 540, 548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045,
  4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
].map(String));

/** One content coding each, decoded strictly (zlib-wrapped deflate, no truncated or stacked codings); any other is refused. A Map, so no inherited key is a decoder. */
const DECODERS = new Map<string, (() => Transform) | null>([
  ['', null], ['identity', null], ['gzip', zlib.createGunzip], ['x-gzip', zlib.createGunzip],
  ['deflate', zlib.createInflate], ['br', zlib.createBrotliDecompress],
]);

/**
 * Refuses a non-public address in the spellings this check parses, not only the
 * compressed mapped form. A public mapped address stays allowed, including a
 * hex spelling the old remainder check refused. Unparseable input is not
 * public.
 */
export function isPublicAddress(address: string, family: number): boolean {
  // Node's own parser first: an address it does not read as exactly this family
  // (empty, padded, hex or leading-zero octets) is not public (US-32 AC45).
  if (isIP(address) !== family) return false;
  if (family === 4) {
    const parts = address.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
    const [a, b, c] = parts;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false; // link-local, and Fly's metadata
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return false; // IETF protocol assignments, TEST-NET-1
    if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
    if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
    if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
    if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
    if (a >= 224) return false; // multicast + reserved, 240.0.0.0/4 included
    return true;
  }
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string): boolean {
  return isPublicAddress(address, 4);
}

function ipv4Groups(dotted: string): [number, number] | null {
  const parts = dotted.split('.');
  if (parts.length !== 4) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return [(nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]];
}

function parseIpv6(address: string): number[] | null {
  const ip = address.toLowerCase();
  if (ip.includes('%') || ip.includes('/')) return null;
  const halves = ip.split('::');
  if (halves.length > 2) return null;
  const parseSide = (side: string): number[] | null => {
    if (side === '') return [];
    const bits = side.split(':');
    const groups: number[] = [];
    for (let i = 0; i < bits.length; i++) {
      const bit = bits[i];
      if (bit.includes('.')) {
        if (i !== bits.length - 1) return null;
        const pair = ipv4Groups(bit);
        if (!pair) return null;
        groups.push(pair[0], pair[1]);
      } else if (!/^[0-9a-f]{1,4}$/.test(bit)) {
        return null;
      } else {
        groups.push(parseInt(bit, 16));
      }
    }
    return groups;
  };
  const head = parseSide(halves[0]);
  if (!head) return null;
  if (halves.length === 1) return head.length === 8 ? head : null;
  const tail = parseSide(halves[1]);
  if (!tail) return null;
  const missing = 8 - head.length - tail.length;
  if (missing < 1) return null;
  return [...head, ...Array(missing).fill(0), ...tail];
}

function isPublicIpv6(address: string): boolean {
  const groups = parseIpv6(address);
  if (!groups) return false;
  const lastIpv4 = [groups[6] >> 8, groups[6] & 0xff, groups[7] >> 8, groups[7] & 0xff].join('.');
  // Well-known NAT64, 64:ff9b::/96 (RFC 6052): judge the IPv4 it carries. The rest
  // of 64:ff9b::/32, local-use 64:ff9b:1::/48 included, stays refused.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
    return groups.slice(2, 6).every((group) => group === 0) && isPublicIpv4(lastIpv4);
  }
  // IPv4-mapped (::ffff:0:0/96) and IPv4-compatible (::/96): judge the IPv4 they
  // carry. `::` and `::1` carry 0.0.0.0 and 0.0.0.1, which are not public.
  const mapped = groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff;
  if (mapped || groups.slice(0, 6).every((group) => group === 0)) return isPublicIpv4(lastIpv4);
  // Anything else must be global unicast, 2000::/3 (US-32 AC47). That refuses
  // unique-local, link-local, site-local, multicast, IPv4-translated and every
  // other special block outside it without a list; these are the ones inside.
  if ((groups[0] & 0xe000) !== 0x2000) return false;
  if (groups[0] === 0x2001 && groups[1] < 0x0200) return false; // 2001::/23: Teredo, benchmarking, ORCHID
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return false; // documentation
  if (groups[0] === 0x2002) return false; // 6to4
  if (groups[0] === 0x3fff && groups[1] < 0x1000) return false; // documentation, 3fff::/20
  return true;
}

async function fetchClientMetadata(clientId: string, nowMs: number, miss: ClientMiss): Promise<McpClient | null> {
  const cached = cimdCache.get(clientId);
  if (cached && cached.until > nowMs) return cached.client;
  const refuse = (detail: ClientMiss['detail']) => {
    miss.detail = detail;
    return null;
  };

  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return refuse('cimd-refused-url');
  }
  // `node:https` would send userinfo as an Authorization header.
  if (url.protocol !== 'https:' || url.username || url.password || BAD_PORTS.has(url.port)) return refuse('cimd-refused-url');
  const literal = url.hostname.replace(/^\[(.*)\]$/, '$1');
  if (isIP(literal) && !isPublicAddress(literal, isIP(literal))) return refuse('cimd-refused-url');

  const fetched = await getCimdDocument(url).catch(() => null);
  if (!fetched) return refuse('cimd-fetch-failed');
  const { text, cacheControl } = fetched;
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return refuse('cimd-invalid');
  }
  // A MUST in draft-ietf-oauth-client-id-metadata-document-00 §4: the document
  // has to claim the very URL we fetched it from, or a client could point us at
  // someone else's metadata and inherit their identity.
  if (doc?.client_id !== clientId) return refuse('cimd-invalid');
  const metadata = canonicalMetadata(doc);
  if (!metadata) return refuse(Array.isArray(doc.redirect_uris) && doc.redirect_uris.length ? 'cimd-redirect-refused' : 'cimd-invalid');

  const client: McpClient = { clientId, name: metadata.client_name, redirectUris: metadata.redirect_uris };
  const ttl = Math.min(cacheTtlMs(cacheControl), CIMD_MAX_TTL_MS);
  if (cimdCache.size >= CIMD_CACHE_MAX) cimdCache.delete(cimdCache.keys().next().value as string);
  cimdCache.set(clientId, { client, until: nowMs + ttl });
  return client;
}

/**
 * One GET, never followed: a 3xx is refused like any other non-2xx. The
 * deadline covers the body read and its decoding too, and the cap counts
 * decoded bytes, so a decompression bomb stops at 64 KB. Accept, Accept-Encoding
 * and the user-agent (`node`) are the ones `fetch` sent; its accept-language
 * and sec-fetch-mode are not, and the connection closes rather than keeps alive.
 */
function getCimdDocument(url: URL): Promise<{ text: string; cacheControl: string | null } | null> {
  return new Promise((resolve) => {
    const settle = (result: { text: string; cacheControl: string | null } | null) => {
      clearTimeout(deadline);
      req.destroy();
      resolve(result);
    };
    const req = https.request(url, {
      agent: CIMD_AGENT,
      lookup: lookupPublic,
      headers: { Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'node' },
    }, (res) => {
      const status = res.statusCode ?? 0;
      const type = (res.headers['content-type'] ?? '').toLowerCase();
      const decode = DECODERS.get((res.headers['content-encoding'] ?? '').trim().toLowerCase());
      if (status < 200 || status > 299 || !type.startsWith('application/json') || decode === undefined
        || Number(res.headers['content-length'] ?? 0) > 65536) {
        res.destroy();
        return settle(null);
      }
      const cacheControl = res.headers['cache-control'] ?? null;
      const body = decode ? pipeline(res, decode(), () => {}) : res;
      readCapped(body, 65536).then((text) => settle({ text, cacheControl }), () => settle(null));
    });
    const deadline = setTimeout(() => settle(null), 5000);
    req.on('error', () => settle(null));
    req.end();
  });
}

function cacheTtlMs(header: string | null): number {
  const match = /max-age=(\d+)/.exec(header ?? '');
  return match ? Number(match[1]) * 1000 : 5 * 60 * 1000;
}

/**
 * Read at most `cap` bytes of a request or a response body, or throw. A
 * `content-length` is the sender's claim, so it is checked where it exists but
 * never believed — a chunked body has none at all. Takes a web `Request` or
 * `Response`, or a Node stream such as an `IncomingMessage`.
 */
export async function readCapped(
  source: { body: ReadableStream<Uint8Array> | null } | AsyncIterable<Uint8Array>,
  cap: number,
): Promise<string> {
  // A web stream is async-iterable in Node; the DOM types just do not say so.
  const chunks = 'body' in source ? (source.body as unknown as AsyncIterable<Uint8Array> | null) : source;
  if (!chunks) return '';
  const read: Uint8Array[] = [];
  let size = 0;
  // Leaving the loop early (the throw) cancels a web stream and destroys a Node one.
  for await (const chunk of chunks) {
    size += chunk.byteLength;
    if (size > cap) throw new Error('body too large');
    read.push(chunk);
  }
  return Buffer.concat(read).toString('utf8');
}

/**
 * Resolve whatever the client called itself. A `c.` prefix is our own
 * self-contained DCR id; a pinned URL is answered from KNOWN_CLIENTS without
 * touching the network; any other URL is a CIMD document we fetch. Nothing
 * else is a client.
 */
export async function resolveClient(clientId: string, nowMs = Date.now(), miss: ClientMiss = {}): Promise<McpClient | null> {
  miss.detail = 'malformed';
  if (!clientId || clientId.length > 4096) return null;
  if (clientId.startsWith('c.')) {
    miss.detail = 'dcr-invalid';
    return verifySelfContainedClient(clientId);
  }
  // Exact string only: a lookalike id falls through to the fetch path below.
  const known = KNOWN_CLIENTS.get(clientId);
  if (known) return known;
  if (clientId.startsWith('https://')) return fetchClientMetadata(clientId, nowMs, miss);
  return null;
}

/** Where `resolveClient` writes why it found no client: the counter's word, never the id (US-32 AC48). */
export interface ClientMiss {
  detail?: McpOAuthDetail<'unknown-client'>;
}

/** Test seam — the CIMD cache is process-global. */
export function resetCimdCache(): void {
  cimdCache.clear();
}
