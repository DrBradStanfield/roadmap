/**
 * US-10 AC20 (lead A34): a storage failure with no words of its own is told from ONE table,
 * keyed by its typed outcome and, where the words differ, its reason. Every sentence is true for
 * its case: a refusal is a refusal, never "did not answer"; an answer with an error status says
 * so; a failure that may have landed says the approved may-have-landed sentence; and a save's
 * write refused after that save's own read never says "Nothing was read". The words depend only
 * on the typed fields, so Dropbox, GitHub, WebDAV and Google Drive read alike.
 */
import { describe, expect, it } from 'vitest';
import { answerOutcome, LANDED_HINT, StorageError, UNREACHABLE_HINT, type StorageFailureReason, type StorageOutcome } from './adapter';
import { MemoryAdapter, MemoryCloud } from './memory-adapter';
import { ROADMAP_DOC } from './roadmap-doc';
import { describeStorageFailure, SyncManager } from './sync-manager';

const P = 'The record in Dropbox';
const RECONNECT = 'Reconnect the provider, which grants access again.';
const LANDED_ACCESS = 'Reconnect the provider, which grants access again. The change may have landed: read the record again before retrying.';

const OUTCOMES = Object.keys({ refused: 1, 'may-have-landed': 1, 'no-answer': 1 } satisfies Record<StorageOutcome, 1>) as StorageOutcome[];
const REASONS = [undefined, ...Object.keys({
  'storage-full': 1, 'not-found': 1, reconnect: 1, auth: 1, forbidden: 1, 'rate-limited': 1, 'writes-stopped': 1,
} satisfies Record<StorageFailureReason, 1>)] as Array<StorageFailureReason | undefined>;

/** [outcome, reason, status, afterRead, message, hint]: every (outcome, reason) pair, with and without a status where it matters. */
type Row = [StorageOutcome, StorageFailureReason | undefined, number | undefined, boolean, string, string];
const ANSWERED_ERROR = `${P} returned an error`;
const UNUSABLE = `${P} returned an answer that could not be used`;
const rows: Row[] = [
  // refused: the provider answered and stored nothing.
  ['refused', undefined, 404, false, `${P} refused the request. Nothing was written`, UNREACHABLE_HINT],
  ['refused', undefined, 409, true, `${P} refused the change. Nothing was written`, UNREACHABLE_HINT],
  ['refused', 'storage-full', 403, true, `${P} refused the change. Nothing was written`, UNREACHABLE_HINT],
  ['refused', 'not-found', undefined, false, `${P} refused the request. Nothing was written`, UNREACHABLE_HINT],
  ['refused', 'reconnect', 400, false, `${P} needs to be reconnected. Nothing was written`, RECONNECT],
  ['refused', 'auth', 401, false, `${P} refused this connection’s access. Nothing was read and nothing was written`, RECONNECT],
  ['refused', 'auth', 401, true, `${P} refused this connection’s access. Nothing was written`, RECONNECT],
  ['refused', 'forbidden', 403, false, `${P} refused this connection’s access. Nothing was read and nothing was written`, RECONNECT],
  ['refused', 'forbidden', 403, true, `${P} refused this connection’s access. Nothing was written`, RECONNECT],
  ['refused', 'rate-limited', 403, false, `${P} refused the request. Nothing was written`, UNREACHABLE_HINT],
  ['refused', 'writes-stopped', undefined, false, 'Saving has stopped here. Nothing was written', 'Sign in again to save here.'],
  // may-have-landed: a write went out; an error status is an answer, and the approved sentence follows.
  ['may-have-landed', undefined, 503, false, ANSWERED_ERROR, LANDED_HINT],
  ['may-have-landed', undefined, undefined, false, UNUSABLE, LANDED_HINT],
  ['may-have-landed', 'storage-full', 507, false, ANSWERED_ERROR, LANDED_HINT],
  ['may-have-landed', 'not-found', undefined, false, UNUSABLE, LANDED_HINT],
  ['may-have-landed', 'reconnect', 500, false, ANSWERED_ERROR, LANDED_HINT],
  ['may-have-landed', 'auth', 401, false, `${P} refused this connection’s access after a change was sent`, LANDED_ACCESS],
  ['may-have-landed', 'forbidden', 403, false, `${P} refused this connection’s access after a change was sent`, LANDED_ACCESS],
  ['may-have-landed', 'rate-limited', 429, false, ANSWERED_ERROR, LANDED_HINT],
  ['may-have-landed', 'writes-stopped', undefined, false, UNUSABLE, LANDED_HINT],
  // no-answer: a call that sent no write; with a status it was answered with an error.
  ['no-answer', undefined, 500, false, `${ANSWERED_ERROR}. Nothing was written`, UNREACHABLE_HINT],
  ['no-answer', undefined, undefined, false, `${UNUSABLE}. Nothing was written`, UNREACHABLE_HINT],
  ['no-answer', 'storage-full', 507, false, `${ANSWERED_ERROR}. Nothing was written`, UNREACHABLE_HINT],
  ['no-answer', 'not-found', undefined, false, `${UNUSABLE}. Nothing was written`, UNREACHABLE_HINT],
  ['no-answer', 'reconnect', 500, false, `${ANSWERED_ERROR}. Nothing was written`, UNREACHABLE_HINT],
  ['no-answer', 'auth', 401, false, `${P} refused this connection’s access. Nothing was read and nothing was written`, RECONNECT],
  ['no-answer', 'forbidden', 403, false, `${P} refused this connection’s access. Nothing was read and nothing was written`, RECONNECT],
  ['no-answer', 'rate-limited', 429, false, `${ANSWERED_ERROR}. Nothing was written`, UNREACHABLE_HINT],
  ['no-answer', 'writes-stopped', undefined, false, `${UNUSABLE}. Nothing was written`, UNREACHABLE_HINT],
];

function unworded(outcome: StorageOutcome, reason: StorageFailureReason | undefined, status: number | undefined, afterRead: boolean): StorageError {
  const error = new StorageError('Dropbox write failed (body text)', undefined, undefined, status, reason, outcome);
  if (afterRead) error.afterRead = true;
  return error;
}

describe('a storage failure with no words of its own is told from one table (US-10 AC20)', () => {
  it('the table names every (outcome, reason) pair', () => {
    const named = new Set(rows.map(([o, r]) => `${o}/${r}`));
    for (const o of OUTCOMES) for (const r of REASONS) expect(named.has(`${o}/${r}`), `${o}/${r}`).toBe(true);
  });

  it.each(rows)('%s / %s / status %s / after read %s', (outcome, reason, status, afterRead, message, hint) => {
    const told = describeStorageFailure(unworded(outcome, reason, status, afterRead), P);
    expect(told).toEqual({ message, hint });
    // The truths each sentence must keep, whatever the row says.
    expect(told.message).not.toMatch(/did not answer/);
    if (outcome === 'refused') expect(told.message).toMatch(/[Nn]othing was written$/);
    if (outcome === 'may-have-landed') {
      expect(told.message).not.toMatch(/Nothing was written/);
      expect(told.hint).toMatch(/may have landed/);
    }
    if (afterRead) expect(told.message).not.toMatch(/Nothing was read/);
    if (status !== undefined && !/refused|reconnected/.test(told.message)) expect(told.message).toMatch(/returned an error/);
  });

  it('a failure with words of its own keeps them', () => {
    const error = new StorageError('Dropbox is full', 'Nothing was written. Free up space in Dropbox, then try again.', undefined, 409, 'storage-full', 'refused');
    expect(describeStorageFailure(error, P)).toEqual({ message: 'Dropbox is full', hint: 'Nothing was written. Free up space in Dropbox, then try again.' });
  });

  // Every provider raises the same typed shape for a server error to an upload: same words.
  it.each([
    ['Dropbox', 'Dropbox write failed (503): busy'],
    ['GitHub', 'GitHub write failed (502): bad gateway'],
    ['Self-host', 'Self-host write failed (500): oops'],
    ['Google Drive', 'Google Drive record update failed (503)'],
  ])('%s: a 5xx to an upload says it returned an error, then the may-have-landed sentence', (provider, raw) => {
    const error = new StorageError(raw, undefined, undefined, 503, undefined, answerOutcome(503, true));
    expect(describeStorageFailure(error, `The record in ${provider}`)).toEqual({ message: `The record in ${provider} returned an error`, hint: LANDED_HINT });
  });
});

/** A record whose write fails once with `failure`; its read answers. */
function saveFailing(failure: () => StorageError, on: 'read' | 'write'): Promise<unknown> {
  const adapter = new MemoryAdapter(new MemoryCloud());
  if (on === 'read') adapter.read = async () => { throw failure(); };
  else adapter.write = async () => { throw failure(); };
  const sync = new SyncManager(adapter, 'phone', ROADMAP_DOC, { now: () => '2026-11-26T10:00:00.000Z' });
  return sync.save(ROADMAP_DOC.migrate(null, { deviceId: 'phone', now: '2026-11-26T10:00:00.000Z' })).then(() => null, (e: unknown) => e);
}

describe('SyncManager marks a write refused after its own read (US-10 AC20)', () => {
  it('a 401 to the save\'s write says nothing was written, not that nothing was read', async () => {
    const error = await saveFailing(() => new StorageError('Dropbox write failed (401)', undefined, undefined, 401, undefined, answerOutcome(401, true)), 'write');
    expect(describeStorageFailure(error, P)).toEqual({ message: `${P} refused this connection’s access. Nothing was written`, hint: RECONNECT });
  });

  it('control: a 401 to the save\'s read says nothing was read and nothing was written', async () => {
    const error = await saveFailing(() => new StorageError('Dropbox read failed (401)', undefined, undefined, 401, undefined, answerOutcome(401)), 'read');
    expect(describeStorageFailure(error, P).message).toBe(`${P} refused this connection’s access. Nothing was read and nothing was written`);
  });

  it('a plain refusal of the save\'s write says the provider refused the change', async () => {
    const error = await saveFailing(() => new StorageError('Dropbox write failed (400)', undefined, undefined, 400, undefined, answerOutcome(400, true)), 'write');
    expect(describeStorageFailure(error, P)).toEqual({ message: `${P} refused the change. Nothing was written`, hint: UNREACHABLE_HINT });
  });

  it('a 5xx to the save\'s write says it returned an error, then the may-have-landed sentence', async () => {
    const error = await saveFailing(() => new StorageError('Dropbox write failed (503)', undefined, undefined, 503, undefined, answerOutcome(503, true)), 'write');
    expect(describeStorageFailure(error, P)).toEqual({ message: `${P} returned an error`, hint: LANDED_HINT });
  });
});
