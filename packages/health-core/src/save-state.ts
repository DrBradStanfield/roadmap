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
 * - erasing: an erase, from its confirm to the end of its write, over the save
 *   state `under` it (lead A6). An edit is refused throughout;
 *   RecordSession.refuses() gives the caller that answer. `reading`: the erase
 *   reads the record and runs the caller's step; the debounce is put aside and
 *   `under` keeps its mode, so an erase that stops here gives `under` back and
 *   re-arms its debounce, with no change added. `writing`: the erased copy is
 *   swapped in and written. Erasing while a pass runs is erasing over saving.
 *
 * Where RecordSession dispatches:
 * - saveLoop: `passFailed` in its catch, clearing `running` in the same turn,
 *   before the awaited mirror write.
 * - saveLoop: `passLanded` once a pass's write lands, before `adopt()`; when
 *   it asks for no next pass, `running` clears in the same turn, so a save
 *   asked for from `adopt()` starts its own pass. A next pass runs after
 *   `adopt()`.
 * - persist(): `save`. While a pass runs it only joins: it clears an armed
 *   debounce and starts no pass.
 * - erase(): refuses a second erase before any event (ERASE_BUSY), so one
 *   erase owns the erasing mode. `eraseBegan` on its first line after that;
 *   `eraseSwapped` after the build; `eraseAborted` in a finally that closes in
 *   the turn of the swap, so only an erase that stopped before it gives its
 *   save back; `eraseEnded` in a finally around the write.
 */

export type SaveBase =
  | { mode: 'clean'; changes: number }
  | { mode: 'waiting'; changes: number; saved: number }
  | { mode: 'saving'; changes: number; saved: number; from: number; armed: boolean }
  | { mode: 'failed'; changes: number; saved: number };
export type SaveState = SaveBase | { mode: 'erasing'; phase: 'reading' | 'writing'; under: SaveBase };

export type SaveEvent =
  | { type: 'edited' } // touch(): one more change
  | { type: 'save' } // the debounce fired, flush(), or a page hide's fallback; joins a pass that runs
  | { type: 'passLanded'; from: number } // the pass that started from change `from` wrote
  | { type: 'passFailed' }
  | { type: 'synced' } // a synchronous write landed the whole working copy
  | { type: 'eraseBegan' } // the erase's first line: every write is refused from here
  | { type: 'eraseSwapped' } // the erased copy swapped in: one more change
  | { type: 'eraseAborted' } // the erase stopped before its swap
  | { type: 'eraseEnded' }; // the erase's write ended, landed or not

/** arm: (re)start the debounce, clearing any armed one. cancel: clear it.
 *  pass: run one save pass of the working copy, from change `from`. */
export type SaveEffect = { type: 'arm' } | { type: 'cancel' } | { type: 'pass'; from: number };

export interface SaveStep { state: SaveState; effects: SaveEffect[] }

export const SAVE_START: SaveState = { mode: 'clean', changes: 0 };

const savedOf = (s: SaveBase): number => (s.mode === 'clean' ? s.changes : s.saved);

/** True while the debounce is armed. Never while erasing: the erase put it
 *  aside, and an edit, the one thing that arms it, is refused. */
export function debounceArmed(s: SaveState): boolean {
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

export type SaveStatus = 'saved' | 'saving' | 'not-saved';

/** What a status line shows. Step (d) words it. */
export function saveStatus(s: SaveState): SaveStatus {
  if (s.mode === 'erasing') return saveStatus(s.under);
  if (s.mode === 'saving') return 'saving';
  if (!unsaved(s)) return 'saved';
  return s.mode === 'waiting' ? 'saving' : 'not-saved';
}

/** Where a pass, or the debounce over it, ends. */
function settle(changes: number, saved: number, armed: boolean): SaveBase {
  if (armed) return { mode: 'waiting', changes, saved };
  return changes === saved ? { mode: 'clean', changes } : { mode: 'failed', changes, saved };
}

/** Every event but the erase's. None of them arms the debounce but `edited`,
 *  which an erase refuses, so a reading erase's debounce stays aside. */
type BaseEvent = Exclude<SaveEvent, { type: 'eraseBegan' | 'eraseSwapped' | 'eraseAborted' | 'eraseEnded' }>;

function base(s: SaveBase, e: BaseEvent): { state: SaveBase; effects: SaveEffect[] } {
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
  }
}

/** The erased copy swapped in: one more change. A pass that runs goes on and
 *  carries it; anything else waits for the erase's write as failed. */
function swapped(s: SaveBase): SaveBase {
  return s.mode === 'saving' ? { ...s, changes: s.changes + 1, armed: false } : { mode: 'failed', changes: s.changes + 1, saved: savedOf(s) };
}

/** The only way the save state changes. */
export function transition(s: SaveState, e: SaveEvent): SaveStep {
  if (s.mode !== 'erasing') {
    if (e.type === 'eraseBegan') return { state: { mode: 'erasing', phase: 'reading', under: s }, effects: debounceArmed(s) ? [{ type: 'cancel' }] : [] };
    if (e.type === 'eraseSwapped' || e.type === 'eraseAborted' || e.type === 'eraseEnded') return { state: s, effects: [] }; // stale
    return base(s, e);
  }
  const reading = s.phase === 'reading';
  switch (e.type) {
    case 'eraseBegan': // erase() refuses a second erase before dispatching
    case 'edited': // refused: refuses() answers the caller
      return { state: s, effects: [] };
    case 'eraseSwapped':
      return { state: reading ? { mode: 'erasing', phase: 'writing', under: swapped(s.under) } : s, effects: [] };
    case 'eraseAborted': // past the swap there is nothing to abort
      if (!reading) return { state: s, effects: [] };
      return { state: s.under, effects: debounceArmed(s.under) ? [{ type: 'arm' }] : [] };
    case 'eraseEnded':
      return { state: s.under, effects: [] };
    default: {
      const step = base(s.under, e);
      return { state: { ...s, under: step.state }, effects: step.effects };
    }
  }
}
