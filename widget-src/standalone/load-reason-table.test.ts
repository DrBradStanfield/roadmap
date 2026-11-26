// @vitest-environment jsdom
/**
 * US-10 AC18 (root fix R6, PR 4): the sign-in state a failed load lands in
 * (connect.ts `lostAtLoad`, through `startOnBackend`) is read from the error's
 * typed `reason`, never its status. The table runs every outcome against every
 * reason, each raised with no status, so only the typed field can decide.
 * A Dropbox load asks for a new sign-in only for `auth` or `reconnect`; Google
 * Drive always offers its sign-in; GitHub and WebDAV always retry on reload.
 * In-memory adapter, synthetic errors, no network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryAdapter } from '@roadmap/health-core/memory-adapter';
import { StorageError, type StorageFailureReason, type StorageOutcome } from '@roadmap/health-core/adapter';
import { startOnBackend, type ResolvedBackend } from './connect';

vi.mock('../src/lib/sentry', () => ({ Sentry: { captureException: () => {} } }));

const OUTCOMES: StorageOutcome[] = ['refused', 'may-have-landed', 'no-answer'];
const REASONS: Array<StorageFailureReason | undefined> = [undefined, 'auth', 'reconnect', 'forbidden', 'rate-limited', 'storage-full', 'not-found'];
const SIGN_IN_AGAIN: ReadonlySet<StorageFailureReason | undefined> = new Set(['auth', 'reconnect']);

/** The sign-in state the load ends in when the cloud's first open throws `error`. */
async function landsIn(backend: ResolvedBackend['backend'], error: StorageError): Promise<string> {
  const adapter = new MemoryAdapter();
  const started = await startOnBackend({ adapter, backend }, async (used) => {
    if (used === adapter) throw error; // the on-device fallback opens
  });
  return started.reconnect?.kind ?? 'none';
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('US-10 AC18: a failed load reads the typed reason (outcome x reason, no status)', () => {
  const rows = OUTCOMES.flatMap((outcome) => REASONS.map((reason) => [outcome, reason ?? 'none', reason] as const));
  it.each(rows)('%s, reason %s', async (outcome, _label, reason) => {
    const error = () => new StorageError('synthetic', undefined, undefined, undefined, reason, outcome);
    expect(await landsIn('dropbox', error())).toBe(SIGN_IN_AGAIN.has(reason) ? 'signedOut' : 'unreachable');
    expect(await landsIn('google-drive', error())).toBe('signedOut');
    expect(await landsIn('github', error())).toBe('unreachable');
    expect(await landsIn('self-host', error())).toBe('unreachable');
  });
});
