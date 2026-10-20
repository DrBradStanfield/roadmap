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
import https from 'node:https';
import net from 'node:net';
import zlib from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The client-metadata fetch resolves through `node:dns` inside its connect-time
// check (US-32 AC47). A test sets the answer; no lookup leaves the machine.
const dnsAnswer = vi.hoisted(() => ({ records: [] as Array<{ address: string; family: number }> }));
vi.mock('node:dns', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:dns')>();
  const lookup = (_host: string, _options: unknown, callback: (err: Error | null, records: unknown) => void) =>
    setImmediate(() => callback(null, dnsAnswer.records));
  return { ...real, default: { ...real, lookup } };
});
import { checkAuthorize, MAX_STATE_LENGTH, sealState, verifyPkce } from './mcp-authorize.server';
import { ALLOWED_REDIRECTS, isAllowedRedirect, isLoopbackRedirect, isPublicAddress, KNOWN_CLIENTS, redirectMatches, redirectMiss, registerClient, resolveClient } from './mcp-clients.server';
import { isMcpEnabled } from './mcp-config.server';
import { ACCESS_LIFETIME_SECONDS, connectionKey, issueTokens, resetMcpMemory, spendWrites, STATE_LIFETIME_SECONDS, type AccessPayload, type RefreshPayload, type StatePayload, WRITE_COST, WRITES_PER_HOUR } from './mcp-grants.server';
import { packSealed, seal, typeKey, unpackSealed, unseal } from './mcp-seal.server';
import { serveClientMetadata, stubHttpsRequest } from './mcp-cimd.test-helpers';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const AUDIENCE = { clientId: 'https://claude.ai/client', resource: 'https://mcp.example.test/mcp' };

beforeEach(() => {
  process.env.MCP_ISSUER = 'https://mcp.example.test';
  process.env.MCP_SEAL_KEYS = KEY_A;
  process.env.MCP_CLIENT_HMAC_KEY = Buffer.alloc(32, 9).toString('base64');
  resetMcpMemory();
  dnsAnswer.records = [];
});

afterEach(() => {
  vi.resetAllMocks();
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
    const key = connectionKey({ rt: 'dropbox-refresh' });
    for (let i = 0; i < WRITES_PER_HOUR / WRITE_COST.correct; i++) {
      expect(spendWrites(key, WRITE_COST.correct)).toBe(true);
    }
    expect(spendWrites(key, WRITE_COST.add)).toBe(false);
  });

  it('is keyed on the connection, so extra access tokens buy no extra writes', () => {
    const rt = 'dropbox-refresh';
    for (let i = 0; i < WRITES_PER_HOUR; i++) expect(spendWrites(connectionKey({ rt }), WRITE_COST.add)).toBe(true);
    expect(spendWrites(connectionKey({ rt }), WRITE_COST.add)).toBe(false);

    // A second access token over the same connection lands on the same key.
    const issued = issueTokens(AUDIENCE.clientId, 'dropbox', { rt }, Date.now());
    const access = unpackSealed<AccessPayload>('access', issued.access_token)!;
    expect(spendWrites(connectionKey(access), WRITE_COST.add)).toBe(false);
  });

  it('the allowance comes back with the hour, so refreshing never locks a user out', () => {
    const key = connectionKey({ rt: 'dropbox-refresh' });
    for (let i = 0; i < WRITES_PER_HOUR; i++) expect(spendWrites(key, WRITE_COST.add)).toBe(true);
    const nextHour = Date.now() + 61 * 60 * 1000;
    expect(spendWrites(key, WRITE_COST.add, nextHour)).toBe(true);
  });

  it('an access token’s stated lifetime is honest — clients refresh against it', () => {
    const issued = issueTokens(AUDIENCE.clientId, 'dropbox', { rt: 'rt' }, Date.now());
    expect(issued.expires_in).toBe(ACCESS_LIFETIME_SECONDS);
  });

  it('the refresh lifetime is absolute from consent, not sliding (US-32)', () => {
    const start = Date.parse('2026-01-01T00:00:00.000Z');
    const first = unpackSealed<RefreshPayload>(
      'refresh',
      issueTokens(AUDIENCE.clientId, 'dropbox', { rt: 'rt' }, start).refresh_token,
      start,
    )!;
    const day89 = start + 89 * 24 * 60 * 60 * 1000;
    const renewed = issueTokens(AUDIENCE.clientId, 'dropbox', { rt: 'rt' }, day89, first.exp);
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

  it('rejects a non-public address, which is the whole point', () => {
    for (const [ip, family] of [['127.0.0.1', 4], ['10.0.0.5', 4], ['172.20.1.1', 4], ['192.168.1.1', 4],
      ['169.254.169.254', 4], ['100.64.0.1', 4], ['::1', 6], ['fd00::1', 6], ['fe80::1', 6],
      ['::ffff:10.0.0.1', 6]] as Array<[string, number]>) {
      expect(isPublicAddress(ip, family)).toBe(false);
    }
    expect(isPublicAddress('1.1.1.1', 4)).toBe(true);
    expect(isPublicAddress('2606:4700::1111', 6)).toBe(true);
  });

  it('rejects a non-public address written in another spelling (US-32 AC45)', () => {
    for (const ip of [
      '0:0:0:0:0:ffff:127.0.0.1',
      '0:0:0:0:0:FFFF:169.254.169.254',
      '0000:0000:0000:0000:0000:ffff:7f00:0001',
      '::ffff:7f00:1',
      '64:ff9b::127.0.0.1',
      '64:ff9b::7f00:1',
      '2002:7f00:1::',
      '2002:0101:0101::',
      'ff02::1',
      '::127.0.0.1',
      '::7f00:1',
      '::ffff:0:10.0.0.1',
      '127.0.0.1',
      '64:ff9b:1::7f00:1',
      '64:ff9b:1::127.0.0.1',
      'fc0::1',
      'fd::1',
      '::ffff:0:0:0:1',
      '0:0:0:0:ffff:0:7f00:1',
      '::ffff:0:7f00:1',
      '0:0:0:0:ffff:0:101:101',
    ]) {
      expect(isPublicAddress(ip, 6), ip).toBe(false);
    }
    expect(isPublicAddress('0:0:0:0:0:ffff:1.1.1.1', 6)).toBe(true);
    expect(isPublicAddress('::FFFF:1.1.1.1', 6)).toBe(true);
    expect(isPublicAddress('::ffff:0101:0101', 6)).toBe(true);
    expect(isPublicAddress('::1.1.1.1', 6)).toBe(true);
    expect(isPublicAddress('2606:4700::1.1.1.1', 6)).toBe(true);
  });

  it('judges a well-known NAT64 address by the IPv4 it carries (US-32 AC45)', () => {
    // 64:ff9b::/96 (RFC 6052): a DNS64 resolver synthesises these for IPv4-only
    // hosts. The hex and dotted spellings of each address must agree.
    for (const ip of [
      '64:ff9b::101:101', '64:ff9b::1.1.1.1',
      '64:FF9B::1.1.1.1', '64:ff9b:0:0:0:0:101:101',
      '0064:ff9b:0000:0000:0000:0000:0101:0101', '0064:ff9b:0:0:0:0:1.1.1.1',
    ]) {
      expect(isPublicAddress(ip, 6), ip).toBe(true);
    }
    for (const ip of [
      '64:ff9b::7f00:1', '64:ff9b::127.0.0.1',
      '64:ff9b::a9fe:a9fe', '64:ff9b::169.254.169.254',
      '64:ff9b::a00:5', '64:ff9b::10.0.0.5',
      '64:ff9b::ac14:101', '64:ff9b::172.20.1.1',
      '64:ff9b::c0a8:101', '64:ff9b::192.168.1.1',
      '64:ff9b::6440:1', '64:ff9b::100.64.0.1',
      '64:ff9b::e000:1', '64:ff9b::224.0.0.1',
      '64:ff9b::', '64:ff9b::0.0.0.0',
      '64:ff9b::1', '64:ff9b::0.0.0.1',
      '0064:ff9b:0000:0000:0000:0000:a9fe:a9fe', '64:FF9B:0:0:0:0:169.254.169.254',
    ]) {
      expect(isPublicAddress(ip, 6), ip).toBe(false);
    }
    // The rest of 64:ff9b::/32 stays refused, local-use 64:ff9b:1::/48 included.
    for (const ip of [
      '64:ff9b:1::101:101', '64:ff9b:1::1.1.1.1',
      '64:ff9b:0:0:1::101:101', '64:ff9b:0:0:1::1.1.1.1',
      '64:ff9b:0:0:0:1:101:101', '64:ff9b:0:0:0:1:1.1.1.1',
      '64:ff9b:ffff::101:101', '64:ff9b:ffff::1.1.1.1',
    ]) {
      expect(isPublicAddress(ip, 6), ip).toBe(false);
    }
    // Fails closed: garbage, a zone id, a prefix length, the wrong or an unknown family.
    for (const [ip, family] of [
      ['64:ff9b::101:101%eth0', 6], ['64:ff9b::1.1.1.1%eth0', 6],
      ['64:ff9b::101:101/96', 6], ['64:ff9b::1.1.1', 6], ['64:ff9b::1.1.1.256', 6],
      ['64:ff9b:::101:101', 6], ['64:ff9b::101:101:', 6], ['64:ff9b::1.1.1.1:101', 6],
      ['64:ff9b::101:101', 4], ['64:ff9b::101:101', 0], ['64:ff9b::101:101', 5],
      // Malformed dotted quads Number() would read (adversary on 0c5c8d3d): empty, padded, hex, exponent, leading zero.
      ['64:ff9b::1..1.1', 6], ['64:ff9b::1.1.1.', 6], ['64:ff9b:: 1.1.1.1', 6], ['64:ff9b::1.1.1.1\n', 6],
      ['64:ff9b::0x1.1.1.1', 6], ['64:ff9b::1e2.0.0.1', 6], ['64:ff9b::0177.0.0.1', 6], ['::ffff:1..1.1', 6], ['::1.1.1.', 6],
      ['1..1.1', 4], ['0177.0.0.1', 4], ['1.1.1.1\n', 4], [' 1.1.1.1', 4], ['0x1.1.1.1', 4],
    ] as Array<[string, number]>) {
      expect(isPublicAddress(ip, family), `${ip} family ${family}`).toBe(false);
    }
  });

  it('refuses the reserved ranges a public check must not pass (US-32 AC47)', () => {
    for (const ip of [
      '192.0.0.1', '192.0.0.255', '192.0.2.1', '198.18.0.1', '198.19.255.255', '198.51.100.1',
      '203.0.113.1', '192.88.99.1', '240.0.0.1', '255.255.255.255',
    ]) {
      expect(isPublicAddress(ip, 4), ip).toBe(false);
    }
    for (const ip of ['192.0.1.1', '192.0.3.1', '198.17.255.255', '198.20.0.0', '198.51.101.1', '203.0.114.1', '192.88.100.1', '223.255.255.255']) {
      expect(isPublicAddress(ip, 4), ip).toBe(true);
    }
    // IPv6: only global unicast, 2000::/3, minus its special blocks.
    for (const ip of [
      '2001:db8::1', '2001:0db8:ffff::1', '3fff::1', '3fff:fff:ffff::1', '2001:2::1', '2001::1',
      '2001:0:4136:e378:8000:63bf:3fff:fdd2', '2001:10::1', '2001:1ff:ffff::1', '5f00::1', '100::1',
      'fec0::1', 'feff::1', '::2', '1::1', '4000::1', 'e000::1',
    ]) {
      expect(isPublicAddress(ip, 6), ip).toBe(false);
    }
    for (const ip of ['2001:200::1', '2001:4860:4860::8888', '2a00:1450::1', '3ffe::1', '3fff:1000::1', '2001:db9::1']) {
      expect(isPublicAddress(ip, 6), ip).toBe(true);
    }
  });

  it('refuses plain http', async () => {
    const spy = serveClientMetadata({ [CIMD]: METADATA });
    expect(await resolveClient('http://claude.ai/.well-known/oauth-client')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a client id that carries credentials, which node:https would send (US-32 AC47)', async () => {
    const withUser = 'https://user:secret@claude.ai/.well-known/oauth-client';
    const spy = serveClientMetadata({ [withUser]: { ...METADATA, client_id: withUser } });
    expect(await resolveClient(withUser)).toBeNull();
    expect(await resolveClient('https://user@claude.ai/.well-known/oauth-client')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('asks for JSON with a fixed user-agent, sends no credentials, and keeps no TLS session (US-32 AC47)', async () => {
    const spy = serveClientMetadata({ [CIMD]: METADATA });
    expect(await resolveClient(CIMD)).toMatchObject({ clientId: CIMD, name: 'Claude' });
    const [url, options] = spy.mock.calls[0] as unknown as [URL, https.RequestOptions];
    expect(url.href).toBe(CIMD);
    expect(options.headers).toEqual({ Accept: 'application/json', 'Accept-Encoding': 'gzip, deflate, br', 'User-Agent': 'node' });
    expect(options.auth).toBeUndefined();
    expect(options.method ?? 'GET').toBe('GET');
    expect(typeof options.lookup).toBe('function');
    expect(options.agent).toBeInstanceOf(https.Agent);
    expect((options.agent as https.Agent & { maxCachedSessions: number }).maxCachedSessions).toBe(0);
  });

  it('refuses a redirect, and every other answer that is not 2xx (US-32 AC47)', async () => {
    for (const status of [301, 302, 303, 307, 308, 304, 400, 403, 404, 500, 503]) {
      resetMcpMemory();
      stubHttpsRequest(() => ({ status, headers: { location: 'https://claude.ai/elsewhere' }, body: JSON.stringify(METADATA) }));
      expect(await resolveClient(CIMD), String(status)).toBeNull();
    }
    resetMcpMemory();
    stubHttpsRequest(() => ({ status: 203, body: JSON.stringify(METADATA) }));
    expect(await resolveClient(CIMD)).not.toBeNull();
  });

  it('refuses the wrong content type', async () => {
    stubHttpsRequest(() => ({ headers: { 'content-type': 'text/html' }, body: JSON.stringify(METADATA) }));
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('refuses an oversize body even when content-length lies', async () => {
    const huge = JSON.stringify({ ...METADATA, pad: 'x'.repeat(70_000) });
    stubHttpsRequest(() => ({ headers: { 'content-length': '10' }, body: huge }));
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('refuses a body whose content-length is over the cap before reading it', async () => {
    stubHttpsRequest(() => ({ headers: { 'content-length': '65537' }, stall: 'body' }));
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('decodes gzip, deflate and br, as fetch did (US-32 AC47)', async () => {
    const json = JSON.stringify(METADATA);
    for (const [coding, encode] of [
      ['gzip', zlib.gzipSync], ['x-gzip', zlib.gzipSync], ['GZIP', zlib.gzipSync],
      ['deflate', zlib.deflateSync], ['br', zlib.brotliCompressSync], ['identity', Buffer.from],
    ] as Array<[string, (s: string) => Buffer]>) {
      resetMcpMemory();
      stubHttpsRequest(() => ({ headers: { 'content-encoding': coding }, body: encode(json) }));
      expect(await resolveClient(CIMD), coding).toMatchObject({ clientId: CIMD, name: 'Claude' });
    }
  });

  it('refuses a compressed body that decodes past the cap (US-32 AC47)', async () => {
    const bomb = JSON.stringify({ ...METADATA, pad: 'x'.repeat(1_000_000) });
    for (const [coding, packed] of [['gzip', zlib.gzipSync(bomb)], ['deflate', zlib.deflateSync(bomb)], ['br', zlib.brotliCompressSync(bomb)]] as const) {
      expect(packed.byteLength, coding).toBeLessThan(65536);
      resetMcpMemory();
      stubHttpsRequest(() => ({ headers: { 'content-encoding': coding, 'content-length': String(packed.byteLength) }, body: packed }));
      expect(await resolveClient(CIMD), coding).toBeNull();
    }
  });

  it('refuses a content encoding it does not decode (US-32 AC47)', async () => {
    for (const coding of ['compress', 'zstd', 'gzip, br', 'br, gzip', 'constructor', '__proto__', 'toString']) {
      resetMcpMemory();
      stubHttpsRequest(() => ({ headers: { 'content-encoding': coding }, body: JSON.stringify(METADATA) }));
      expect(await resolveClient(CIMD), coding).toBeNull();
    }
  });

  it('refuses the ports fetch refused, and port 0, and no other (US-32 AC47)', async () => {
    for (const port of [0, 1, 21, 22, 25, 53, 110, 143, 465, 587, 993, 995, 2049, 6000, 6667, 10080]) {
      const url = `https://claude.ai:${port}/.well-known/oauth-client`;
      const spy = serveClientMetadata({ [url]: { ...METADATA, client_id: url } });
      expect(await resolveClient(url), url).toBeNull();
      expect(spy, url).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    for (const url of ['https://claude.ai:8443/.well-known/oauth-client', 'https://claude.ai:443/.well-known/oauth-client']) {
      serveClientMetadata({ [new URL(url).href]: { ...METADATA, client_id: url } });
      expect(await resolveClient(url), url).toMatchObject({ clientId: url });
    }
  });

  it('gives up after one 5-second deadline, whether the headers, the body or its decoding stall (US-32 AC47)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const gzipped = zlib.gzipSync(JSON.stringify(METADATA));
    try {
      for (const [stall, answer] of [
        ['headers', { body: JSON.stringify(METADATA) }],
        ['body', { body: JSON.stringify(METADATA) }],
        ['body', { headers: { 'content-encoding': 'gzip' }, body: gzipped.subarray(0, gzipped.byteLength >> 1) }],
      ] as const) {
        resetMcpMemory();
        const spy = stubHttpsRequest(() => ({ stall, ...answer }));
        let settled = false;
        const result = resolveClient(CIMD).finally(() => { settled = true; });
        await vi.advanceTimersByTimeAsync(4999);
        expect(settled, stall).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await result, stall).toBeNull();
        const req = spy.mock.results[0].value as { destroy: ReturnType<typeof vi.fn> };
        expect(req.destroy, stall).toHaveBeenCalled();
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses metadata claiming a redirect URI we do not allow', async () => {
    serveClientMetadata({ [CIMD]: { ...METADATA, redirect_uris: ['https://evil.test/cb'] } });
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('caches, so a second authorize does not refetch', async () => {
    const spy = serveClientMetadata({ [CIMD]: METADATA });
    expect(await resolveClient(CIMD)).not.toBeNull();
    expect(await resolveClient(CIMD)).not.toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('refuses a document that claims a different client_id (draft §4, a MUST)', async () => {
    serveClientMetadata({ [CIMD]: { ...METADATA, client_id: 'https://claude.ai/other' } });
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('refuses a document with no client_id at all', async () => {
    serveClientMetadata({ [CIMD]: { client_name: 'Claude', redirect_uris: METADATA.redirect_uris } });
    expect(await resolveClient(CIMD)).toBeNull();
  });

  it('fetches a public IP-literal host as before (US-32 AC47)', async () => {
    const literal = 'https://1.1.1.1/client.json';
    const spy = serveClientMetadata({ [literal]: { ...METADATA, client_id: literal } });
    expect(await resolveClient(literal)).toMatchObject({ clientId: literal });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('passes a public answer through the connect-time lookup, in both shapes Node asks for (US-32 AC47)', async () => {
    const spy = serveClientMetadata({ [CIMD]: METADATA });
    await resolveClient(CIMD);
    const lookup = (spy.mock.calls[0] as unknown as [URL, https.RequestOptions])[1].lookup as unknown as (
      host: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => void;
    const records = [{ address: '1.1.1.1', family: 4 }, { address: '2606:4700::1111', family: 6 }];
    dnsAnswer.records = records;
    const call = (all: boolean) => new Promise<unknown[]>((resolve) => lookup('claude.ai', { all }, (...args) => resolve(args)));
    expect(await call(true)).toEqual([null, records]);
    expect(await call(false)).toEqual([null, '1.1.1.1', 4]);
  });

  /**
   * The real connection path from here on: no stub, real sockets. A listener on
   * the loopback address counts every connection that reaches it, so a check
   * that let one through fails here even though the TLS handshake would then
   * fail too ("TLS poison" needs only the connection).
   */
  describe('the real connection path (US-32 AC47)', () => {
    async function listen(host: string): Promise<{ port: number; connections: () => number; close: () => Promise<void> }> {
      let count = 0;
      const server = net.createServer((socket) => {
        count++;
        socket.destroy();
      });
      await new Promise<void>((resolve) => server.listen(0, host, resolve));
      return {
        port: (server.address() as net.AddressInfo).port,
        connections: () => count,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
      };
    }

    it('never opens a socket to an IP-literal host that is not public', async () => {
      const connect = vi.spyOn(https.Agent.prototype, 'createConnection');
      for (const host of ['127.0.0.1', '::1']) {
        const server = await listen(host);
        try {
          const url = `https://${host.includes(':') ? `[${host}]` : host}:${server.port}/client.json`;
          expect(await resolveClient(url), url).toBeNull();
          expect(server.connections(), url).toBe(0);
        } finally {
          await server.close();
        }
      }
      for (const url of ['https://127.0.0.1/', 'https://[::1]/', 'https://[64:ff9b::a9fe:a9fe]/', 'https://[::ffff:169.254.169.254]/', 'https://0x7f.1/']) {
        expect(await resolveClient(url), url).toBeNull();
      }
      expect(connect).not.toHaveBeenCalled();
    });

    it('connects only to the answer it checked, so a rebinding resolver gets no second look', async () => {
      const server = await listen('127.0.0.1');
      try {
        // An earlier lookup said public; the one the connection makes says loopback.
        dnsAnswer.records = [{ address: '127.0.0.1', family: 4 }];
        expect(await resolveClient(`https://localhost:${server.port}/client.json`)).toBeNull();
        expect(server.connections()).toBe(0);
      } finally {
        await server.close();
      }
    });

    it('refuses a name whose answer mixes public and private addresses, before any socket opens', async () => {
      const server = await listen('127.0.0.1');
      // `localhost`: if the check were not wired into the connection, Node's own
      // resolver would send this request to the listener.
      const url = `https://localhost:${server.port}/client.json`;
      const answers = [
        [{ address: '1.1.1.1', family: 4 }, { address: '127.0.0.1', family: 4 }],
        [{ address: '127.0.0.1', family: 4 }, { address: '1.1.1.1', family: 4 }],
        [{ address: '2606:4700::1111', family: 6 }, { address: '127.0.0.1', family: 4 }],
        [{ address: '127.0.0.1', family: 4 }],
        [],
      ];
      try {
        for (const autoSelect of [true, false]) {
          const before = net.getDefaultAutoSelectFamily();
          net.setDefaultAutoSelectFamily(autoSelect);
          try {
            for (const records of answers) {
              resetMcpMemory();
              dnsAnswer.records = records;
              expect(await resolveClient(url), JSON.stringify(records)).toBeNull();
            }
          } finally {
            net.setDefaultAutoSelectFamily(before);
          }
        }
        expect(server.connections()).toBe(0);
      } finally {
        await server.close();
      }
    });
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
  const CODEX = 'https://chatgpt.com/oauth/codex/client.json';

  it('every pinned redirect is also in the allow-list, so the two cannot drift', () => {
    for (const client of KNOWN_CLIENTS.values()) {
      expect(client.redirectUris.length).toBeGreaterThan(0);
      for (const uri of client.redirectUris) expect(isAllowedRedirect(uri)).toBe(true);
    }
  });

  /**
   * The other direction, which is the one that actually broke. Once a vendor is
   * pinned, the pin OVERRIDES the allow-list for that vendor: `checkAuthorize`
   * demands the redirect be in the client's own list as well. So an allow-list
   * entry on a pinned vendor's host that the pin omits is unreachable by that
   * vendor and answered with a non-redirectable 400 — ChatGPT saw a dead window
   * rather than an error. That was live from 548c1c5 (2026-09-02) until
   * 2026-09-16 and no test could see it, because the subset above runs the
   * other way.
   *
   * What this asserts, exactly: no https allow-list entry on a pinned host is
   * carried by NO pin. Deliberately not the stronger "each vendor carries every
   * entry on its own host" — `chatgpt.com` has two pinned vendors, ChatGPT and
   * Codex, and neither should be forced to claim the other's callbacks. Scoped
   * to pinned hosts because an entry serving a DCR-only vendor is legitimate
   * and has no pin by definition.
   */
  it('no allow-listed redirect on a pinned host is orphaned', () => {
    const pinnedHosts = new Set(
      [...KNOWN_CLIENTS.values()].flatMap((c) => c.redirectUris.map((u) => new URL(u).host)),
    );
    const pinned = new Set([...KNOWN_CLIENTS.values()].flatMap((c) => [...c.redirectUris]));
    for (const uri of ALLOWED_REDIRECTS) {
      const { host, protocol } = new URL(uri);
      if (protocol !== 'https:' || !pinnedHosts.has(host)) continue;
      expect(pinned.has(uri), `${uri} is allow-listed but no pin on ${host} carries it`).toBe(true);
    }
  });

  it('resolves without touching the network, even when fetch would throw', async () => {
    const spy = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new TypeError('fetch failed');
    });
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
    const spy = stubHttpsRequest(() => ({
      status: 403,
      headers: { 'content-type': 'text/html; charset=UTF-8', 'cf-mitigated': 'challenge' },
      body: '<html>Just a moment…</html>',
    }));
    expect(await resolveClient(CLAUDE)).not.toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('pins an exact string, so lookalikes fall through to the fetch path', async () => {
    const spy = serveClientMetadata();
    for (const lookalike of [
      'https://claude.ai/oauth/mcp-oauth-client-metadata/',
      'https://claude.ai.evil.test/oauth/mcp-oauth-client-metadata',
    ]) {
      expect(await resolveClient(lookalike)).toBeNull();
    }
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it('answers Claude Code on a loopback port with no fetch at all (US-32 AC21)', async () => {
    const spy = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new TypeError('fetch failed');
    });
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

  /**
   * The request below is the one `codex mcp login health` actually sent on
   * 2026-09-09, ephemeral port and all: Codex asks by CIMD document, not DCR,
   * and its callback is a loopback port it binds at login. Pinning the document
   * gives the counter a `codex` label of its own — before this it arrived as
   * `other`, indistinguishable from any dynamically-registered client.
   */
  it('answers Codex on its own loopback port with no fetch at all (US-32 AC30)', async () => {
    const spy = vi.spyOn(https, 'request').mockImplementation(() => {
      throw new TypeError('fetch failed');
    });
    const client = (await resolveClient(CODEX))!;
    expect(client).toEqual({
      clientId: CODEX,
      name: 'Codex',
      label: 'codex',
      redirectUris: ['http://127.0.0.1/callback', 'http://localhost/callback'],
    });
    const checked = checkAuthorize(new URLSearchParams({
      redirect_uri: 'http://127.0.0.1:57246/callback',
      response_type: 'code',
      code_challenge: 'dSyW9SK9nqHXE-fKkAKFhuYPzISi5eaD3rZ3w41Yu7w',
      code_challenge_method: 'S256',
      scope: 'health.read health.append',
    }), client);
    expect(checked.ok).toBe(true);
    expect(spy).not.toHaveBeenCalled();
  });

  it('does not lend Codex the ChatGPT connector\u2019s redirect, or the reverse', () => {
    // Two OpenAI clients, two identities: a web callback is not a loopback one.
    expect(redirectMatches('http://127.0.0.1/callback', 'https://chatgpt.com/connector_platform_oauth_redirect')).toBe(false);
    expect(redirectMatches('https://chatgpt.com/connector_platform_oauth_redirect', 'http://127.0.0.1:57246/callback')).toBe(false);
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

/** A well-formed `/authorize` query for a pinned client, with one field bent. */
function authorizeParams(over: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({
    redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
    response_type: 'code',
    code_challenge: 'a'.repeat(43),
    code_challenge_method: 'S256',
    ...over,
  });
}

/**
 * US-32 AC34. `checkAuthorize` decided WHY it refused and threw the word away,
 * leaving the route to guess from an English description — and the counter
 * with nothing it could group by. Each branch now returns a closed word, and
 * each one is pinned here: a branch whose reason drifts is a query that
 * silently reads zero.
 */
describe('a refusal names the check that failed (US-32 AC34)', () => {
  const CLAUDE = 'https://claude.ai/oauth/mcp-oauth-client-metadata';

  const cases: Array<[string, URLSearchParams]> = [
    ['redirect-uri', authorizeParams({ redirect_uri: 'https://evil.test/cb' })],
    ['response-type', authorizeParams({ response_type: 'token' })],
    ['pkce', authorizeParams({ code_challenge_method: 'plain' })],
    ['code-challenge', authorizeParams({ code_challenge: 'short' })],
    ['state-too-long', authorizeParams({ state: 'S'.repeat(MAX_STATE_LENGTH + 1) })],
    ['resource', authorizeParams({ resource: 'https://someone-else.test/mcp' })],
  ];

  for (const [reason, params] of cases) {
    it(`answers \`${reason}\``, () => {
      const checked = checkAuthorize(params, KNOWN_CLIENTS.get(CLAUDE)!);
      expect(checked).toMatchObject({ ok: false, reason });
    });
  }

  /**
   * A client that serialises every parameter it knows sends `resource=` with
   * nothing in it. That names no audience, so it is absent — refusing it is
   * refusing a connection over punctuation.
   */
  it('takes an empty `resource=` as absent, not as a foreign audience', () => {
    expect(checkAuthorize(authorizeParams({ resource: '' }), KNOWN_CLIENTS.get(CLAUDE)!).ok).toBe(true);
  });
});

describe('a refused redirect names how it missed (US-32 AC48)', () => {
  it('names each branch, and never the URL', () => {
    const registered = ['https://claude.ai/api/mcp/auth_callback', 'http://localhost/callback'];
    expect(redirectMiss(registered, '')).toBe('missing');
    expect(redirectMiss(registered, 'not a url')).toBe('unknown-host');
    expect(redirectMiss(registered, 'https://evil.test/cb')).toBe('unknown-host');
    expect(redirectMiss(registered, 'https://claude.ai/elsewhere')).toBe('known-host-other-path');
    expect(redirectMiss(registered, 'http://localhost:4567/elsewhere')).toBe('loopback-other-path');
    // Wrong scheme on a registered loopback host is still a loopback miss (Codex R2).
    expect(redirectMiss(registered, 'https://localhost:4567/callback')).toBe('loopback-other-path');
    // Judged by the registered side, so a fragment or userinfo on a loopback host reads the same.
    expect(redirectMiss(registered, 'http://localhost/callback#f')).toBe('loopback-other-path');
    expect(redirectMiss(registered, 'http://user@localhost/callback')).toBe('loopback-other-path');
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

  /** The consent press re-seals the state to carry the provider nonce. */
  function pressConnect(sealed: string, nowMs?: number): string {
    const opened = unpackSealed<StatePayload>('state', sealed, nowMs)!;
    return packSealed('state', opened.clientId, { ...opened, nonce: 'n'.repeat(43) });
  }

  it('returns a 600-character state byte-identical, the length OpenAI actually sends', () => {
    const state = 'S'.repeat(600);
    const checked = checkAuthorize(authorizeParams({ state }), KNOWN_CLIENTS.get(CHATGPT_STATE)!);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    expect(checked.request.clientState).toBe(state);
  });

  it('carries that state through the seal and back out unchanged', () => {
    const state = 'S'.repeat(MAX_STATE_LENGTH);
    const checked = checkAuthorize(authorizeParams({ state }), KNOWN_CLIENTS.get(CHATGPT_STATE)!);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const sealed = sealState(checked.request, 'dropbox', Date.now());
    const opened = unpackSealed<StatePayload>('state', sealed);
    expect(opened?.clientState).toBe(state);
  });

  it('refuses one character over the cap rather than truncating it', () => {
    const checked = checkAuthorize(
      authorizeParams({ state: 'S'.repeat(MAX_STATE_LENGTH + 1) }),
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
      authorizeParams({ state: 'S'.repeat(MAX_STATE_LENGTH) }),
      KNOWN_CLIENTS.get(CHATGPT_STATE)!,
    );
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    // The cookie the callback actually reads carries the 43-byte consent nonce.
    const sealed = pressConnect(sealState(checked.request, 'dropbox', Date.now()));
    const cookie = `__Host-mcp-state=${sealed}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=${STATE_LIFETIME_SECONDS}`;
    expect(cookie.length).toBeLessThan(4096);
  });

  /**
   * US-32 AC14. The budget covers the WHOLE consent trip, because `sealState`
   * stamps `exp` at the authorize GET and `consentGiven` re-seals without
   * restamping. That is load-bearing and was untested: a refactor that
   * restamped by accident would have passed CI and quietly doubled the window.
   */
  it('gives the whole consent trip half an hour, not ten minutes', () => {
    // The clock test below is written RELATIVE to the constant, so reverting
    // 30 to 10 left the whole suite green. The number is itself the policy.
    expect(STATE_LIFETIME_SECONDS).toBe(30 * 60);
  });

  it('runs the state clock from the authorize GET, not from the consent press', () => {
    const t0 = Date.parse('2026-09-16T00:00:00.000Z');
    const checked = checkAuthorize(authorizeParams({ state: 'client-state' }), KNOWN_CLIENTS.get(CHATGPT_STATE)!);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const atGet = sealState(checked.request, 'dropbox', t0);

    // `exp` must survive the press.
    const afterPress = pressConnect(atGet, t0);

    const fromGet = (seconds: number) => t0 + seconds * 1000;
    const inside = fromGet(STATE_LIFETIME_SECONDS - 5 * 60);
    const outside = fromGet(STATE_LIFETIME_SECONDS + 5 * 60);
    expect(unpackSealed<StatePayload>('state', afterPress, inside)).not.toBeNull();
    expect(unpackSealed<StatePayload>('state', afterPress, outside)).toBeNull();
    // ...and pressing Connect late does not buy a fresh budget.
    expect(unpackSealed<StatePayload>('state', atGet, outside)).toBeNull();
  });
});
