/**
 * The erase the screen shows, and this tab's own "Delete all my data", as one
 * named state (untangle fix 4; US-16 AC2a, AC2d; US-11 AC6; US-34 AC1, AC4).
 *
 * Changed only through the pure `transition`. Each event carries its data and
 * is judged against the state alone, never a global. What the page must do is
 * returned as effects, run by `runEraseEffects`; `createEraseStore` holds the
 * state as the page's only copy (hooks/useErase.ts builds it, with the doors).
 * Another writer's erase reaches only this machine, never the relay
 * (lib/remote-replay.ts), and only this machine counts it.
 *
 * Phases:
 * - idle: no erase of this tab's is writing.
 * - erasing: this tab's erase is writing (whatever `read` is).
 *   `refused` holds the erase the first save refused during it was asked
 *   under, or null; it goes with the phase.
 *
 * `read`, the page's first read (ledger H37; the page's only "loaded"):
 * - pending: not shown yet. The page's saves stay off.
 * - shown: shown (`loaded` with shown true). Saves are on (useErase `loaded`).
 * - failed: it failed part-way (`loaded` with shown false). Saves stay off (L2).
 * It moves once, out of pending, in either phase. "Settled" below means idle
 * with `read` out of pending.
 *
 * `heard`: another writer's erase that arrived and that nothing has shown
 * yet. Only an arrival proves another writer, so it is remembered, in every
 * phase, until something shows it (Fable, round 3). While `read` is pending
 * it is read once the page has loaded (US-34 AC4, rule R2), even after this
 * tab's erase ended in that window; settled, its arrival reads at once,
 * and a read of that erase, or of a higher epoch, clears it (a read below
 * it, a read of another identity at its epoch, or a read that fails leaves
 * it heard); in erasing it waits for the end: an own-end at it
 * shows it and reads its rows, an own-end at this tab's erase drops it unless
 * the heard erase is at a higher epoch (then it stays heard and is read), an
 * own-failed reads it. A
 * read never feeds `heard`: a read during this tab's erase can report this
 * tab's own new identity (record-session.ts sets it before the flush).
 *
 * `heard.reach` (H39): 'reading' once anything asks for its read (an arrival,
 * or any step that emits `read`), 'failed' when that read failed
 * (`read-failed`, for the heard identity only, outside erasing: a late
 * failure of an older erase's read never marks a newer one). `retry` reads a
 * failed one again, only while settled. `unreachable` (settled, and the heard
 * erase's last read failed) is what the page tells the person (H39 PR 2).
 *
 * Order: by epoch only, the one order the merge keeps (merge.ts: a higher
 * eraseEpoch wins). Within an epoch the merge's choice is no order on the
 * identity strings (a listing erase takes the unlisted one's erasedAt, which
 * can be earlier), so the machine follows the latest report, by inequality.
 * A lower epoch never replaces a higher one; a malformed identity is epoch -1.
 *
 * Counting (rule a): one remote_change_applied per remote erase identity that
 * gets SHOWN, on every path. Where `shown` moves to an identity this tab did
 * not produce (a read, or this tab's erase ending at another writer's), it is
 * marked `pending`; the count comes with `committed`, when the tree that shows
 * it commits (Codex R1): React can batch two reads into one commit, and only
 * the erase on screen counts. An arrival never counts; an erase overtaken
 * before its tree commits never counts (a folded A-then-B counts B only).
 * `counted` keeps a later move to the same identity from counting again.
 *
 * `said` holds the erases whose refused save was said: one alert per erase.
 * A refused save outside erasing while an erase is heard emits one `read`,
 * with `alert-refused` before it only when its erase is not yet said (Q3);
 * in erasing it emits nothing and is recorded (`refused`): an own-end throws
 * the change away, and an own-failed re-reads as a refused save does
 * (`reread-refused`), so the screen shows what is stored (A6 R1). An
 * own-failed with nothing refused reads nothing: a list save still waiting
 * then lands on the screen it was made on (A6 Codex R1). A failed read
 * dispatches `read-failed`, which emits nothing, so nothing repeats until the
 * next refused save, arrival or `retry`. Q4: a refusal under an erase already
 * said, while reads keep failing, still re-reads and adds no alert; the page
 * holds `unreachable` meanwhile (H39).
 *
 * What the events carry (the hook's contract, PR 2b):
 * - read: the store's identity taken before the read's first await, and
 *   dispatched only when it equals the identity after its last await, in the
 *   turn the record is shown (useRecordApply.ts apply takes it before; the
 *   awaits are useRecordReads.ts:46-53); else the read is dropped, showing
 *   neither record nor erase: the change that moved it brings its own read.
 *   The page's first read is the one exception: it is shown even when its
 *   identity moved (the page must show something), and dispatches no `read`;
 *   the arrival, heard while `read` is pending, is read at `loaded`. Dispatched stale, it would move
 *   `shown` back within an epoch (the overlapping-reads test), and the store
 *   would refuse every save.
 * - own-start: dispatched in the turn eraseAll reads `before`, the store's
 *   identity (useErase.ts eraseAll).
 * - own-end: whenever the store's identity moved during this tab's erase,
 *   whatever result.success says. eraseAll reads the store's identity right
 *   after `await deleteUserData()` and dispatches in that same synchronous
 *   turn, no await between (2b-1 R1), whoever made it. When another writer's
 *   erase was taken in during the erase's flush, it is that erase, already
 *   heard as `arrived`. It carries the text to say (`message`).
 * - own-failed: only when the store's identity did not move. Carries `message`.
 * - arrived: REMOTE_CHANGED's `erase`, when it carries one (useRecordApply's
 *   listener reads the event's detail, never the store again).
 * - loaded: the page has shown its first read (`shown` true), or that read
 *   failed (false): useRecordApply firstReadShown, in the turn the load's
 *   last write is made, and firstReadFailed.
 * - committed: the tree showing `identity` committed; dispatched by the same
 *   layout effect that moves the store's mark (useErase.ts, US-16 AC2d), so
 *   "the page now shows this" is one moment.
 * - read-failed: the machine's read (useRecordApply `shows`) failed; it carries
 *   the heard identity as that read began.
 * - retry: the person asked to read the heard erase again (useErase `retry`).
 *
 * Known cost: own-end is read as another writer's when it ends at the heard
 * erase. That stands on this tab's own erase never arriving: the session
 * holds it before the flush (record-session.ts:351), and adopt announces only
 * an identity unlike the one it holds (record-session.ts:595, 600). Were an
 * echo of this tab's erase ever heard, the person would see their erase done,
 * as without it, plus one extra re-read of the empty record (no visible
 * change) and one wrong remote_change_applied: one extra read and one count.
 *
 * Known limits:
 * - L1, a heard erase whose read fails. The person sees the old record,
 *   whole; the store is at the new erase, so every save from the screen is
 *   refused. The first refusal under each erase says WRITE_REFUSED, and
 *   every refused save while the erase is heard re-reads (Q3). Ends with: that re-read, the next arrival, own-start, any
 *   whole re-read (upload, refused, left), `retry`, or a reload. While reads
 *   keep failing the machine holds `unreachable` (H39). Residual until H39
 *   PR 2 shows it: a second refused save under the same erase loses its typed
 *   value with no words.
 * - L2, a first read that fails. The page stays as it was mounted, its saves
 *   off (`read` failed), as before the machine. A held erase IS read then:
 *   firstReadFailed dispatches `loaded` (shown false), as it calls the
 *   relay's `loaded()` (useRecordApply.ts firstReadFailed). "Delete all my
 *   data" still works: own-start goes to erasing, the held erase kept (Q3
 *   ruling). Ends with: a reload. Own-end moves the machine to idle; `read`
 *   stays failed, so the saves stay off until reload.
 */

import { epochOf } from '@roadmap/health-core/erase-identity';

/** The store's erase identity, `[eraseEpoch, erasedAt]` as one string (record-session eraseIdentityOf). */
export type EraseIdentity = string;

/** The page's first read: not shown yet, shown, or failed part-way (the comment above). */
export type FirstRead = 'pending' | 'shown' | 'failed';

interface EraseCommon {
  read: FirstRead;
  shown: EraseIdentity;
  /** Who moved `shown` there: a read (another writer's) or this tab's erase ending (own, unless another's overtook it).
   *  Its own field, set wherever `shown` moves; never read off `pending`, which a counted erase leaves null (PR 1359 R5). */
  shownBy: 'own' | 'remote';
  /** Another writer's erase not yet shown, and whether its last read failed (H39). */
  heard: null | { identity: EraseIdentity; reach: 'reading' | 'failed' };
  said: ReadonlySet<EraseIdentity>;
  counted: ReadonlySet<EraseIdentity>;
  /** Another writer's erase now `shown`, counted when the tree showing it commits. */
  pending: EraseIdentity | null;
}
type Erasing = EraseCommon & { phase: 'erasing'; refused: EraseIdentity | null };
export type EraseState = (EraseCommon & { phase: 'idle' }) | Erasing;

export type EraseEvent =
  | { type: 'own-start' }
  /** The store's identity moved during this tab's erase: `identity` is the store's as it resolves. */
  | { type: 'own-end'; identity: EraseIdentity; message: string }
  /** The store's identity did not move during this tab's erase. */
  | { type: 'own-failed'; message: string }
  /** REMOTE_CHANGED carried another writer's erase: the identity the store adopted. */
  | { type: 'arrived'; identity: EraseIdentity }
  /** A whole re-read: the store's identity as the record shows (the contract above). */
  | { type: 'read'; identity: EraseIdentity }
  /** The store refused a save asked under `askedUnder`. */
  | { type: 'refused'; askedUnder: EraseIdentity }
  /** The page's first read: shown, or failed part-way. */
  | { type: 'loaded'; shown: boolean }
  /** The tree showing `identity` committed (useErase's mark effect). */
  | { type: 'committed'; identity: EraseIdentity }
  /** The machine's read, begun for the heard erase `identity`, failed. */
  | { type: 'read-failed'; identity: EraseIdentity }
  /** Read the heard erase again, its last read failed. */
  | { type: 'retry' };

export type EraseEffect =
  /** The chat's banners and every draft made under the old erase go. */
  | { type: 'clear-drafts' }
  /** This tab's erase: the page forgets the old record, on the device and on screen. */
  | { type: 'forget' }
  /** Re-read the record and show it. */
  | { type: 'read' }
  /** Re-read the record as a refused save does (useErase writeRefused): this erase refused a save, then stopped short. */
  | { type: 'reread-refused' }
  | { type: 'count-remote-change' }
  /** Say WRITE_REFUSED: listed before a refusal's `read`, so the alert comes first (Fable Q3). */
  | { type: 'alert-refused' }
  /** Say how this tab's erase went: the text its own-end or own-failed carried. */
  | { type: 'say-outcome'; message: string };

export interface Step { state: EraseState; effects: EraseEffect[] }

export function initialEraseState(shown: EraseIdentity): EraseState {
  return { phase: 'idle', read: 'pending', shown, shownBy: 'own', heard: null, said: new Set(), counted: new Set(), pending: null };
}

/** `next` takes `prior`'s place: another identity, at the same or a higher epoch. */
const replaces = (next: EraseIdentity, prior: EraseIdentity): boolean => next !== prior && epochOf(next) >= epochOf(prior);
/** The erase kept of two reports: the latest, unless it is at a lower epoch. */
const keep = (prior: EraseIdentity | null, next: EraseIdentity): EraseIdentity => (prior !== null && epochOf(next) < epochOf(prior) ? prior : next);
const add = (set: ReadonlySet<EraseIdentity>, identity: EraseIdentity) => new Set([...set, identity]);
const READ: EraseEffect = { type: 'read' };
const COUNT: EraseEffect = { type: 'count-remote-change' };
const say = (message: string): EraseEffect => ({ type: 'say-outcome', message });
/** This tab's erase is over: idle, the erasing phase's data dropped with it. */
const ended = ({ refused: _refused, ...common }: Erasing): EraseState => ({ ...common, phase: 'idle' });
/** Idle, the first read out of pending: an arrival reads at once. */
const settled = (state: EraseState): boolean => state.phase === 'idle' && state.read !== 'pending';
/** Settled, another writer's erase heard, and its last read failed (H39). */
export const unreachable = (state: EraseState): boolean => settled(state) && state.heard?.reach === 'failed';
/** The heard erase, its read asked for (a step that emits `read`). */
const reading = (heard: EraseState['heard']): EraseState['heard'] => (heard === null ? null : { identity: heard.identity, reach: 'reading' });

/** This tab's erase ends at `identity`: another writer's when it is the erase that overtook it.
 *  The evidence this rests on: packages/health-core/src/erase-overtaken.test.ts
 *  (an erase overtaken in its flush is announced before erase() resolves, at
 *  the identity the session then reports). */
function ownEnd(state: Erasing, identity: EraseIdentity, message: string): Step {
  const theirs = state.heard?.identity === identity;
  // A heard erase above the end outranks it (a late reader): kept, and read; that read counts it.
  const above = state.heard !== null && epochOf(state.heard.identity) > epochOf(identity);
  const shows = replaces(identity, state.shown);
  const counts = theirs && shows && !state.counted.has(identity);
  return {
    state: {
      ...ended(state),
      shown: shows ? identity : state.shown,
      shownBy: shows ? (theirs ? 'remote' : 'own') : state.shownBy,
      heard: above ? reading(state.heard) : null,
      // A refusal of a save asked before the erase is not news (adversary R3).
      said: add(state.said, state.shown),
      pending: counts ? identity : shows ? null : state.pending,
    },
    effects: [
      { type: 'forget' }, { type: 'clear-drafts' },
      // Another writer's erase won: its rows show. Its arrival's read was lost to this erase.
      ...(theirs || above ? [READ] : []),
      say(message),
    ],
  };
}

export function transition(state: EraseState, event: EraseEvent): Step {
  const same: Step = { state, effects: [] };
  switch (event.type) {
    case 'read': {
      // A read inside this tab's erase loses to it, and leaves `heard` alone.
      if (state.phase === 'erasing') return same;
      // Settled, a read shows the heard erase when it is that erase or outranks it; a same-epoch other identity does not.
      const clears = state.heard !== null && (event.identity === state.heard.identity || epochOf(event.identity) > epochOf(state.heard.identity));
      const seen = settled(state) && clears ? { ...state, heard: null } : state;
      // The erase shown, or a lower epoch, shows nothing new.
      if (!replaces(event.identity, state.shown)) return seen === state ? same : { state: seen, effects: [] };
      // No erase this tab made reaches a read first: its own-end shows it.
      return {
        state: { ...seen, shown: event.identity, shownBy: 'remote', pending: state.counted.has(event.identity) ? null : event.identity },
        effects: [{ type: 'clear-drafts' }],
      };
    }
    case 'committed':
      // In every phase: only the pending erase, once on screen, counts; this tab's own and a counted one are never pending.
      if (event.identity !== state.pending) return same;
      return { state: { ...state, pending: null, counted: add(state.counted, event.identity) }, effects: [COUNT] };
    case 'arrived':
      // Heard until something shows it. Settled, read at once, even when shown: the change can carry another writer's rows.
      return { state: { ...state, heard: { identity: keep(state.heard?.identity ?? null, event.identity), reach: 'reading' } }, effects: settled(state) ? [READ] : [] };
    case 'loaded': {
      // Once: shown or failed. During this tab's erase the heard erase waits for the erase's end.
      if (state.read !== 'pending') return same;
      const reads = state.phase === 'idle' && state.heard !== null;
      const next: EraseState = { ...state, read: event.shown ? 'shown' : 'failed', heard: reads ? reading(state.heard) : state.heard };
      return { state: next, effects: reads ? [READ] : [] };
    }
    case 'own-start':
      return state.phase === 'erasing' ? same : { state: { ...state, phase: 'erasing', refused: null }, effects: [] };
    case 'own-end':
      return state.phase === 'erasing' ? ownEnd(state, event.identity, event.message) : same;
    case 'own-failed': {
      // Nothing moved: a heard erase is read, stays heard until that read shows it (and counts it). Else a save
      // refused during the erase was never saved, so the record is re-read as any refused save is (A6 R1).
      if (state.phase !== 'erasing') return same;
      const read = state.heard !== null ? [READ] : state.refused !== null ? [{ type: 'reread-refused' } as const] : [];
      return { state: { ...ended(state), heard: reading(state.heard) }, effects: [...read, say(event.message)] };
    }
    case 'refused': {
      // Inside this tab's erase a refusal is no news, and is kept: an erase that lands throws the change away,
      // one that stops short re-reads (own-failed). The first one's erase is kept.
      if (state.phase === 'erasing') return state.refused !== null ? same : { state: { ...state, refused: event.askedUnder }, effects: [] };
      // A heard erase not yet shown (L1): every refused save asks for its read once, news or not (Q3).
      // No loop: a failed read's read-failed emits nothing; only the next refused save, arrival or retry reads again.
      const reread = state.heard === null ? [] : [READ];
      const asked = state.heard?.reach === 'failed' ? { ...state, heard: reading(state.heard) } : state;
      if (state.said.has(event.askedUnder)) return { state: asked, effects: reread };
      return { state: { ...asked, said: add(state.said, event.askedUnder) }, effects: [{ type: 'alert-refused' }, ...reread] };
    }
    case 'read-failed':
      // Only the read of the heard erase, in flight: a late failure of an older erase's read marks nothing.
      // No-op with nothing heard, and while erasing (own-end or own-failed then reads or drops it).
      if (state.phase === 'erasing' || state.heard?.identity !== event.identity || state.heard.reach !== 'reading') return same;
      return { state: { ...state, heard: { identity: event.identity, reach: 'failed' } }, effects: [] };
    case 'retry':
      // Only when unreachable: never while erasing, loading, with nothing heard, or while its read is in flight.
      if (!unreachable(state)) return same;
      return { state: { ...state, heard: reading(state.heard) }, effects: [READ] };
  }
}

/** What the page does for each effect; the hook supplies them. */
export interface EraseDoors {
  clearDrafts: () => void;
  forget: () => void;
  read: () => void;
  rereadRefused: () => void;
  countRemoteChange: () => void;
  alertRefused: () => void;
  sayOutcome: (message: string) => void;
}

/** The one place effects run, in the order the transition lists them. */
export function runEraseEffects(effects: readonly EraseEffect[], doors: EraseDoors): void {
  for (const effect of effects) {
    switch (effect.type) {
      case 'clear-drafts': doors.clearDrafts(); break;
      case 'forget': doors.forget(); break;
      case 'read': doors.read(); break;
      case 'reread-refused': doors.rereadRefused(); break;
      case 'count-remote-change': doors.countRemoteChange(); break;
      case 'alert-refused': doors.alertRefused(); break;
      case 'say-outcome': doors.sayOutcome(effect.message); break;
    }
  }
}

/** The erase state's only copy, synchronous; the page's tree reads it through its listener (hooks/useErase.ts). */
export interface EraseStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => EraseState;
  /** Step the state, tell subscribers, then run the effects; answers them. */
  dispatch: (event: EraseEvent) => readonly EraseEffect[];
}

export function createEraseStore(shown: EraseIdentity, doors: EraseDoors): EraseStore {
  let state = initialEraseState(shown);
  const listeners = new Set<() => void>();
  return {
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    getSnapshot: () => state,
    dispatch(event) {
      const step = transition(state, event);
      if (step.state !== state) {
        state = step.state;
        for (const listener of [...listeners]) listener();
      }
      runEraseEffects(step.effects, doors);
      return step.effects;
    },
  };
}

/** A save the store refused: `news`, said once per erase (the alertRefused
 *  door said it), and `reads`: the machine re-read a heard erase itself (Q3),
 *  so the caller does not read again. */
export function refusal(store: EraseStore, askedUnder: EraseIdentity): { news: boolean; reads: boolean } {
  const effects = store.dispatch({ type: 'refused', askedUnder });
  return { news: effects.some(effect => effect.type === 'alert-refused'), reads: effects.some(effect => effect.type === 'read') };
}
