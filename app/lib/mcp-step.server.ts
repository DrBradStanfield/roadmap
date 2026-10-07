/**
 * A step: the second call of a two-call tool carries its receipt back (US-35
 * AC7, US-36 AC9). Nothing in a step is secret; only its integrity matters,
 * so it is an HMAC, not a sealed blob. A 400-character blob read to ChatGPT as
 * an "opaque or disguised payload" and blocked the confirm (2026-10-07). So
 * the receipt is UUID-shaped: an import's is its pending file's own id, with
 * the MAC kept in that file; a proposal's carries its issue time and its MAC.
 */
import crypto from 'node:crypto';
import { sealKeys } from './mcp-config.server';
import { deriveKey, hash, type SealAudience } from './mcp-seal.server';
import { RECEIPT_LIFETIME_SECONDS } from '../../packages/health-core/src/mcp-tools';

export type StepKind = 'import' | 'proposal';

/**
 * One table: issue and verify both read it. An import has no pause. `macHex`
 * is the MAC's length in lowercase hex: 128 bits in an import's pending file,
 * 80 in a proposal receipt.
 */
export const STEP_WINDOWS: Record<StepKind, { nbfSeconds: number; ttlSeconds: number; macHex: number }> = {
  import: { nbfSeconds: 0, ttlSeconds: RECEIPT_LIFETIME_SECONDS, macHex: 32 },
  proposal: { nbfSeconds: 10, ttlSeconds: 15 * 60, macHex: 20 },
};

/** Each kind's MAC exactly as it must arrive, built once from `macHex`. */
const MAC_SHAPE = Object.fromEntries(
  Object.entries(STEP_WINDOWS).map(([kind, { macHex }]) => [kind, new RegExp(`^[0-9a-f]{${macHex}}$`)]),
) as Record<StepKind, RegExp>;

/** How far ahead of our clock an issue time may sit (another machine's clock) and still be ours. */
const STEP_SKEW_SECONDS = 60;

/**
 * A lowercase UUID and nothing else: an import receipt (a `crypto.randomUUID()`,
 * the only id that may name a pending file) and a proposal receipt both have
 * this shape. The groups are a proposal's parts. (`route-helpers`'
 * `isValidUuid` sits behind the Shopify session store, which this layer must
 * not load.)
 */
export const UUID = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/;

/**
 * HKDF-SHA256 per step kind. The info `mcp/<kind>-step/v1` is distinct from
 * every `typeKey` info, so a step key can never be a blob key. Exported for
 * the test that pins that.
 */
export function stepKey(key: Buffer, kind: StepKind): Buffer {
  return deriveKey(key, `mcp/${kind}-step/v1`);
}

/** The MAC under one key: the kind, the issue time, the caller's fields, the connection, then the client and resource hashes, one per line. */
function stepMac(key: Buffer, kind: StepKind, issued: number, fields: readonly string[], conn: string, audience: SealAudience): string {
  const input = [kind, String(issued), ...fields, conn, hash(audience.clientId), hash(audience.resource)].join('\n');
  return crypto.createHmac('sha256', stepKey(key, kind)).update(input, 'utf8').digest('hex').slice(0, STEP_WINDOWS[kind].macHex);
}

/** When a step issued at `issued` (epoch seconds) may first be used. */
const notBeforeOf = (kind: StepKind, issued: number): string => new Date((issued + STEP_WINDOWS[kind].nbfSeconds) * 1000).toISOString();

/** Sign at `nowMs` with the newest key. The issue time is in every MAC, so a window only ever reads a time we signed. */
export function signStep(kind: StepKind, fields: readonly string[], conn: string, audience: SealAudience, nowMs: number): { mac: string; issued: number } {
  const keys = sealKeys();
  if (keys.length === 0) throw new Error('MCP_SEAL_KEYS is not configured');
  const issued = Math.floor(nowMs / 1000);
  return { mac: stepMac(keys[0], kind, issued, fields, conn, audience), issued };
}

/** A step checked: `invalid` (not ours, or not for these inputs), or ours with its window's verdict and the moment it may first be used. */
export type OpenedStep = { status: 'invalid' } | { status: 'ok' | 'early' | 'expired'; notBefore: string };

/**
 * The MAC, then the window, in that order. `mac` must be exactly the kind's
 * length of lowercase hex, and it is compared as those characters, with
 * `timingSafeEqual`: nothing is decoded. Every configured key is tried; a key
 * since removed opens nothing. An issue time more than a minute in the future
 * is not a time we issued; inside that minute it is clock skew, which a
 * proposal's pause covers and an import ignores.
 */
export function openStep(kind: StepKind, fields: readonly string[], conn: string, mac: string, issued: number, audience: SealAudience, nowMs: number): OpenedStep {
  if (!MAC_SHAPE[kind].test(mac)) return { status: 'invalid' };
  const received = Buffer.from(mac, 'latin1');
  let matched = false;
  for (const key of sealKeys()) {
    if (crypto.timingSafeEqual(Buffer.from(stepMac(key, kind, issued, fields, conn, audience), 'latin1'), received)) matched = true;
  }
  if (!matched) return { status: 'invalid' };
  const { nbfSeconds, ttlSeconds } = STEP_WINDOWS[kind];
  if (issued * 1000 > nowMs + STEP_SKEW_SECONDS * 1000) return { status: 'invalid' };
  const notBefore = notBeforeOf(kind, issued);
  if (nowMs > (issued + ttlSeconds) * 1000) return { status: 'expired', notBefore };
  if (nbfSeconds > 0 && nowMs < (issued + nbfSeconds) * 1000) return { status: 'early', notBefore };
  return { status: 'ok', notBefore };
}

/**
 * Mint a confirm receipt for `subject` (the call's identity) on connection
 * `conn`: `iiiiiiii-jjjj-mmmm-mmmm-mmmmmmmmmmmm`, lowercase hex. `i` is the
 * issue time in epoch seconds (32 bits, good until 2106), `j` 16 random bits,
 * `m` 80 bits of MAC over `i` and `j` as written, the call and the connection.
 */
export function issueProposal(subject: string, conn: string, audience: SealAudience, nowMs: number): { receipt: string; notBefore: string } {
  const i = Math.floor(nowMs / 1000).toString(16).padStart(8, '0');
  const j = crypto.randomBytes(2).toString('hex');
  const { mac, issued } = signStep('proposal', [i + j, subject], conn, audience, nowMs);
  return { receipt: `${i}-${j}-${mac.slice(0, 4)}-${mac.slice(4, 8)}-${mac.slice(8)}`, notBefore: notBeforeOf('proposal', issued) };
}

/**
 * Check a confirm receipt against the call it claims to confirm. Anything
 * not exactly `UUID`'s shape is refused before any work. The MAC covers the
 * exact characters received (`i` and `j` verbatim, never a re-encoding).
 */
export function openProposal(receipt: string, subject: string, conn: string, audience: SealAudience, nowMs: number): OpenedStep {
  const parts = UUID.exec(receipt);
  if (!parts) return { status: 'invalid' };
  const [, i, j, m1, m2, m3] = parts;
  return openStep('proposal', [i + j, subject], conn, m1 + m2 + m3, parseInt(i, 16), audience, nowMs);
}
