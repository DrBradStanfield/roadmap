/**
 * US-32 AC38 · the reviewer secrets' tools: the pure parts of
 * `mcp-reviewer-token.ts` and `mcp-reviewer-check.mjs`. Nothing here reaches
 * Dropbox or Fly: every outside call is a stub.
 */
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeUrl,
  generatePassword,
  groupPassword,
  isPassword,
  isSyntheticRecord,
  mint,
  password,
  PASSWORD_ALPHABET,
  PASSWORD_LENGTH,
  passwordHash,
  secretLines,
} from './mcp-reviewer-token';
import { check } from './mcp-reviewer-check.mjs';
import { reviewerConfigured, reviewerLoginMatches } from '../app/lib/mcp-reviewer.server';

const SYNTHETIC = { schemaVersion: 1, profile: { sex: 'male', birthYear: 1979, heightCm: 178 } };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('US-32 AC38 — the reviewer password', () => {
  it('draws 26 characters from a 32-symbol alphabet with no l, 1, o or 0', () => {
    expect(PASSWORD_ALPHABET).toHaveLength(32);
    expect(new Set(PASSWORD_ALPHABET).size).toBe(32);
    for (const ambiguous of ['l', '1', 'o', '0']) expect(PASSWORD_ALPHABET).not.toContain(ambiguous);
    expect(PASSWORD_ALPHABET).toMatch(/^[a-z2-9]+$/);
    for (let i = 0; i < 50; i++) {
      const generated = generatePassword();
      expect(generated).toHaveLength(PASSWORD_LENGTH);
      expect(isPassword(generated)).toBe(true);
    }
    expect(PASSWORD_LENGTH * Math.log2(PASSWORD_ALPHABET.length)).toBeGreaterThanOrEqual(128);
  });

  it('maps each random byte onto the alphabet without bias (256 is a multiple of 32)', () => {
    const bytes = Buffer.from(Array.from({ length: PASSWORD_LENGTH }, (_, i) => i * 37 % 256));
    const generated = generatePassword(() => bytes);
    expect([...generated]).toEqual([...bytes].map((byte) => PASSWORD_ALPHABET[byte % 32]));
  });

  it('shows the password in groups of four', () => {
    expect(groupPassword('abcdefghijkmnpqrstuvwxyz23')).toBe('abcd efgh ijkm npqr stuv wxyz 23');
  });

  it('stages the hash the server checks: the normalised password, so a typed grouping still signs in', () => {
    const plain = 'abcdefghijkmnpqrstuvwxyz23';
    expect(passwordHash('ABCD EFGH-IJKM npqr stuv wxyz 23')).toBe(crypto.createHash('sha256').update(plain).digest('hex'));
    const generated = generatePassword();
    vi.stubEnv('MCP_REVIEWER_USERNAME', 'openaireviewer');
    vi.stubEnv('MCP_REVIEWER_PASSWORD_SHA256', passwordHash(generated));
    vi.stubEnv('MCP_REVIEWER_DROPBOX_RT', 'rt');
    expect(reviewerConfigured()).toBe(true);
    expect(reviewerLoginMatches('OpenAIReviewer', groupPassword(generated).toUpperCase())).toBe(true);
  });

  it('stages the username and the hash, never the password, and shows a new one once', async () => {
    const staged: string[] = [];
    const shown: string[] = [];
    await password({ username: 'openaireviewer', existing: '', stage: async (lines: string) => { staged.push(lines); }, show: (g: string) => shown.push(g) });
    expect(shown).toHaveLength(1);
    const typed = shown[0];
    expect(staged).toEqual([`MCP_REVIEWER_USERNAME=openaireviewer\nMCP_REVIEWER_PASSWORD_SHA256=${passwordHash(typed)}\n`]);
    expect(staged[0]).not.toContain(typed.replace(/ /g, ''));
  });

  it('re-stages a password re-entered to keep it, without showing it', async () => {
    const staged: string[] = [];
    const show = vi.fn();
    await password({ username: 'openaireviewer', existing: 'ABCD efgh ijkm npqr stuv wxyz 23', stage: async (lines: string) => { staged.push(lines); }, show });
    expect(show).not.toHaveBeenCalled();
    expect(staged[0]).toContain(`MCP_REVIEWER_PASSWORD_SHA256=${passwordHash('abcdefghijkmnpqrstuvwxyz23')}`);
  });

  it('refuses a username with an @ and a re-entered password of the wrong shape', async () => {
    const stage = vi.fn();
    await expect(password({ username: 'me@example.com', existing: '', stage, show: vi.fn() })).rejects.toThrow('one plain lowercase word');
    await expect(password({ username: 'openaireviewer', existing: 'too short', stage, show: vi.fn() })).rejects.toThrow('not a reviewer password');
    expect(stage).not.toHaveBeenCalled();
  });
});

describe('US-32 AC38 — the staged lines', () => {
  it('writes NAME=VALUE lines for flyctl secrets import', () => {
    expect(secretLines({ MCP_REVIEWER_USERNAME: 'openaireviewer', MCP_REVIEWER_DROPBOX_RT: 'sl.abc-123_x' })).toBe(
      'MCP_REVIEWER_USERNAME=openaireviewer\nMCP_REVIEWER_DROPBOX_RT=sl.abc-123_x\n',
    );
  });

  it('refuses a value that could break or forge a line, and an empty one', () => {
    expect(() => secretLines({ MCP_REVIEWER_DROPBOX_RT: 'a\nMCP_SEAL_KEYS=evil' })).toThrow('MCP_REVIEWER_DROPBOX_RT');
    expect(() => secretLines({ MCP_REVIEWER_DROPBOX_RT: 'a\rb' })).toThrow();
    expect(() => secretLines({ MCP_REVIEWER_DROPBOX_RT: '' })).toThrow();
    expect(() => secretLines({ 'bad name': 'x' })).toThrow();
  });

  it('never names the secret value in the error', () => {
    try {
      secretLines({ MCP_REVIEWER_DROPBOX_RT: 'super-secret\nx' });
    } catch (error) {
      expect(String((error as Error).message)).not.toContain('super-secret');
    }
  });
});

describe('US-32 AC38 — minting the reviewer token', () => {
  it('asks Dropbox for an offline token with the live scopes and no redirect', () => {
    const url = new URL(authorizeUrl('app-key'));
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(url.searchParams.get('token_access_type')).toBe('offline');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('files.content.read files.content.write files.metadata.read');
    expect(url.searchParams.has('redirect_uri')).toBe(false);
  });

  it('knows the synthetic record and nothing else', () => {
    expect(isSyntheticRecord(SYNTHETIC)).toBe(true);
    expect(isSyntheticRecord({ profile: { sex: 'male', birthYear: 1980, heightCm: 178 } })).toBe(false);
    expect(isSyntheticRecord('not a record')).toBe(false);
    expect(isSyntheticRecord(null)).toBe(false);
  });

  /** Dropbox's token, download and revoke endpoints on the global fetch, answering as each case asks. */
  function dropbox({ accountId, record }: { accountId: string; record: string | null }) {
    const calls: string[] = [];
    const fetch = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
      calls.push(String(url));
      if (String(url).endsWith('/oauth2/token')) {
        const body = new URLSearchParams(String(init.body));
        expect(body.get('grant_type')).toBe('authorization_code');
        expect(body.get('client_secret')).toBe('app-secret');
        expect(body.has('redirect_uri')).toBe(false);
        return Response.json({ access_token: 'new-access', refresh_token: 'new-refresh', account_id: accountId });
      }
      if (String(url).endsWith('/2/files/download')) return record === null ? new Response('', { status: 409 }) : new Response(record);
      if (String(url).endsWith('/2/auth/token/revoke')) {
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer new-access');
        return new Response(null);
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    return { calls };
  }

  const args = { expect: 'dbid:reviewer', appKey: 'app-key', code: 'the-code', appSecret: 'app-secret' };

  it('stages the token on a match: the expected account, and the synthetic record', async () => {
    const { calls } = dropbox({ accountId: 'dbid:reviewer', record: JSON.stringify(SYNTHETIC) });
    const stage = vi.fn(async () => {});
    expect(await mint({ ...args, stage })).toBe('match');
    expect(stage).toHaveBeenCalledWith('MCP_REVIEWER_DROPBOX_RT=new-refresh\n');
    expect(calls.some((url) => url.endsWith('/revoke'))).toBe(false);
  });

  it('stages nothing and revokes the new token for another account — Brad signed in as himself', async () => {
    const { calls } = dropbox({ accountId: 'dbid:brad', record: JSON.stringify(SYNTHETIC) });
    const stage = vi.fn();
    expect(await mint({ ...args, stage })).toBe('mismatch');
    expect(stage).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe('https://api.dropboxapi.com/2/auth/token/revoke');
    // The record of another account is never even read.
    expect(calls.some((url) => url.endsWith('/download'))).toBe(false);
  });

  it('stages nothing and revokes when the folder holds a record that is not the synthetic one', async () => {
    const { calls } = dropbox({ accountId: 'dbid:reviewer', record: JSON.stringify({ profile: { sex: 'female', birthYear: 1990, heightCm: 165 } }) });
    const stage = vi.fn();
    expect(await mint({ ...args, stage })).toBe('mismatch');
    expect(stage).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe('https://api.dropboxapi.com/2/auth/token/revoke');
  });

  it('stages nothing and revokes when the folder holds no record', async () => {
    const { calls } = dropbox({ accountId: 'dbid:reviewer', record: null });
    const stage = vi.fn();
    expect(await mint({ ...args, stage })).toBe('mismatch');
    expect(stage).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe('https://api.dropboxapi.com/2/auth/token/revoke');
  });

  it('answers mismatch when Dropbox will not trade the code', async () => {
    const stage = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad code', { status: 400 })));
    expect(await mint({ ...args, stage })).toBe('mismatch');
    expect(stage).not.toHaveBeenCalled();
  });
});

describe('US-32 AC38 — the in-machine check', () => {
  const env = {
    MCP_REVIEWER_USERNAME: 'openaireviewer',
    MCP_REVIEWER_PASSWORD_SHA256: 'a'.repeat(64),
    MCP_REVIEWER_DROPBOX_RT: 'reviewer-rt',
    DROPBOX_APP_KEY: 'app-key',
    DROPBOX_APP_SECRET: 'app-secret',
  };

  it('refreshes with the server’s own call and lists the folder: ok', async () => {
    const fetch = vi.fn(async (url: string, init: RequestInit = {}) => {
      if (String(url).endsWith('/oauth2/token')) {
        const body = new URLSearchParams(String(init.body));
        expect([body.get('grant_type'), body.get('refresh_token'), body.get('client_id'), body.get('client_secret')]).toEqual(['refresh_token', 'reviewer-rt', 'app-key', 'app-secret']);
        return Response.json({ access_token: 'a' });
      }
      return Response.json({ entries: [] });
    });
    expect(await check({ env, fetch })).toBe('ok');
  });

  it('judges the secrets’ shape exactly as the server does, across the malformed variants', async () => {
    const ok = vi.fn(async (url: string) => (String(url).endsWith('/oauth2/token') ? Response.json({ access_token: 'a' }) : Response.json({})));
    const hash = 'a'.repeat(64);
    const variants: Array<Record<string, string | undefined>> = [
      {},
      { MCP_REVIEWER_USERNAME: undefined },
      { MCP_REVIEWER_USERNAME: '' },
      { MCP_REVIEWER_USERNAME: 'a@b' },
      { MCP_REVIEWER_PASSWORD_SHA256: undefined },
      { MCP_REVIEWER_PASSWORD_SHA256: hash.toUpperCase() },
      { MCP_REVIEWER_PASSWORD_SHA256: hash.slice(1) },
      { MCP_REVIEWER_PASSWORD_SHA256: `${hash}0` },
      { MCP_REVIEWER_PASSWORD_SHA256: 'z'.repeat(64) },
      { MCP_REVIEWER_DROPBOX_RT: undefined },
      { MCP_REVIEWER_DROPBOX_RT: '' },
    ];
    for (const over of variants) {
      const variant = { ...env, ...over };
      for (const name of ['MCP_REVIEWER_USERNAME', 'MCP_REVIEWER_PASSWORD_SHA256', 'MCP_REVIEWER_DROPBOX_RT'] as const) {
        vi.stubEnv(name, variant[name] ?? '');
        if (variant[name] === undefined) delete process.env[name];
      }
      expect(await check({ env: variant, fetch: ok }) === 'ok', JSON.stringify(over)).toBe(reviewerConfigured());
    }
  });

  it('fails on a malformed or missing secret, a refused refresh, or a refused list', async () => {
    const ok = vi.fn(async (url: string) => (String(url).endsWith('/oauth2/token') ? Response.json({ access_token: 'a' }) : Response.json({})));
    expect(await check({ env: { ...env, MCP_REVIEWER_PASSWORD_SHA256: 'A'.repeat(64) }, fetch: ok })).toBe('fail');
    expect(await check({ env: { ...env, MCP_REVIEWER_USERNAME: 'a@b' }, fetch: ok })).toBe('fail');
    expect(await check({ env: { ...env, MCP_REVIEWER_DROPBOX_RT: '' }, fetch: ok })).toBe('fail');
    expect(await check({ env, fetch: vi.fn(async () => new Response('', { status: 400 })) })).toBe('fail');
    expect(await check({ env, fetch: vi.fn(async (url: string) => (String(url).endsWith('/oauth2/token') ? Response.json({ access_token: 'a' }) : new Response('', { status: 401 }))) })).toBe('fail');
    expect(await check({ env, fetch: vi.fn(async () => { throw new Error('offline'); }) })).toBe('fail');
  });
});
