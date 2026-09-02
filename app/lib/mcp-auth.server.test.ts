/**
 * US-32 · the sealed-credential half of the hosted MCP server (design §4).
 *
 * The seal is the whole trust model: the AI vendor holds a blob it cannot
 * read, and every property that makes that true — domain separation between
 * blob types, binding to one client and one audience, a length that says
 * nothing, and rotation without a flag day — is a test here rather than a
 * paragraph in the design.
 *
 * It spans the whole auth layer — `mcp-config`, `mcp-seal`, `mcp-clients`,
 * `mcp-grants` and `mcp-authorize` — which is why it keeps the older name.
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every CIMD test needs DNS to say "public"; the address policy itself is
// tested directly against `isPublicAddress`.
vi.mock('node:dns/promises', () => ({
  default: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] },
}));
import { checkAuthorize, MAX_STATE_LENGTH, sealState, verifyPkce } from './mcp-authorize.server';
import {
  isAllowedRedirect,
  isLoopbackRedirect,
  isPublicAddress,
  redirectMatches,
  KNOWN_CLIENTS,
  registerClient,
  resolveClient,
} from './mcp-clients.server';
import { isMcpEnabled } from './mcp-config.server';
import {
  ACCESS_LIFETIME_SECONDS,
  type AccessPayload,
  connectionKey,
  issueTokens,
  type RefreshPayload,
  type StatePayload,
  resetMcpMemory,
  spendWrites,
  WRITE_COST,
  WRITES_PER_HOUR,
} from './mcp-grants.server';
import { packSealed, seal, typeKey, unpackSealed, unseal } from './mcp-seal.server';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const AUDIENCE = { clientId: 'https://claude.ai/client', resource: 'https://mcp.example.test/mcp' };

beforeEach(() => {
  process.env.MCP_ISSUER = 'https://mcp.example.test';
  process.env.MCP_SEAL_KEYS = KEY_A;
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 9).toString('base64');
  resetMcpMemory();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('seal / unseal (US-32)', () => {
  it('round-trips a payload', () => {
    const token = seal('access', { clientId: AUDIENCE.clientId, rt: 'dropbox-refresh' }, AUDIENCE);
    expect(unseal<{ rt: string }>('access', token, AUDIENCE)?.rt).toBe('dropbox-refresh');
  });

  it('refuses a tampered blob', () => {
    const token = seal('access', { clientId: AUDIENCE.clientId, rt: 'secret' }, AUDIENCE);
    const [header, body] = token.split('.');
    const bytes = Buffer.from(body, 'base64url');
    bytes[20] ^= 0xff;
    expect(unseal('access', `${header}.${bytes.toString('base64url')}`, AUDIENCE)).toBeNull();
  });

  it('refuses a tampered header', () => {
    const token = seal('access', { clientId: AUDIENCE.clientId, rt: 'secret' }, AUDIENCE);
    const [, body] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ k: 0, t: 'access', c: 'x', r: 'y' }), 'utf8').toString('base64url');
    expect(unseal('access', `${forged}.${body}`, AUDIENCE)).toBeNull();
  });

  it('will not read a state blob as an access blob — per-type HKDF keys', () => {
    const token = seal('state', { clientId: AUDIENCE.clientId, rt: 'secret' }, AUDIENCE);
    expect(unseal('access', token, AUDIENCE)).toBeNull();
    expect(unseal('state', token, AUDIENCE)).not.toBeNull();
  });

  it('derives a different key per blob type — the HKDF info, not only the header', () => {
    // The header check masks this: remove `typ` from the HKDF info and every
    // other test still passes. The derivation is the defence behind it.
    const key = Buffer.alloc(32, 1);
    const derived = (['state', 'code', 'access', 'refresh'] as const).map((t) => typeKey(key, t).toString('hex'));
    expect(new Set(derived).size).toBe(4);
  });

  it('will not open another client’s blob, or another resource’s', () => {
    const token = seal('access', { clientId: AUDIENCE.clientId, rt: 'secret' }, AUDIENCE);
    expect(unseal('access', token, { ...AUDIENCE, clientId: 'https://evil.test/client' })).toBeNull();
    expect(unseal('access', token, { ...AUDIENCE, resource: 'https://other.test/mcp' })).toBeNull();
  });

  it('refuses an expired blob', () => {
    const exp = Math.floor(Date.now() / 1000) + 60;
    const token = seal('code', { clientId: AUDIENCE.clientId, exp }, AUDIENCE);
    expect(unseal('code', token, AUDIENCE, Date.now())).not.toBeNull();
    expect(unseal('code', token, AUDIENCE, (exp + 1) * 1000)).toBeNull();
  });

  it('rotation: a new key seals, and yesterday’s blob still opens', () => {
    const old = seal('access', { clientId: AUDIENCE.clientId, rt: 'old' }, AUDIENCE);
    process.env.MCP_SEAL_KEYS = `${KEY_B},${KEY_A}`; // prepend the new key
    const fresh = seal('access', { clientId: AUDIENCE.clientId, rt: 'new' }, AUDIENCE);

    expect(unseal<{ rt: string }>('access', old, AUDIENCE)?.rt).toBe('old');
    expect(unseal<{ rt: string }>('access', fresh, AUDIENCE)?.rt).toBe('new');
    const kidOf = (t: string) => JSON.parse(Buffer.from(t.split('.')[0], 'base64url').toString()).k;
    expect(kidOf(fresh)).not.toBe(kidOf(old)); // the fingerprint names the key, not a slot

    // No overlap is the incident response: every blob dies at once.
    process.env.MCP_SEAL_KEYS = KEY_B;
    expect(unseal('access', old, AUDIENCE)).toBeNull();
  });

  it('pads to a fixed bucket, so length leaks nothing about the credential', () => {
    const sizes = ['x', 'x'.repeat(300), 'x'.repeat(900)].map((rt) => {
      const token = seal('access', { clientId: AUDIENCE.clientId, rt }, AUDIENCE);
      return Buffer.from(token.split('.')[1], 'base64url').length - 12 - 16;
    });
    expect(sizes).toEqual([256, 512, 1024]);
  });

  it('is off entirely without MCP_SEAL_KEYS', () => {
    delete process.env.MCP_SEAL_KEYS;
    expect(isMcpEnabled()).toBe(false);
    expect(() => seal('access', {}, AUDIENCE)).toThrow();
  });
});

describe('token framing binds the client (US-32)', () => {
  it('round-trips, and rejects a swapped client id', () => {
    const packed = packSealed('access', AUDIENCE.clientId, { clientId: AUDIENCE.clientId, rt: 'r' });
    expect(unpackSealed<AccessPayload>('access', packed)?.rt).toBe('r');

    const other = Buffer.from('https://evil.test/client', 'utf8').toString('base64url');
    expect(unpackSealed('access', `${other}~${packed.split('~')[1]}`)).toBeNull();
  });
});

describe('write allowance, weighted and per connection (US-32, design §3 mitigation 4)', () => {
  it('a correction costs five adds', () => {
    expect(WRITE_COST.correct).toBe(5 * WRITE_COST.add);
  });

  it('spends the hour’s allowance, then refuses', () => {
    const key = connectionKey('dropbox-refresh');
    for (let i = 0; i < WRITES_PER_HOUR / WRITE_COST.correct; i++) {
      expect(spendWrites(key, WRITE_COST.correct)).toBe(true);
    }
    expect(spendWrites(key, WRITE_COST.add)).toBe(false);
  });

  it('is keyed on the connection, so extra access tokens buy no extra writes', () => {
    const rt = 'dropbox-refresh';
    for (let i = 0; i < WRITES_PER_HOUR; i++) expect(spendWrites(connectionKey(rt), WRITE_COST.add)).toBe(true);
    expect(spendWrites(connectionKey(rt), WRITE_COST.add)).toBe(false);

    // A second access token over the same connection lands on the same key.
    const issued = issueTokens(AUDIENCE.clientId, 'dropbox', rt, Date.now());
    const access = unpackSealed<AccessPayload>('access', issued.access_token)!;
    expect(spendWrites(connectionKey(access.rt), WRITE_COST.add)).toBe(false);
  });

  it('the allowance comes back with the hour, so refreshing never locks a user out', () => {
    const key = connectionKey('dropbox-refresh');
    for (let i = 0; i < WRITES_PER_HOUR; i++) expect(spendWrites(key, WRITE_COST.add)).toBe(true);
    const nextHour = Date.now() + 61 * 60 * 1000;
    expect(spendWrites(key, WRITE_COST.add, nextHour)).toBe(true);
  });

  it('an access token’s stated lifetime is honest — clients refresh against it', () => {
    const issued = issueTokens(AUDIENCE.clientId, 'dropbox', 'rt', Date.now());
    expect(issued.expires_in).toBe(ACCESS_LIFETIME_SECONDS);
  });

  it('the refresh lifetime is absolute from consent, not sliding (US-32)', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const first = unpackSealed<RefreshPayload>(
      'refresh',
      issueTokens(AUDIENCE.clientId, 'dropbox', 'rt', start).refresh_token,
      start,
    )!;
    const day89 = start + 89 * 24 * 60 * 60 * 1000;
    const renewed = issueTokens(AUDIENCE.clientId, 'dropbox', 'rt', day89, first.exp);
    expect(unpackSealed<RefreshPayload>('refresh', renewed.refresh_token, day89)!.exp).toBe(first.exp);
  });
});

describe('misconfiguration disables the feature rather than 500ing (US-32)', () => {
  it('names the malformed variable once, without its value', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.MCP_SEAL_KEYS = 'c2hvcnQ='; // valid base64, not 32 bytes
    expect(isMcpEnabled()).toBe(false);
    expect(isMcpEnabled()).toBe(false);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0][0])).toContain('MCP_SEAL_KEYS');
    expect(String(spy.mock.calls[0][0])).not.toContain('c2hvcnQ=');
  });

  it('is disabled when the client HMAC key is missing or malformed', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    delete process.env.MCP_CLIENT_HMAC_KEY;
    expect(isMcpEnabled()).toBe(false);
    process.env.MCP_CLIENT_HMAC_KEY = 'c2hvcnQ=';
    expect(isMcpEnabled()).toBe(false);
    process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 9).toString('base64');
    expect(isMcpEnabled()).toBe(true);
  });
});

describe('dynamic registration without a registry (US-32, design §4)', () => {
  it('mints a self-contained client id that verifies on use', async () => {
    const client = registerClient({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    })!;
    expect(client.clientId.startsWith('c.')).toBe(true);
    const resolved = await resolveClient(client.clientId);
    expect(resolved?.redirectUris).toEqual(['https://claude.ai/api/mcp/auth_callback']);
  });

  it('refuses a client id whose HMAC does not check out', async () => {
    const client = registerClient({
      client_name: 'Claude',
      redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    })!;
    const [prefix, body] = client.clientId.split('.');
    const forged = `${prefix}.${body}.${Buffer.alloc(32, 7).toString('base64url')}`;
    expect(await resolveClient(forged)).toBeNull();

    // …and a different HMAC key invalidates every existing id (§2: rotating it
    // forces every user to re-add the connector).
    process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 8).toString('base64');
    expect(await resolveClient(client.clientId)).toBeNull();
  });

  it('registers only known assistant redirect URIs', () => {
    expect(registerClient({ redirect_uris: ['https://evil.test/steal'] })).toBeNull();
    expect(registerClient({ redirect_uris: [] })).toBeNull();
    expect(registerClient({ redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] })).not.toBeNull();
  });

  it('registers a loopback redirect, so a command-line client can connect (US-32 AC21)', async () => {
    const client = registerClient({
      client_name: 'Gemini CLI',
      redirect_uris: ['http://localhost:12345/oauth/callback'],
    })!;
    expect(client.clientId.startsWith('c.')).toBe(true);
    const resolved = await resolveClient(client.clientId);
    expect(resolved?.redirectUris).toEqual(['http://localhost:12345/oauth/callback']);
  });

  it('still refuses http that is not loopback (US-32 AC21)', () => {
    expect(registerClient({ redirect_uris: ['http://example.com/cb'] })).toBeNull();
    expect(registerClient({ redirect_uris: ['http://localhost.evil.com/cb'] })).toBeNull();
    expect(registerClient({ redirect_uris: ['http://127.0.0.1.evil.com/cb'] })).toBeNull();
  });
});

describe('loopback redirects, RFC 8252 §7.3 (US-32 AC21)', () => {
  it('accepts only the three loopback hosts, over http, with no userinfo or fragment', () => {
    expect(isLoopbackRedirect('http://127.0.0.1:8931/cb')).toBe(true);
    expect(isLoopbackRedirect('http://localhost:8931/cb')).toBe(true);
    expect(isLoopbackRedirect('http://[::1]:8931/cb')).toBe(true);
    expect(isAllowedRedirect('http://127.0.0.1:8931/cb')).toBe(true);

    // https://localhost is NOT loopback for this purpose: the exemption exists
    // because a local listener cannot hold a certificate.
    expect(isLoopbackRedirect('https://localhost:1234/cb')).toBe(false);
    expect(isLoopbackRedirect('http://example.com/cb')).toBe(false);
    // Exact host match — these are ordinary public names.
    expect(isLoopbackRedirect('http://localhost.evil.com/cb')).toBe(false);
    expect(isLoopbackRedirect('http://127.0.0.1.evil.com/cb')).toBe(false);
    expect(isLoopbackRedirect('http://user@127.0.0.1/cb')).toBe(false);
    expect(isLoopbackRedirect('http://127.0.0.1/cb#x')).toBe(false);
    expect(isLoopbackRedirect('not a url')).toBe(false);
  });

  it('ignores the port and nothing else', () => {
    expect(redirectMatches('http://localhost/callback', 'http://localhost:61234/callback')).toBe(true);
    expect(redirectMatches('http://127.0.0.1:1/cb', 'http://127.0.0.1:65535/cb')).toBe(true);
    // Path, host, scheme and query all still have to match exactly.
    expect(redirectMatches('http://localhost/callback', 'http://localhost:61234/other')).toBe(false);
    expect(redirectMatches('http://localhost/callback', 'http://127.0.0.1:61234/callback')).toBe(false);
    expect(redirectMatches('http://localhost/callback', 'https://localhost/callback')).toBe(false);
    expect(redirectMatches('http://localhost/cb', 'http://localhost:1/cb?next=x')).toBe(false);
    // A public redirect is exact-match only: no port slack for anyone else.
    expect(redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai/api/mcp/auth_callback')).toBe(true);
    expect(redirectMatches('https://claude.ai/api/mcp/auth_callback', 'https://claude.ai:8443/api/mcp/auth_callback')).toBe(false);
  });
});

describe('CIMD fetch policy (US-32, design §4 — this is an SSRF surface)', () => {
  // Deliberately NOT one of the pinned ids: this suite exercises the fetch path.
  const CIMD = 'https://claude.ai/.well-known/oauth-client';
  const METADATA = {
    client_id: CIMD,
    client_name: 'Claude',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  };

  function respond(body: unknown, init: { type?: string; status?: number } = {}) {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': init.type ?? 'application/json' },
    });
  }

  it('rejects a non-public address, which is the whole point', () => {
    for (const [ip, family] of [['127.0.0.1', 4], ['10.0.0.5', 4], ['172.20.1.1', 4], ['192.168.1.1', 4],
      ['169.254.169.254', 4], ['100.64.0.1', 4], ['::1', 6], ['fd00::1', 6], ['fe80::1', 6],
      ['::ffff:10.0.0.1', 6]] as Array<[string, number]>) {
      expect(isPublicAddress(ip, family)).toBe(false);
    }
    expect(isPublicAddress('1.1.1.1', 4)).toBe(true);
    expect(isPublicAddress('2606:4700::1111', 6)).toBe(true);
  });

  it('refuses plain http', async () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(await resolveClient('http://claude.ai/.well-known/oauth-client')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sends no credentials, follows no redirect, and asks for JSON', async () => {
    const spy = vi.fn(async () => respond(METADATA));
    vi.stubGlobal('fetch', spy);
    await resolveClient(CIMD);
    const [, init] = spy.mock.calls[0] as unknown as [URL, RequestInit];
    expect(init.redirect).toBe('error');
    expect(init.credentials).toBe('omit');
    expect((init.headers as Record<string, string>).Accept).toBe('application/json');
  });

  it('refuses a redirect', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('unexpected redirect');
    }));
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('refuses the wrong content type', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond(METADATA, { type: 'text/html' })));
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('refuses an oversize body even when content-length lies', async () => {
    const huge = JSON.stringify({ ...METADATA, pad: 'x'.repeat(70_000) });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(huge, {
      headers: { 'content-type': 'application/json', 'content-length': '10' },
    })));
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('refuses metadata claiming a redirect URI we do not allow', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ ...METADATA, redirect_uris: ['https://evil.test/cb'] })));
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('caches, so a second authorize does not refetch', async () => {
    const spy = vi.fn(async () => respond(METADATA));
    vi.stubGlobal('fetch', spy);
    expect(await resolveClient(CIMD)).not.toBeNull();
    expect(await resolveClient(CIMD)).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses a document that claims a different client_id (draft §4, a MUST)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ ...METADATA, client_id: 'https://claude.ai/other' })));
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('refuses a document with no client_id at all', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => respond({ client_name: 'Claude', redirect_uris: METADATA.redirect_uris })));
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('is not a client at all unless it is a URL or one of our own ids', async () => {
    expect(await resolveClient('claude')).toBeNull();
    expect(await resolveClient('')).toBeNull();
  });
});

/**
 * 2026-09-02: claude.ai's CIMD document is behind a Cloudflare managed
 * challenge from Fly, so the fetch path cannot resolve it. The two canonical
 * vendor clients are pinned instead, and these tests are what keeps the pin
 * honest: no network, exact ids only, and no weakening of the redirect check.
 */
describe('pinned clients (US-32, IETF CIMD draft §4 — our own policy)', () => {
  const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';
  const CHATGPT = 'https://chatgpt.com/oauth/client.json';
  const CLAUDE_CODE = 'https://claude.ai/oauth/claude-code-client-metadata';

  it('every pinned redirect is also in the allow-list, so the two cannot drift', () => {
    for (const client of KNOWN_CLIENTS.values()) {
      expect(client.redirectUris.length).toBeGreaterThan(0);
      for (const uri of client.redirectUris) expect(isAllowedRedirect(uri)).toBe(true);
    }
  });

  it('resolves without touching the network, even when fetch would throw', async () => {
    const spy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', spy);
    expect(await resolveClient(CLAUDE)).toEqual({
      clientId: CLAUDE,
      name: 'Claude',
      label: 'claude',
      redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    });
    expect(await resolveClient(CHATGPT)).toMatchObject({ name: 'ChatGPT' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('resolves through the exact Cloudflare challenge that broke production', async () => {
    const spy = vi.fn(async () => new Response('<html>Just a moment…</html>', {
      status: 403,
      headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' },
    }));
    vi.stubGlobal('fetch', spy);
    expect(await resolveClient(CLAUDE)).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('pins an exact string, so lookalikes fall through to the fetch path', async () => {
    const spy = vi.fn(async () => new Response('no', { status: 404 }));
    vi.stubGlobal('fetch', spy);
    for (const lookalike of [
      'https://claude.ai/oauth/mcp-oauth-client-metadata/',
      'https://claude.ai.evil.test/oauth/mcp-oauth-client-metadata',
    ]) {
      expect(await resolveClient(lookalike)).toBeNull();
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('answers Claude Code on a loopback port with no fetch at all (US-32 AC21)', async () => {
    const spy = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    vi.stubGlobal('fetch', spy);
    const client = (await resolveClient(CLAUDE_CODE))!;
    expect(client).toEqual({
      clientId: CLAUDE_CODE,
      name: 'Claude Code',
      label: 'claude_code',
      redirectUris: ['http://localhost/callback', 'http://127.0.0.1/callback'],
    });
    const checked = checkAuthorize(new URLSearchParams({
      redirect_uri: 'http://127.0.0.1:61234/callback',
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    }), client);
    expect(checked.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('gives Claude Code no path it did not publish, on any port', () => {
    const client = KNOWN_CLIENTS.get(CLAUDE_CODE)!;
    for (const redirect_uri of ['http://127.0.0.1:61234/steal', 'https://localhost:61234/callback']) {
      const checked = checkAuthorize(new URLSearchParams({
        redirect_uri,
        response_type: 'code',
        code_challenge: 'a'.repeat(43),
        code_challenge_method: 'S256',
      }), client);
      expect(checked).toMatchObject({ ok: false, redirectable: false });
    }
  });

  it('gives a pinned client no redirect it did not publish', () => {
    const client = KNOWN_CLIENTS.get(CLAUDE)!;
    const params = new URLSearchParams({
      redirect_uri: 'https://evil.test/cb',
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
    });
    const checked = checkAuthorize(params, client);
    expect(checked.ok).toBe(false);
    expect(checked).toMatchObject({ redirectable: false });
  });

  it('logs the drift with a host and no URL or query', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkAuthorize(new URLSearchParams({ redirect_uri: 'https://evil.test/cb?code=secret' }), KNOWN_CLIENTS.get(CHATGPT)!);
    const message = String(logged.mock.calls[0][0]);
    expect(message).toContain('chatgpt.com');
    expect(message).not.toContain('?');
    expect(message).not.toContain('evil.test');
    expect(message).not.toContain('https://');
  });
});

describe('PKCE (US-32)', () => {
  it('accepts the matching verifier and nothing else', () => {
    const verifier = 'a'.repeat(64);
    const challenge = crypto.createHash('sha256').update(verifier, 'ascii').digest('base64url');
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce('b'.repeat(64), challenge)).toBe(false);
    expect(verifyPkce('short', challenge)).toBe(false);
  });
});

/**
 * US-32 · `state` is the client's own opaque value. OpenAI's platform relay
 * sends 521 characters; we truncated at 512, echoed the stump on the callback
 * and every ChatGPT connection died on "Invalid OAuth state". An OAuth client
 * is entitled to get `state` back byte-identical or not at all — never
 * shortened, because a shortened one looks valid and fails at the far end.
 */
describe('client state round-trip (US-32)', () => {
  const CHATGPT_STATE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

  function authorizeParams(state: string): URLSearchParams {
    return new URLSearchParams({
      redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
      response_type: 'code',
      code_challenge: 'a'.repeat(43),
      code_challenge_method: 'S256',
      state,
    });
  }

  it('returns a 600-character state byte-identical, the length OpenAI actually sends', () => {
    const state = 'S'.repeat(600);
    const checked = checkAuthorize(authorizeParams(state), KNOWN_CLIENTS.get(CHATGPT_STATE)!);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.request.clientState).toBe(state);
  });

  it('carries that state through the seal and back out unchanged', () => {
    const state = 'S'.repeat(MAX_STATE_LENGTH);
    const checked = checkAuthorize(authorizeParams(state), KNOWN_CLIENTS.get(CHATGPT_STATE)!);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const sealed = sealState(checked.request, 'dropbox', Date.now());
    const opened = unpackSealed<StatePayload>('state', sealed);
    expect(opened?.clientState).toBe(state);
  });

  it('refuses one character over the cap rather than truncating it', () => {
    const checked = checkAuthorize(
      authorizeParams('S'.repeat(MAX_STATE_LENGTH + 1)),
      KNOWN_CLIENTS.get(CHATGPT_STATE)!,
    );
    expect(checked.ok).toBe(false);
    expect(checked).toMatchObject({ error: 'invalid_request', redirectable: true });
  });

  /**
   * The cap is set by the `__Host-mcp-state` COOKIE, not by taste. The sealed
   * state is padded to a fixed bucket, and the jump from the 2048 bucket to
   * the 4096 one takes the cookie from ~3.1 KB to ~5.8 KB — past the 4096-byte
   * limit every browser enforces, where it is dropped silently and the
   * callback finds no cookie. This test is the cap's justification.
   */
  it('keeps the sealed state cookie under the 4096-byte browser limit at the cap', () => {
    const checked = checkAuthorize(
      authorizeParams('S'.repeat(MAX_STATE_LENGTH)),
      KNOWN_CLIENTS.get(CHATGPT_STATE)!,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    // The cookie the callback actually reads carries the 43-byte consent nonce.
    const opened = unpackSealed<StatePayload>('state', sealState(checked.request, 'dropbox', Date.now()))!;
    const sealed = packSealed('state', opened.clientId, { ...opened, nonce: 'n'.repeat(43) });
    const cookie = `__Host-mcp-state=${sealed}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=600`;
    expect(cookie.length).toBeLessThan(4096);
  });
});
