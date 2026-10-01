/**
 * US-32 AC38 · the reviewer secrets' tools: the pure parts of
 * `mcp-reviewer-token.ts` and `mcp-reviewer-check.mjs`. Nothing here reaches
 * Dropbox or Fly: every outside call is a stub.
 */
import crypto from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeUrl,
  flag,
  generatePassword,
  groupPassword,
  isPassword,
  isSyntheticRecord,
  mint,
  outcomeLines,
  password,
  PASSWORD_ALPHABET,
  PASSWORD_LENGTH,
  passwordHash,
  reviewerAddressProblem,
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
  it('asks Dropbox for an offline token with the live scopes plus account_info.read, and no redirect', () => {
    const url = new URL(authorizeUrl('app-key'));
    expect(url.origin + url.pathname).toBe('https://www.dropbox.com/oauth2/authorize');
    expect(url.searchParams.get('token_access_type')).toBe('offline');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('files.content.read files.content.write files.metadata.read account_info.read');
    expect(url.searchParams.has('redirect_uri')).toBe(false);
  });

  it('knows the synthetic record and nothing else', () => {
    expect(isSyntheticRecord(SYNTHETIC)).toBe(true);
    expect(isSyntheticRecord({ profile: { sex: 'male', birthYear: 1980, heightCm: 178 } })).toBe(false);
    expect(isSyntheticRecord('not a record')).toBe(false);
    expect(isSyntheticRecord(null)).toBe(false);
  });

  // Placeholder addresses only: the reviewer is a plus-address of the scratch mailbox.
  const REVIEWER = { email: 'User+Reviewer@Example.com', email_verified: true };

  /** Dropbox's token, account, download and revoke endpoints on the global fetch, answering as each case asks. */
  function dropbox({ accountId = 'dbid:reviewer', account = REVIEWER as object | Response, record = JSON.stringify(SYNTHETIC) as string | null, revokeOk = true } = {}) {
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
      if (String(url).endsWith('/2/users/get_current_account')) {
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer new-access');
        return account instanceof Response ? account : Response.json(account);
      }
      if (String(url).endsWith('/2/files/download')) return record === null ? new Response('', { status: 409 }) : new Response(record);
      if (String(url).endsWith('/2/auth/token/revoke')) {
        expect((init.headers as Record<string, string>).Authorization).toBe('Bearer new-access');
        return revokeOk ? new Response('null') : new Response('', { status: 500 });
      }
      throw new Error(`unexpected ${url}`);
    });
    vi.stubGlobal('fetch', fetch);
    return { calls };
  }

  const args = { email: ' user+reviewer@example.COM ', appKey: 'app-key', code: 'the-code', appSecret: 'app-secret' };
  const REVOKE = 'https://api.dropboxapi.com/2/auth/token/revoke';

  it('stages the token on a match: the typed email (trimmed, any case), verified, and the synthetic record', async () => {
    const { calls } = dropbox();
    const stage = vi.fn(async () => {});
    expect(await mint({ ...args, stage })).toEqual({ result: 'match', accountId: 'dbid:reviewer' });
    expect(stage).toHaveBeenCalledWith('MCP_REVIEWER_DROPBOX_RT=new-refresh\n');
    expect(calls.some((url) => url.endsWith('/revoke'))).toBe(false);
  });

  it('with --expect, stages only when the account id matches too', async () => {
    dropbox();
    const stage = vi.fn(async () => {});
    expect(await mint({ ...args, expect: 'dbid:reviewer', stage })).toEqual({ result: 'match', accountId: 'dbid:reviewer' });
    expect(stage).toHaveBeenCalledOnce();
  });

  const failures: Array<[string, Parameters<typeof dropbox>[0], Partial<typeof args> & { expect?: string }, string]> = [
    ['another account (Brad signed in as himself)', { account: { email: 'someone@else.com', email_verified: true } }, {}, 'email'],
    ['the scratch account: its base address, where the reviewer\'s plus-address was typed', { account: { email: 'user@example.com', email_verified: true } }, {}, 'email'],
    ['the reviewer account where the base address was typed', {}, { email: 'user@example.com' }, 'email'],
    ['a typed domain that the account address merely contains', { account: { email: 'user@example.com', email_verified: true } }, { email: 'example.com' }, 'email'],
    ['a typed address that merely contains the account address', {}, { email: 'user+reviewer@example.com.au' }, 'email'],
    ['an unverified email', { account: { email: 'user+reviewer@example.com', email_verified: false } }, {}, 'unverified'],
    ['an account with no email', { account: { email_verified: true } }, {}, 'email'],
    ['an account Dropbox will not describe', { account: new Response('', { status: 500 }) }, {}, 'lookup'],
    ['an empty typed email', { account: { email: '', email_verified: true } }, { email: '  ' }, 'email'],
    ['the wrong account id with --expect', {}, { expect: 'dbid:other' }, 'account-id'],
  ];
  for (const [name, answers, over, gate] of failures) {
    it(`stages nothing, awaits the revoke and never reads the record for ${name} (gate: ${gate})`, async () => {
      const { calls } = dropbox(answers);
      const stage = vi.fn();
      expect(await mint({ ...args, ...over, stage })).toEqual({ result: 'mismatch', gate, revoked: true });
      expect(stage).not.toHaveBeenCalled();
      expect(calls.at(-1)).toBe(REVOKE);
      expect(calls.some((url) => url.endsWith('/download'))).toBe(false);
    });
  }

  it('stages nothing and revokes when the right account holds a record that is not the synthetic one', async () => {
    const { calls } = dropbox({ record: JSON.stringify({ profile: { sex: 'female', birthYear: 1990, heightCm: 165 } }) });
    const stage = vi.fn();
    expect(await mint({ ...args, stage })).toEqual({ result: 'mismatch', gate: 'record', revoked: true });
    expect(stage).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe(REVOKE);
  });

  it('stages nothing and revokes when the folder holds no record', async () => {
    const { calls } = dropbox({ record: null });
    const stage = vi.fn();
    expect(await mint({ ...args, stage })).toEqual({ result: 'mismatch', gate: 'record', revoked: true });
    expect(stage).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe(REVOKE);
  });

  it('revokes the matched token when staging fails, and reports the revoke', async () => {
    const { calls } = dropbox();
    const stage = vi.fn(async () => { throw new Error('flyctl exited 1'); });
    expect(await mint({ ...args, stage })).toEqual({ result: 'staging failed', revoked: true });
    expect(stage).toHaveBeenCalledOnce();
    expect(calls.at(-1)).toBe(REVOKE);
    dropbox({ revokeOk: false });
    expect(await mint({ ...args, stage })).toEqual({ result: 'staging failed', revoked: false });
  });

  it('reports a revoke Dropbox refused', async () => {
    dropbox({ account: { email: 'someone@else.com', email_verified: true }, revokeOk: false });
    expect(await mint({ ...args, stage: vi.fn() })).toEqual({ result: 'mismatch', gate: 'email', revoked: false });
  });

  it('answers mismatch with nothing to revoke when Dropbox will not trade the code', async () => {
    const stage = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })));
    expect(await mint({ ...args, stage })).toEqual({ result: 'mismatch', gate: 'code' });
    expect(stage).not.toHaveBeenCalled();
  });

  it('names the scope when Dropbox refuses it at the token exchange', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_scope' }, { status: 400 })));
    expect(await mint({ ...args, stage: vi.fn() })).toEqual({ result: 'mismatch', gate: 'scope' });
  });

  it('names the scope, and revokes, when the token lacks account_info.read', async () => {
    const { calls } = dropbox({ account: Response.json({ error: { '.tag': 'missing_scope', required_scope: 'account_info.read' } }, { status: 401 }) });
    const stage = vi.fn();
    expect(await mint({ ...args, stage })).toEqual({ result: 'mismatch', gate: 'scope', revoked: true });
    expect(stage).not.toHaveBeenCalled();
    expect(calls.at(-1)).toBe(REVOKE);
  });
});

describe('US-32 AC38 — what --mint prints', () => {
  it('refuses, before any Dropbox step, an address with no plus in its local part', () => {
    expect(reviewerAddressProblem('user+reviewer@example.com')).toBeNull();
    expect(reviewerAddressProblem(' User+Reviewer@Example.com ')).toBeNull();
    for (const typed of ['user@example.com', 'example.com', '', 'user@ex+ample.com', '+@']) {
      expect(reviewerAddressProblem(typed), typed).toMatch(/plus-address.*scratch account/);
    }
  });

  it('names the gate that failed, never an address, and the revoke result', () => {
    expect(outcomeLines({ result: 'mismatch', gate: 'unverified', revoked: true })).toEqual(['mismatch: unverified', 'revoked']);
    expect(outcomeLines({ result: 'mismatch', gate: 'email', revoked: false })).toEqual([
      'mismatch: email',
      'REVOKE FAILED: remove the app at dropbox.com/account/connected_apps',
    ]);
    expect(outcomeLines({ result: 'mismatch', gate: 'code' })).toEqual(['mismatch: code']);
    const scope = outcomeLines({ result: 'mismatch', gate: 'scope', revoked: true });
    expect(scope[0]).toBe('mismatch: scope');
    expect(scope[1]).toContain('account_info.read');
    expect(scope[2]).toBe('revoked');
  });

  it('on a staging failure, reports the revoke and the unset that clears the staged secret', () => {
    expect(outcomeLines({ result: 'staging failed', revoked: true })).toEqual([
      'staging failed',
      'revoked',
      'Clean up: flyctl secrets unset -a health-tool-edu MCP_REVIEWER_DROPBOX_RT --stage',
    ]);
  });

  it('on a match, prints the account id to pass as --expect', () => {
    const lines = outcomeLines({ result: 'match', accountId: 'dbid:reviewer' });
    expect(lines[0]).toBe('match');
    expect(lines[1]).toContain('--expect dbid:reviewer');
  });
});

describe('US-32 AC38 — the flags', () => {
  it('reads a flag and its value', () => {
    expect(flag(['--mint', '--expect', 'dbid:x'], '--expect')).toBe('dbid:x');
    expect(flag(['--mint'], '--expect')).toBeUndefined();
  });

  it('refuses the --flag=value form', () => {
    expect(() => flag(['--mint', '--expect=dbid:x'], '--expect')).toThrow('--expect <value>');
    expect(() => flag(['--mint', '--app-key=k'], '--app-key')).toThrow('--app-key <value>');
  });

  it('refuses a missing value and one that is another flag', () => {
    expect(() => flag(['--mint', '--expect'], '--expect')).toThrow('--expect needs a value');
    expect(() => flag(['--mint', '--expect', '--app-key', 'k'], '--expect')).toThrow('--expect needs a value');
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
