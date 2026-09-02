/**
 * US-32 · the sealed-credential half of the hosted MCP server (design §4).
 *
 * The seal is the whole trust model: the AI vendor holds a blob it cannot
 * read, and every property that makes that true — domain separation between
 * blob types, binding to one client and one audience, a length that says
 * nothing, and rotation without a flag day — is a test here rather than a
 * paragraph in the design.
 */
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Every CIMD test needs DNS to say "public"; the address policy itself is
// tested directly against `isPublicAddress`.
vi.mock('node:dns/promises', () => ({
  default: { lookup: async () => [{ address: '1.1.1.1', family: 4 }] },
}));
import {
  ACCESS_LIFETIME_SECONDS,
  checkAuthorize,
  connectionKey,
  KNOWN_CLIENTS,
  isAllowedRedirect,
  isLoopbackRedirect,
  isMcpEnabled,
  isPublicAddress,
  issueTokens,
  packSealed,
  registerClient,
  resolveClient,
  resetMcpMemory,
  seal,
  spendWrites,
  typeKey,
  unpackSealed,
  unseal,
  verifyPkce,
  WRITE_COST,
  WRITES_PER_HOUR,
  type AccessPayload,
  type RefreshPayload,
} from './mcp-auth.server';

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

  it('does not allow loopback, even though RFC 8252 would', () => {
    // CLAUDE.md's hard rule beats design §4's allowance; the matcher exists so
    // turning it on is one constant.
    expect(isLoopbackRedirect('http://127.0.0.1:8931/cb')).toBe(true);
    expect(isLoopbackRedirect('http://localhost:8931/cb')).toBe(false);
    expect(isAllowedRedirect('http://127.0.0.1:8931/cb')).toBe(false);
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
