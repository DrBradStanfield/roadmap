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
  CONNECTION_WRITES,
  isAllowedRedirect,
  isLoopbackRedirect,
  isMcpEnabled,
  isPublicAddress,
  issueTokens,
  packSealed,
  PER_ACCESS_WRITES,
  registerClient,
  resolveClient,
  resetMcpMemory,
  seal,
  spendWrites,
  unpackSealed,
  unseal,
  verifyPkce,
  WRITE_COST,
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

describe('write budget, weighted (US-32, design §3 mitigation 4)', () => {
  it('a correction costs five adds', () => {
    expect(WRITE_COST.correct).toBe(5 * WRITE_COST.add);
  });

  it('spends an access token’s allowance, then refuses', () => {
    const jti = 'token-1';
    for (let i = 0; i < PER_ACCESS_WRITES / WRITE_COST.correct; i++) {
      expect(spendWrites(jti, PER_ACCESS_WRITES, WRITE_COST.correct)).toBe(true);
    }
    expect(spendWrites(jti, PER_ACCESS_WRITES, WRITE_COST.add)).toBe(false);
  });

  it('the connection pool is spent by refreshing, and runs out', () => {
    let budget = CONNECTION_WRITES;
    let refreshes = 0;
    for (;;) {
      const issued = issueTokens(AUDIENCE.clientId, 'rt', budget, Date.now());
      const access = unpackSealed<AccessPayload>('access', issued.access_token)!;
      if (access.writes === 0) break;
      budget = unpackSealed<RefreshPayload>('refresh', issued.refresh_token)!.budget;
      refreshes++;
    }
    expect(refreshes).toBe(CONNECTION_WRITES / PER_ACCESS_WRITES);
    expect(budget).toBe(0);
  });

  it('an access token’s stated lifetime is honest — clients refresh against it', () => {
    const issued = issueTokens(AUDIENCE.clientId, 'rt', CONNECTION_WRITES, Date.now());
    expect(issued.expires_in).toBe(ACCESS_LIFETIME_SECONDS);
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
  const CIMD = 'https://claude.ai/.well-known/oauth-client';
  const METADATA = { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] };

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
    vi.stubGlobal('fetch', vi.fn(async () => respond({ client_name: 'X', redirect_uris: ['https://evil.test/cb'] })));
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('caches, so a second authorize does not refetch', async () => {
    const spy = vi.fn(async () => respond(METADATA));
    vi.stubGlobal('fetch', spy);
    expect(await resolveClient(CIMD)).not.toBeNull();
    expect(await resolveClient(CIMD)).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('is not a client at all unless it is a URL or one of our own ids', async () => {
    expect(await resolveClient('claude')).toBeNull();
    expect(await resolveClient('')).toBeNull();
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
