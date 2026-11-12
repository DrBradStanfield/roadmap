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

  it('mirrored keeps the cause', () => {
    expect(transition(failed(6, 4, 'other'), { type: 'mirrored', changes: 6 }).state).toEqual(failed(6, 4, 'other', true));
    expect(transition(failed(6, 4, 'auth'), { type: 'mirrored', changes: 6 }).state).toEqual(failed(6, 4, 'auth', true));
  });
});

describe('saveFailureCause (US-09 AC30): auth only for a refused grant', () => {
  it.each([
    ['a StorageError with status 401', new StorageError('refused', undefined, undefined, 401), 'auth'],
    ['a StorageError with status 403', new StorageError('refused', undefined, undefined, 403), 'auth'],
    ['a StorageError with status 500', new StorageError('server', undefined, undefined, 500), 'other'],
    ['a StorageError with no status', new StorageError('did not answer'), 'other'],
    ['a plain Error', new Error('boom'), 'other'],
    ['a TypeError (a dead network)', new TypeError('Failed to fetch'), 'other'],
    ['a thrown string', 'nope', 'other'],
  ])('%s -> %s', (_name, error, cause) => {
    expect(saveFailureCause(error)).toBe(cause);
  });

  it('a 401 the save rewrapped after a write may have landed keeps its status, so it is still auth', () => {
    const inner = new StorageError('refused', undefined, undefined, 401);
    expect(saveFailureCause(new StorageError(inner.message, 'landed hint', inner, inner.status))).toBe('auth');
  });
});
