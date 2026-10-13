/**
 * US-36 AC9 · US-35 AC7 — the two-call step receipts, piece by piece.
 *
 * A step is MACed, not sealed: nothing in it is secret, and a 400-character
 * blob read to ChatGPT as a disguised payload (2026-10-07). What is pinned
 * here: a proposal receipt is UUID-shaped lowercase hex, its MAC covers every
 * input, its window is one table, rotation works both ways, and a step key is
 * never a blob key. The flow over the wire is `mcp.hosted-guards.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimProposal, resetMcpMemory } from './mcp-grants.server';
import { typeKey } from './mcp-seal.server';
import { issueProposal, openProposal, openStep, signStep, STEP_WINDOWS, stepKey } from './mcp-step.server';

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

  it('one table: an import has no pause, an hour of life, and the same skew rule (US-35 AC7)', () => {
    expect(STEP_WINDOWS.import).toEqual({ nbfSeconds: 0, ttlSeconds: 60 * 60, macHex: 32 });
    const fields = ['payload-id', 'payload-hash'];
    /** An import step signed at `issuedMs`, opened at `nowMs`. */
    const importAt = (issuedMs: number, nowMs: number) => {
      const { mac, issued } = signStep('import', fields, CONN, AUDIENCE, issuedMs);
      return openStep('import', fields, CONN, mac, issued, AUDIENCE, nowMs).status;
    };
    expect(importAt(NOW, NOW)).toBe('ok');
    expect(importAt(NOW + 30_000, NOW)).toBe('ok');
    expect(importAt(NOW + 61_000, NOW)).toBe('invalid');
    expect(importAt(NOW, NOW + 3600_000)).toBe('ok');
    expect(importAt(NOW, NOW + 3601_000)).toBe('expired');
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
  it('a receipt spends once per connection; another connection’s spend does not burn this one’s', () => {
    const { receipt } = issueProposal(SUBJECT, CONN, AUDIENCE, NOW);
    expect(claimProposal(receipt, 'conn-b', ttlSeconds * 1000, LATER)).toBe(true);
    expect(claimProposal(receipt, CONN, ttlSeconds * 1000, LATER)).toBe(true);
    expect(claimProposal(receipt, CONN, ttlSeconds * 1000, LATER + 1000)).toBe(false);
  });
});
