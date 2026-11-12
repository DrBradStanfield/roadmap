/**
 * The record session's save, as one named state (lead A1). Changed only
 * through the pure `transition`; what the session must do comes back as
 * effects. RecordSession holds it and runs those effects.
 *
 * The timer handle and the promise a flush joins stay in the session, as the
 * handles of effects it runs. A handle inside the state would make it impure
 * and its table test would need fakes. The session's `running` is the
 * synchronous claim that a pass runs: it is set in the turn a pass starts and
 * cleared in the turn the pass ends, so it is non-null exactly while the mode
 * is saving (or erasing over saving). persist() reads it to join that pass.
 *
 * Counting: every change to the working copy counts one (`changes`); `saved`
 * is the count the last landed write carried. A pass starts from `changes`
 * (`from`) and, when it lands, moves `saved` to `from`, never further: an
 * edit made during the pass makes another pass.
 *
 * Modes:
 * - clean: nothing unsaved, no debounce, no pass.
 * - waiting: the debounce is armed (perhaps over nothing unsaved, left by an
 *   edit a pass already took).
 * - saving: a pass runs; `armed` when an edit during it re-armed the debounce.
 * - failed: a pass failed; its changes wait for the next edit or save.
 *   `mirrored`: the session's device write of them landed (US-09 AC30). The
 *   marker is set before that write (US-09 AC4), so only this says the
 *   device holds them. False until the write lands.
 * - held: an erase put the debounce aside while it reads, or swapped the
 *   erased copy in before its write starts. Moves as failed does, and never
 *   outlives the erase: eraseEnded, or holdEnded for an erase that never
 *   swapped, settles it to failed, or clean.
 *   Held exists only because of lead A6 (an erase accepts edits while it
 *   reads); it folds into erasing if A6 moves the refusal to the erase's
 *   first line.
 * - erasing: the erase's swap to the end of its write, over the save state
 *   `under` it. Erasing while a pass runs is erasing over saving. An edit is
 *   refused here; RecordSession.refuses() gives the caller that answer.
 *
 * Where RecordSession dispatches:
 * - saveLoop: `passFailed` in its catch, clearing `running` in the same turn,
 *   before the awaited mirror write; `mirrored` once that write lands, with
 *   the changes it held (read before it started).
 * - saveLoop: `passLanded` once a pass's write lands, before `adopt()`; when
 *   it asks for no next pass, `running` clears in the same turn, so a save
 *   asked for from `adopt()` starts its own pass. A next pass runs after
 *   `adopt()`.
 * - persist(): `save`. While a pass runs it only joins: it clears an armed
 *   debounce and starts no pass.
 * - erase(): read `debounceArmed(state)` before dispatching `hold`.
 * - erase(): `eraseEnded` in a finally around the write, from `eraseStarted`.
 * - erase(): `holdEnded` in a finally that covers the whole erase from `hold`
 *   on, so an aborted erase (beforeErase threw) leaves held too. Never
 *   `eraseEnded` there: a second erase that ends must not unwrap the first's
 *   erasing mid-write (US-16 AC2a).
 */

export type SaveBase =
  | { mode: 'clean'; changes: number }
  | { mode: 'waiting'; changes: number; saved: number }
  | { mode: 'saving'; changes: number; saved: number; from: number; armed: boolean }
  | { mode: 'failed'; changes: number; saved: number; mirrored: boolean }
  | { mode: 'held'; changes: number; saved: number };
export type SaveState = SaveBase | { mode: 'erasing'; under: SaveBase };

export type SaveEvent =
  | { type: 'edited' } // touch(): one more change
  | { type: 'save' } // the debounce fired, flush(), or a page hide's fallback; joins a pass that runs
  | { type: 'passLanded'; from: number } // the pass that started from change `from` wrote
  | { type: 'passFailed' }
  | { type: 'synced' } // a synchronous write landed the whole working copy
  | { type: 'hold' } // an erase puts the debounce aside while it reads
  | { type: 'eraseStarted' } // the erased copy swapped in: one more change
  | { type: 'eraseEnded' } // the erase's write ended, landed or not
  | { type: 'holdEnded' } // an erase ended; settles only a bare held
  | { type: 'mirrored'; changes: number }; // a failed pass's device write landed, holding changes up to `changes`

/** arm: (re)start the debounce, clearing any armed one. cancel: clear it.
 *  pass: run one save pass of the working copy, from change `from`. */
export type SaveEffect = { type: 'arm' } | { type: 'cancel' } | { type: 'pass'; from: number };

export interface SaveStep { state: SaveState; effects: SaveEffect[] }

export const SAVE_START: SaveState = { mode: 'clean', changes: 0 };

const savedOf = (s: SaveBase): number => (s.mode === 'clean' ? s.changes : s.saved);

/** How many changes the working copy holds: what a write of it now holds. */
export function changesOf(s: SaveState): number {
  return s.mode === 'erasing' ? s.under.changes : s.changes;
}

/** True while the debounce is armed. */
export function debounceArmed(s: SaveState): boolean {
  if (s.mode === 'erasing') return debounceArmed(s.under);
  return s.mode === 'waiting' || (s.mode === 'saving' && s.armed);
}

/** True while a change has not landed, a failed save's included (US-10 AC5). */
export function unsaved(s: SaveState): boolean {
  return s.mode === 'erasing' ? unsaved(s.under) : s.changes !== savedOf(s);
}

/** True while the working copy is ahead of the cloud: a pass runs, or the
 *  debounce is armed. Never after a failed save: the re-read goes on (US-34). */
export function writePending(s: SaveState): boolean {
  if (s.mode === 'erasing') return writePending(s.under);
  return s.mode === 'saving' || s.mode === 'waiting';
}

/** not-saved-on-device: not saved, and the device copy holds the changes. */
export type SaveStatus = 'saved' | 'saving' | 'not-saved' | 'not-saved-on-device';

/** What a status line shows. Step (d) words it. */
export function saveStatus(s: SaveState): SaveStatus {
  if (s.mode === 'erasing') return saveStatus(s.under);
  if (s.mode === 'saving' || s.mode === 'held') return 'saving'; // held: an erase is in progress
  if (!unsaved(s)) return 'saved';
  if (s.mode === 'waiting') return 'saving';
  return s.mode === 'failed' && s.mirrored ? 'not-saved-on-device' : 'not-saved';
}

/** Where a pass, or the debounce over it, ends. */
function settle(changes: number, saved: number, armed: boolean): SaveBase {
  if (armed) return { mode: 'waiting', changes, saved };
  return changes === saved ? { mode: 'clean', changes } : { mode: 'failed', changes, saved, mirrored: false };
}

function base(s: SaveBase, e: Exclude<SaveEvent, { type: 'eraseEnded' | 'holdEnded' }>): { state: SaveBase; effects: SaveEffect[] } {
  const saved = savedOf(s);
  const cancel: SaveEffect[] = debounceArmed(s) ? [{ type: 'cancel' }] : [];
  const same = { state: s, effects: [] };
  switch (e.type) {
    case 'edited':
      return { state: s.mode === 'saving' ? { ...s, changes: s.changes + 1, armed: true } : { mode: 'waiting', changes: s.changes + 1, saved }, effects: [{ type: 'arm' }] };
    case 'save':
      if (s.mode === 'saving') return { state: { ...s, armed: false }, effects: cancel }; // joined, never doubled
      if (s.changes === saved) return { state: { mode: 'clean', changes: s.changes }, effects: cancel };
      return { state: { mode: 'saving', changes: s.changes, saved, from: s.changes, armed: false }, effects: [...cancel, { type: 'pass', from: s.changes }] };
    case 'passLanded':
      if (s.mode !== 'saving' || e.from !== s.from) return same; // a stale report
      if (s.changes > e.from) return { state: { ...s, saved: e.from, from: s.changes }, effects: [{ type: 'pass', from: s.changes }] };
      return { state: settle(s.changes, e.from, s.armed), effects: [] };
    case 'passFailed':
      return s.mode === 'saving' ? { state: settle(s.changes, s.saved, s.armed), effects: [] } : same;
    case 'synced':
      return { state: s.mode === 'saving' ? { ...s, saved: s.changes, armed: false } : { mode: 'clean', changes: s.changes }, effects: cancel };
    case 'hold':
      if (s.mode === 'saving') return { state: { ...s, armed: false }, effects: cancel };
      if (s.mode !== 'waiting') return same;
      return { state: s.changes === saved ? { mode: 'clean', changes: s.changes } : { mode: 'held', changes: s.changes, saved }, effects: cancel };
    case 'mirrored': // a write that holds fewer changes never vouches for a later failure
      return s.mode === 'failed' && e.changes >= s.changes ? { state: { ...s, mirrored: true }, effects: [] } : same;
    case 'eraseStarted':
      return { state: s.mode === 'saving' ? { ...s, changes: s.changes + 1, armed: false } : { mode: 'held', changes: s.changes + 1, saved }, effects: cancel };
  }
}

/** The only way the save state changes. */
export function transition(s: SaveState, e: SaveEvent): SaveStep {
  if (e.type === 'holdEnded') { // held never outlives the erase, even one that ended before eraseStarted
    return { state: s.mode === 'held' ? settle(s.changes, s.saved, false) : s, effects: [] };
  }
  if (e.type === 'eraseEnded') {
    const b = s.mode === 'erasing' ? s.under : s;
    return { state: b.mode === 'held' ? settle(b.changes, b.saved, false) : b, effects: [] };
  }
  if (s.mode !== 'erasing' && e.type !== 'eraseStarted') return base(s, e);
  if (s.mode === 'erasing' && e.type === 'edited') return { state: s, effects: [] }; // refused
  const step = base(s.mode === 'erasing' ? s.under : s, e);
  return { state: { mode: 'erasing', under: step.state }, effects: step.effects };
}
