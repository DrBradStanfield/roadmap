// US-09 AC30 (lead A1 step e): a failed cloud save is retried when the page
// comes back online or the user returns, never after a revoked grant and
// never while erasing. `failed` carries why it failed as data (`cause`), set
// by `passFailed { cause }`; `retryOwed` is the one predicate a retry asks.
import { describe, expect, it } from 'vitest';
import { retryOwed, saveFailureCause, transition, type SaveBase, type SaveState } from './save-state';
import { StorageError } from './adapter';

type Cause = 'auth' | 'other';
const clean = (changes: number): SaveBase => ({ mode: 'clean', changes });
const waiting = (changes: number, saved: number): SaveBase => ({ mode: 'waiting', changes, saved });
const saving = (changes: number, saved: number, from: number, armed = false): SaveBase => ({ mode: 'saving', changes, saved, from, armed });
const failed = (changes: number, saved: number, cause: Cause, mirrored = false) =>
  ({ mode: 'failed', changes, saved, mirrored, cause }) as SaveBase;
const reading = (under: SaveBase): SaveState => ({ mode: 'erasing', phase: 'reading', under });
const writing = (under: SaveBase): SaveState => ({ mode: 'erasing', phase: 'writing', under });

const BASES: Record<string, SaveBase> = {
  clean: clean(5),
  waiting: waiting(6, 5),
  saving: saving(6, 4, 6),
  savingArmed: saving(7, 4, 6, true),
  failedOther: failed(6, 4, 'other'),
  failedOtherMirrored: failed(6, 4, 'other', true),
  failedAuth: failed(6, 4, 'auth'),
  failedAuthMirrored: failed(6, 4, 'auth', true),
};
const OWED = new Set(['failedOther', 'failedOtherMirrored']);

describe('retryOwed (US-09 AC30, lead A1 step e)', () => {
  for (const [name, base] of Object.entries(BASES)) {
    it(`${name}: ${OWED.has(name) ? 'owed' : 'not owed'}`, () => {
      expect(retryOwed(base)).toBe(OWED.has(name));
    });
    // An erase owns the mode from its confirm to the end of its write: no retry
    // starts under it, whatever the save under it is (lead A6).
    it(`erasing (reading) over ${name}: not owed`, () => expect(retryOwed(reading(base))).toBe(false));
    it(`erasing (writing) over ${name}: not owed`, () => expect(retryOwed(writing(base))).toBe(false));
  }
});

describe('passFailed carries its cause into failed (US-09 AC30)', () => {
  for (const cause of ['auth', 'other'] as const) {
    it(`saving + passFailed ${cause} -> failed ${cause}`, () => {
      expect(transition(saving(6, 4, 6), { type: 'passFailed', cause })).toEqual({ state: failed(6, 4, cause), effects: [] });
    });
    it(`writing over saving + passFailed ${cause} -> writing over failed ${cause}`, () => {
      expect(transition(writing(saving(7, 4, 6)), { type: 'passFailed', cause })).toEqual({ state: writing(failed(7, 4, cause)), effects: [] });
    });
    it(`reading over saving + passFailed ${cause} -> reading over failed ${cause}`, () => {
      expect(transition(reading(saving(6, 4, 6)), { type: 'passFailed', cause })).toEqual({ state: reading(failed(6, 4, cause)), effects: [] });
    });
    it(`a failed pass under a re-armed debounce waits on it (${cause}): no failed, so no cause`, () => {
      expect(transition(saving(7, 4, 6, true), { type: 'passFailed', cause })).toEqual({ state: waiting(7, 4), effects: [] });
    });
    it(`a failed pass after a sync landed everything is clean (${cause})`, () => {
      expect(transition(saving(6, 6, 6), { type: 'passFailed', cause })).toEqual({ state: clean(6), effects: [] });
    });
  }

  it('a new failure takes its own cause, whatever the last one was', () => {
    let s: SaveState = failed(6, 4, 'auth', true);
    s = transition(s, { type: 'save' }).state;
    s = transition(s, { type: 'passFailed', cause: 'other' }).state;
    expect(s).toEqual(failed(6, 4, 'other'));
    expect(retryOwed(s)).toBe(true);
  });

  it("an erase's swap leaves a failed save with cause other, so its failed write is retried once the erase ends", () => {
    for (const under of [clean(5), waiting(6, 5), failed(6, 4, 'auth'), failed(6, 4, 'other')]) {
      const swapped = transition(reading(under), { type: 'eraseSwapped' }).state;
      expect(swapped.mode === 'erasing' && swapped.under).toMatchObject({ mode: 'failed', cause: 'other' });
      const ended = transition(swapped, { type: 'eraseEnded' }).state;
      expect(retryOwed(ended)).toBe(true);
    }
  });

  it('mirrored keeps the cause', () => {
    expect(transition(failed(6, 4, 'other'), { type: 'mirrored', changes: 6 }).state).toEqual(failed(6, 4, 'other', true));
    expect(transition(failed(6, 4, 'auth'), { type: 'mirrored', changes: 6 }).state).toEqual(failed(6, 4, 'auth', true));
  });
});

describe('saveFailureCause (US-09 AC30): auth only for a 401 or a revoked grant', () => {
  it.each([
    ['a StorageError with status 401', new StorageError('refused', undefined, undefined, 401, undefined, 'refused'), 'auth'],
    // Owner F1 (a): a 403 is retried, whatever its body: a limit passes, and a true refusal costs one failed call a retry.
    ['a StorageError with status 403', new StorageError('refused', undefined, undefined, 403, undefined, 'refused'), 'other'],
    ['a Drive 403 rate limit, as drive-rest throws it', new StorageError('Google Drive record lookup failed (403): {"error":{"errors":[{"domain":"usageLimits","reason":"userRateLimitExceeded"}],"code":403}}', undefined, undefined, 403, undefined, 'refused'), 'other'],
    ['a Drive 403 daily limit, as drive-rest throws it', new StorageError('Google Drive write failed (403): {"error":{"errors":[{"domain":"usageLimits","reason":"dailyLimitExceeded"}],"code":403}}', undefined, undefined, 403, undefined, 'refused'), 'other'],
    ['a GitHub 403 secondary limit, as github.ts throws it', new StorageError('GitHub write failed (403): {"message":"You have exceeded a secondary rate limit. Please wait a few minutes before you try again."}', undefined, undefined, 403, undefined, 'refused'), 'other'],
    ['a StorageError with status 500', new StorageError('server', undefined, undefined, 500, undefined, 'no-answer'), 'other'],
    ['a StorageError with no status', new StorageError('did not answer', undefined, undefined, undefined, undefined, 'no-answer'), 'other'],
    ['a plain Error', new Error('boom'), 'other'],
    ['a TypeError (a dead network)', new TypeError('Failed to fetch'), 'other'],
    ['a thrown string', 'nope', 'other'],
  ])('%s -> %s', (_name, error, cause) => {
    expect(saveFailureCause(error)).toBe(cause);
  });

  it('a StorageError with reason reconnect and no status (a revoked refresh grant) -> auth', () => {
    expect(saveFailureCause(new StorageError('needs to be reconnected', undefined, undefined, undefined, 'reconnect', 'refused'))).toBe('auth');
    expect(saveFailureCause(new StorageError('refresh failed (400)', undefined, undefined, 400, 'reconnect', 'refused'))).toBe('auth');
  });

  it('the other reasons stay other, and the message is never read', () => {
    expect(saveFailureCause(new StorageError('Dropbox is full', undefined, undefined, 409, 'storage-full', 'refused'))).toBe('other');
    expect(saveFailureCause(new StorageError('document not found.', undefined, undefined, undefined, 'not-found', 'refused'))).toBe('other');
    expect(saveFailureCause(new StorageError('Google Drive needs to be reconnected.', undefined, undefined, undefined, undefined, 'no-answer'))).toBe('other');
  });

  // US-10 AC19 (S57c): changed on purpose. The rewrap's outcome is may-have-landed, so a retry is owed.
  it('a 401 the save rewrapped after a write may have landed owes a retry (US-10 AC19)', () => {
    const inner = new StorageError('refused', undefined, undefined, 401, undefined, 'refused');
    expect(saveFailureCause(new StorageError(inner.message, 'landed hint', inner, inner.status, undefined, 'may-have-landed'))).toBe('other');
  });
});

describe('US-10 AC19 (S57c): the retry reads the typed reason with the typed outcome', () => {
  const OUTCOMES = ['refused', 'may-have-landed', 'no-answer'] as const;
  const REASONS = ['auth', 'reconnect', 'forbidden', 'rate-limited', 'storage-full', 'not-found', undefined] as const;
  /** Only a refused grant stops the retry; a token refused after a write that may have landed does not. */
  const expected = (reason: (typeof REASONS)[number], outcome: (typeof OUTCOMES)[number]): Cause =>
    reason === 'reconnect' || (reason === 'auth' && outcome !== 'may-have-landed') ? 'auth' : 'other';
  const rows = REASONS.flatMap((reason) => OUTCOMES.map((outcome) => [String(reason), outcome, expected(reason, outcome), reason] as const));

  it.each(rows)('reason %s, outcome %s -> %s', (_name, outcome, cause, reason) => {
    // No status and words that name a sign-in: only the typed fields decide.
    const error = new StorageError('Google Drive needs to be reconnected.', undefined, undefined, undefined, reason, outcome);
    expect(saveFailureCause(error)).toBe(cause);
    const after = transition(saving(6, 4, 6), { type: 'passFailed', cause: saveFailureCause(error) }).state;
    expect(retryOwed(after)).toBe(cause === 'other');
  });

  it('the three rulings hold with a 401 status on the error too', () => {
    const cause = (reason: 'auth' | 'reconnect', outcome: (typeof OUTCOMES)[number]) =>
      saveFailureCause(new StorageError('x', undefined, undefined, 401, reason, outcome));
    expect(cause('auth', 'may-have-landed')).toBe('other');
    expect(cause('auth', 'refused')).toBe('auth');
    expect(cause('auth', 'no-answer')).toBe('auth');
    for (const outcome of OUTCOMES) expect(cause('reconnect', outcome)).toBe('auth');
  });
});
