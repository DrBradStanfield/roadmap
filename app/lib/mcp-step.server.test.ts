/**
 * US-36 AC9 · US-35 AC7 — the two-call step receipts, piece by piece.
 *
 * A step is MACed, not sealed: nothing in it is secret, and a 400-character
 * blob read to ChatGPT as a disguised payload (2026-10-07). What is pinned
 * here: a proposal receipt is UUID-shaped lowercase hex, its MAC covers every
 * input, its window is one table, rotation works both ways, and a step key is
 * never a blob key. The flow over the wire is `mcp.hosted-guards.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const claims = vi.hoisted(() => ({ state: null as null | import('./single-use-claims.test-helpers').ClaimsState }));
vi.mock('./supabase-client.server', async (actual) => {
  const helpers = await import('./single-use-claims.test-helpers');
  claims.state ??= helpers.newClaimsState();
  return { ...(await actual<object>()), supabaseAdmin: helpers.claimsAdmin(claims.state) };
});
import { resetClaimsState } from './single-use-claims.test-helpers';
import { claimProposal, resetMcpMemory } from './mcp-grants.server';
import { typeKey } from './mcp-seal.server';
import { clockFrom, earlyRefusal, issueProposal, openProposal, openStep, PERMANENT_WRITE_PAUSE_SECONDS, signStep, STEP_WINDOWS, stepKey } from './mcp-step.server';

const KEY_A = Buffer.alloc(32, 1).toString('base64');
const KEY_B = Buffer.alloc(32, 2).toString('base64');
const AUDIENCE = { clientId: 'https://claude.ai/client', resource: 'https://mcp.example.test/mcp' };
const SUBJECT = 'subject-hash';
const CONN = 'connection-hash';
const NOW = Date.parse('2026-10-07T01:07:40.000Z');
const { nbfSeconds, ttlSeconds } = STEP_WINDOWS.proposal;
/** After the pause, inside the window. */
const LATER = NOW + (nbfSeconds + 1) * 1000;

beforeEach(() => {
  process.env.MCP_SEAL_KEYS = KEY_A;
  resetMcpMemory();
  resetClaimsState(claims.state!);
});
afterEach(() => {
  delete process.env.MCP_SEAL_KEYS;
});

const open = (receipt: string, overrides: { subject?: string; conn?: string; audience?: typeof AUDIENCE; now?: number } = {}) =>
  openProposal(receipt, overrides.subject ?? SUBJECT, overrides.conn ?? CONN, overrides.audience ?? AUDIENCE, overrides.now ?? LATER).status;

/** One hex character of `receipt` at `at`, changed to another. */
const flip = (receipt: string, at: number) => receipt.slice(0, at) + (receipt[at] === '0' ? '1' : '0') + receipt.slice(at + 1);

describe('US-36 AC9 — a proposal receipt is UUID-shaped, and its MAC covers every input', () => {
  it('round-trips: 36 characters of lowercase hex, the issue time in front', () => {
    const { receipt, notBefore } = issueProposal(SUBJECT, CONN, AUDIENCE, NOW);
    const issued = Math.floor(NOW / 1000);
    expect(receipt).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(parseInt(receipt.slice(0, 8), 16)).toBe(issued);
    expect(notBefore).toBe(new Date((issued + nbfSeconds) * 1000).toISOString());
    expect(openProposal(receipt, SUBJECT, CONN, AUDIENCE, LATER)).toEqual({ status: 'ok', notBefore });
    // Sixteen random bits: two receipts for one call in one second differ.
    expect(issueProposal(SUBJECT, CONN, AUDIENCE, NOW).receipt).not.toBe(receipt);
  });

  it('changing any MAC input gives invalid: the i part, the j part, the MAC part, subject, conn, client, resource', () => {
    const { receipt } = issueProposal(SUBJECT, CONN, AUDIENCE, NOW);
    expect(open(flip(receipt, 7))).toBe('invalid'); // i: the issue time
    expect(open(flip(receipt, 10))).toBe('invalid'); // j: the random bits
    for (const at of [14, 20, 24, 35]) expect(open(flip(receipt, at)), `m at ${at}`).toBe('invalid');
    expect(open(receipt, { subject: 'other-arguments' })).toBe('invalid');
    expect(open(receipt, { conn: 'other-connection' })).toBe('invalid');
    expect(open(receipt, { audience: { ...AUDIENCE, clientId: 'https://chatgpt.com/client' } })).toBe('invalid');
    expect(open(receipt, { audience: { ...AUDIENCE, resource: 'https://other.test/mcp' } })).toBe('invalid');
  });

  it('changing the kind or the issue time gives invalid: an import MAC over the same fields is not a proposal MAC', () => {
    const fields = ['0000000000aa', SUBJECT];
    const proposal = signStep('proposal', fields, CONN, AUDIENCE, NOW);
    const openAs = (kind: 'import' | 'proposal', mac: string, issued = proposal.issued) => openStep(kind, fields, CONN, mac, issued, AUDIENCE, LATER).status;
    expect(openAs('proposal', proposal.mac)).toBe('ok');
    const imported = signStep('import', fields, CONN, AUDIENCE, NOW).mac;
    expect(imported.slice(0, proposal.mac.length)).not.toBe(proposal.mac);
    expect(openAs('proposal', imported.slice(0, proposal.mac.length))).toBe('invalid');
    expect(openAs('import', proposal.mac)).toBe('invalid');
    expect(openAs('proposal', proposal.mac, proposal.issued - 1)).toBe('invalid');
  });

  it('refuses uppercase, padding, whitespace and any other length before anything else', () => {
    const { receipt } = issueProposal(SUBJECT, CONN, AUDIENCE, NOW);
    for (const variant of [receipt.toUpperCase(), ` ${receipt}`, `${receipt} `, `${receipt}\n`, `${receipt}=`, `${receipt}0`, receipt.slice(1), receipt.replace(/-/g, ''), `{${receipt}}`]) {
      expect(open(variant), JSON.stringify(variant)).toBe('invalid');
    }
  });

  it('carries an issue time above 2^31 (after 2038) and parses it back', () => {
    const issuedAt = (2 ** 31 + 12_345) * 1000;
    const { receipt } = issueProposal(SUBJECT, CONN, AUDIENCE, issuedAt);
    const issued = parseInt(receipt.slice(0, 8), 16);
    expect(issued).toBeGreaterThan(2 ** 31);
    expect(issued).toBe(issuedAt / 1000);
    expect(open(receipt, { now: issuedAt + (nbfSeconds + 1) * 1000 })).toBe('ok');
  });
});

describe('US-36 AC9 — the window: early before 10 s, expired after 15 min, a time over a minute ahead is not ours', () => {
  it('9 s is early, 10 s is usable, 15 min is usable, 15 min + 1 s is expired', () => {
    const { receipt } = issueProposal(SUBJECT, CONN, AUDIENCE, NOW);
    expect(open(receipt, { now: NOW + 9_000 })).toBe('early');
    expect(open(receipt, { now: NOW + nbfSeconds * 1000 })).toBe('ok');
    expect(open(receipt, { now: NOW + ttlSeconds * 1000 })).toBe('ok');
    expect(open(receipt, { now: NOW + (ttlSeconds + 1) * 1000 })).toBe('expired');
  });

  it('issued 61 s in our future is invalid; 30 s ahead is skew and counts as early', () => {
    expect(open(issueProposal(SUBJECT, CONN, AUDIENCE, NOW + 61_000).receipt, { now: NOW })).toBe('invalid');
    expect(open(issueProposal(SUBJECT, CONN, AUDIENCE, NOW + 30_000).receipt, { now: NOW })).toBe('early');
  });

  it('one table: an import has the permanent-write pause, an hour of life, and the same skew rule (US-35 AC7, AC19)', () => {
    expect(STEP_WINDOWS.import).toEqual({ nbfSeconds: PERMANENT_WRITE_PAUSE_SECONDS, ttlSeconds: 60 * 60, macHex: 32 });
    expect(STEP_WINDOWS.proposal.nbfSeconds).toBe(PERMANENT_WRITE_PAUSE_SECONDS);
    expect(PERMANENT_WRITE_PAUSE_SECONDS).toBe(10);
    const fields = ['payload-id', 'payload-hash'];
    /** An import step signed at `issuedMs`, opened at `nowMs`. */
    const importAt = (issuedMs: number, nowMs: number) => {
      const { mac, issued } = signStep('import', fields, CONN, AUDIENCE, issuedMs);
      return openStep('import', fields, CONN, mac, issued, AUDIENCE, nowMs);
    };
    const notBefore = new Date(NOW + 10_000).toISOString();
    expect(importAt(NOW, NOW)).toEqual({ status: 'early', notBefore });
    expect(importAt(NOW, NOW + 9_999)).toEqual({ status: 'early', notBefore });
    expect(importAt(NOW, NOW + 10_000)).toEqual({ status: 'ok', notBefore });
    expect(importAt(NOW + 30_000, NOW).status).toBe('early');
    expect(importAt(NOW + 61_000, NOW).status).toBe('invalid');
    expect(importAt(NOW, NOW + 3600_000).status).toBe('ok');
    expect(importAt(NOW, NOW + 3601_000).status).toBe('expired');
  });

  it('clockFrom reads the request time moved on by the real time since, so a step is signed when it is handed back (US-35 AC19)', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(Date.parse('2030-01-01T00:00:00.000Z'));
      const clock = clockFrom(new Date(NOW).toISOString());
      expect(clock()).toBe(NOW);
      vi.setSystemTime(Date.parse('2030-01-01T00:00:15.000Z'));
      expect(clock()).toBe(NOW + 15_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a step opened early is refused in the one sentence every permanent write uses (US-35 AC19)', () => {
    expect(earlyRefusal('2026-10-07T01:07:50.000Z')).toBe(
      'That confirm receipt is not valid yet: it can be used from 2026-10-07T01:07:50.000Z, after the user has answered. Do not retry before then; end your turn. Nothing was written.',
    );
  });
});

describe('US-36 AC9 — keys: rotation in and out, and a step key is never a blob key', () => {
  it('a receipt signed under the previous key opens after a new key is prepended, and dies when the old key is removed', () => {
    const old = issueProposal(SUBJECT, CONN, AUDIENCE, NOW).receipt;
    process.env.MCP_SEAL_KEYS = `${KEY_B},${KEY_A}`; // rotation in: B signs, A still verifies
    const fresh = issueProposal(SUBJECT, CONN, AUDIENCE, NOW).receipt;
    expect(open(old)).toBe('ok');
    expect(open(fresh)).toBe('ok');
    process.env.MCP_SEAL_KEYS = KEY_B; // rotation out
    expect(open(old)).toBe('invalid');
    expect(open(fresh)).toBe('ok');
    process.env.MCP_SEAL_KEYS = KEY_A;
    expect(open(fresh)).toBe('invalid'); // signed with B, which is gone
  });

  it('with no key configured nothing verifies and nothing throws', () => {
    const { receipt } = issueProposal(SUBJECT, CONN, AUDIENCE, NOW);
    delete process.env.MCP_SEAL_KEYS;
    expect(open(receipt)).toBe('invalid');
  });

  it('the HKDF info per step kind differs from every typeKey info (the guard beside mcp-auth.server.test.ts’s per-type one)', () => {
    const key = Buffer.alloc(32, 1);
    const blobKeys = (['state', 'code', 'access', 'refresh'] as const).map((t) => typeKey(key, t).toString('hex'));
    const stepKeys = (['import', 'proposal'] as const).map((k) => stepKey(key, k).toString('hex'));
    expect(new Set([...blobKeys, ...stepKeys]).size).toBe(6);
  });
});

describe('US-36 AC9 — single use is keyed on the whole receipt and the connection', () => {
  it('a receipt spends once per connection; another connection’s spend does not burn this one’s', async () => {
    const { receipt } = issueProposal(SUBJECT, CONN, AUDIENCE, NOW);
    expect(await claimProposal(receipt, 'conn-b', ttlSeconds * 1000, LATER)).toBe('claimed');
    expect(await claimProposal(receipt, CONN, ttlSeconds * 1000, LATER)).toBe('claimed');
    expect(await claimProposal(receipt, CONN, ttlSeconds * 1000, LATER + 1000)).toBe('spent');
    // The shared store still answers once this process forgets.
    resetMcpMemory();
    expect(await claimProposal(receipt, CONN, ttlSeconds * 1000, LATER + 2000)).toBe('spent');
  });
});
