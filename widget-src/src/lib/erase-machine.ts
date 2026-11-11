/**
 * The erase the screen shows, and this tab's own "Delete all my data", as one
 * named state (untangle fix 4; US-16 AC2a, AC2d; US-11 AC6; US-34 AC1, AC4).
 *
 * Changed only through the pure `transition`. Each event carries its data and
 * is judged against the state alone, never a global. What the page must do is
 * returned as effects, run by `runEraseEffects`; `createEraseStore` holds the
 * state as the page's only copy, for useSyncExternalStore. Nothing uses it
 * yet: useErase and useRecordApply move onto it in a later PR.
 *
 * Phases:
 * - loading: the page has not shown its first read.
 * - idle: the page shows `shown`.
 * - erasing: this tab's erase is writing (from idle, or from loading).
 *
 * `heard`: another writer's erase that arrived and that nothing has shown
 * yet. Only an arrival proves another writer, so it is remembered, in every
 * phase, until something shows it (Fable, round 3). In loading it is read
 * once the page has loaded (US-34 AC4); in idle its arrival reads at once,
 * and a read at or above its epoch clears it (a read below it, or one that
 * fails, leaves it heard); in erasing it waits for the end: an own-end at it
 * shows it and reads its rows, an own-end at this tab's erase drops it unless
 * the heard erase is at a higher epoch (then it stays heard and is read), an
 * own-failed reads it. A
 * read never feeds `heard`: a read during this tab's erase can report this
 * tab's own new identity (record-session.ts sets it before the flush).
 *
 * Order: by epoch only, the one order the merge keeps (merge.ts: a higher
 * eraseEpoch wins). Within an epoch the merge's choice is no order on the
 * identity strings (a listing erase takes the unlisted one's erasedAt, which
 * can be earlier), so the machine follows the latest report, by inequality.
 * A lower epoch never replaces a higher one; a malformed identity is epoch -1.
 *
 * Counting (rule a): one remote_change_applied per remote erase identity that
 * gets SHOWN, on every path. The count goes where `shown` moves to an
 * identity this tab did not produce: a read, or this tab's erase ending at
 * another writer's. An arrival never counts; an erase overtaken before it
 * shows never counts (a folded A-then-B counts B only). `counted` keeps a
 * later move to the same identity from counting again.
 *
 * `said` holds the erases whose refused save was said: one alert per erase.
 * A refused save while an erase is heard also asks for that erase's read,
 * said or not (Q3): the store refuses because it holds an erase the screen
 * does not show. One read per refused save; a failed read dispatches nothing.
 *
 * What the events carry (the hook's contract, PR 2b):
 * - read: the store's identity taken before the read's first await, and
 *   dispatched only when it equals the identity after its last await, in the
 *   turn the record is shown (useRecordApply.ts:113 takes it before; the
 *   awaits are useRecordReads.ts:46-53); else the read is dropped: the change
 *   that moved it brings its own read. Dispatched stale, it would move
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
 * - arrived: REMOTE_CHANGED's `erase`, when it carries one.
 *
 * Known cost: own-end is read as another writer's when it ends at the heard
 * erase. That stands on this tab's own erase never arriving: the session
 * holds it before the flush (record-session.ts:362), and adopt announces only
 * an identity unlike the one it holds (record-session.ts:604, 609). Were an
 * echo of this tab's erase ever heard, the person would see their erase done,
 * as without it, plus one extra re-read of the empty record (no visible
 * change) and one wrong remote_change_applied: one extra read and one count.
 *
 * Known limits:
 * - L1, a heard erase whose read fails. The person sees the old record,
 *   whole; the store is at the new erase, so every save from the screen is
 *   refused. The first refusal says WRITE_REFUSED, and every refused save
 *   re-reads (Q3). Ends with: that re-read, the next arrival, own-start, any
 *   whole re-read (upload, refused, left), or a reload.
 * - L2, a first read that fails. The page stays as it was mounted, its saves
 *   off (`hasApiResponse` false), as before the machine (ledger H37). A held
 *   erase IS read then: firstReadFailed dispatches `loaded`, as the relay's
 *   `loaded()` does today (useRecordApply.ts firstReadFailed). That wiring is
 *   PR 2b-3's, with the arrivals; nothing dispatches here yet. "Delete all my
 *   data" still works: own-start from loading goes to erasing, the held erase
 *   kept (Q3 ruling). Ends with: a reload. Own-end moves the machine to idle;
 *   the saves stay off until reload.
 */

import { epochOf } from '@roadmap/health-core/erase-identity';

/** The store's erase identity, `[eraseEpoch, erasedAt]` as one string (record-session eraseIdentityOf). */
export type EraseIdentity = string;

export interface EraseState {
  phase: 'loading' | 'idle' | 'erasing';
  shown: EraseIdentity;
  heard: EraseIdentity | null;
  said: ReadonlySet<EraseIdentity>;
  counted: ReadonlySet<EraseIdentity>;
}

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
  /** The page has shown its first read. */
  | { type: 'loaded' };

export type EraseEffect =
  /** The store's mark: run it once the tree that shows `identity` commits (US-16 AC2d). */
  | { type: 'mark-store'; identity: EraseIdentity }
  /** The chat's banners and every draft made under the old erase go. */
  | { type: 'clear-drafts' }
  /** This tab's erase: the page forgets the old record, on the device and on screen. */
  | { type: 'forget' }
  /** Re-read the record and show it. */
  | { type: 'read' }
  | { type: 'count-remote-change' }
  /** Answered to the caller (refusalIsNews), who says it; no door runs it. */
  | { type: 'alert-refused' }
  /** Say how this tab's erase went: the text its own-end or own-failed carried. */
  | { type: 'say-outcome'; message: string };

export interface Step { state: EraseState; effects: EraseEffect[] }

export function initialEraseState(shown: EraseIdentity): EraseState {
  return { phase: 'loading', shown, heard: null, said: new Set(), counted: new Set() };
}

/** `next` takes `prior`'s place: another identity, at the same or a higher epoch. */
const replaces = (next: EraseIdentity, prior: EraseIdentity): boolean => next !== prior && epochOf(next) >= epochOf(prior);
/** The erase kept of two reports: the latest, unless it is at a lower epoch. */
const keep = (prior: EraseIdentity | null, next: EraseIdentity): EraseIdentity => (prior !== null && epochOf(next) < epochOf(prior) ? prior : next);
const add = (set: ReadonlySet<EraseIdentity>, identity: EraseIdentity) => new Set([...set, identity]);
const READ: EraseEffect = { type: 'read' };
const COUNT: EraseEffect = { type: 'count-remote-change' };
const say = (message: string): EraseEffect => ({ type: 'say-outcome', message });

/** This tab's erase ends at `identity`: another writer's when it is the erase that overtook it.
 *  The evidence this rests on: packages/health-core/src/erase-overtaken.test.ts
 *  (an erase overtaken in its flush is announced before erase() resolves, at
 *  the identity the session then reports). */
function ownEnd(state: EraseState, identity: EraseIdentity, message: string): Step {
  const theirs = state.heard === identity;
  // A heard erase above the end outranks it (a late reader): kept, and read; that read counts it.
  const above = state.heard !== null && epochOf(state.heard) > epochOf(identity);
  const shows = replaces(identity, state.shown);
  const counts = theirs && shows && !state.counted.has(identity);
  return {
    state: {
      ...state,
      phase: 'idle',
      shown: shows ? identity : state.shown,
      heard: above ? state.heard : null,
      // A refusal of a save asked before the erase is not news (adversary R3).
      said: add(state.said, state.shown),
      counted: counts ? add(state.counted, identity) : state.counted,
    },
    effects: [
      { type: 'forget' }, { type: 'clear-drafts' },
      ...(shows ? [{ type: 'mark-store', identity } as const] : []),
      // Another writer's erase won: its rows show. Its arrival's read was lost to this erase.
      ...(theirs || above ? [READ] : []),
      ...(counts ? [COUNT] : []),
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
      // In idle the read shows the store's identity, and with it a heard erase at or below its epoch.
      const seen = state.phase === 'idle' && state.heard !== null && epochOf(event.identity) >= epochOf(state.heard) ? { ...state, heard: null } : state;
      // The erase shown, or a lower epoch, shows nothing new.
      if (!replaces(event.identity, state.shown)) return seen === state ? same : { state: seen, effects: [] };
      // No erase this tab made reaches a read first: its own-end shows it.
      const counts = !state.counted.has(event.identity);
      return {
        state: { ...seen, shown: event.identity, counted: counts ? add(state.counted, event.identity) : state.counted },
        effects: [{ type: 'clear-drafts' }, { type: 'mark-store', identity: event.identity }, ...(counts ? [COUNT] : [])],
      };
    }
    case 'arrived':
      // Heard until something shows it. In idle, read at once, even when shown: the change can carry another writer's rows.
      return { state: { ...state, heard: keep(state.heard, event.identity) }, effects: state.phase === 'idle' ? [READ] : [] };
    case 'loaded':
      // During this tab's erase the heard erase waits for the erase's end.
      if (state.phase !== 'loading') return same;
      return { state: { ...state, phase: 'idle' }, effects: state.heard === null ? [] : [READ] };
    case 'own-start':
      return state.phase === 'erasing' ? same : { state: { ...state, phase: 'erasing' }, effects: [] };
    case 'own-end':
      return state.phase === 'erasing' ? ownEnd(state, event.identity, event.message) : same;
    case 'own-failed':
      // Nothing moved: a heard erase is read, stays heard until that read shows it (and counts it).
      if (state.phase !== 'erasing') return same;
      return { state: { ...state, phase: 'idle' }, effects: state.heard === null ? [say(event.message)] : [READ, say(event.message)] };
    case 'refused': {
      // Inside this tab's erase a refusal is no news: the erase throws the change away anyway.
      if (state.phase === 'erasing') return same;
      // A heard erase not yet shown (L1): every refused save asks for its read once, news or not (Q3).
      // No loop: a failed read dispatches nothing, and only the next refused save reads again.
      const retry = state.heard === null ? [] : [READ];
      if (state.said.has(event.askedUnder)) return { state, effects: retry };
      return { state: { ...state, said: add(state.said, event.askedUnder) }, effects: [{ type: 'alert-refused' }, ...retry] };
    }
  }
}

/** What the page does for each effect; the hook supplies them. */
export interface EraseDoors {
  /** Called synchronously, inside dispatch. The hook's door defers the store's
   *  mark to the layout effect of the commit that shows `identity`, never
   *  sooner: until then the old tree is on screen, and a save asked from it
   *  must be refused (US-16 AC2d). Pinned in PR 2b, where the hook is built. */
  markStore: (identity: EraseIdentity) => void;
  clearDrafts: () => void;
  forget: () => void;
  read: () => void;
  countRemoteChange: () => void;
  sayOutcome: (message: string) => void;
}

/** The one place effects run, in the order the transition lists them. */
export function runEraseEffects(effects: readonly EraseEffect[], doors: EraseDoors): void {
  for (const effect of effects) {
    switch (effect.type) {
      case 'mark-store': doors.markStore(effect.identity); break;
      case 'clear-drafts': doors.clearDrafts(); break;
      case 'forget': doors.forget(); break;
      case 'read': doors.read(); break;
      case 'count-remote-change': doors.countRemoteChange(); break;
      case 'alert-refused': break; // the caller's: refusalIsNews answers it
      case 'say-outcome': doors.sayOutcome(effect.message); break;
    }
  }
}

/** The erase state's only copy, synchronous, for useSyncExternalStore. */
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

/** A save the store refused: true if it is news to say, once per erase. It
 *  only answers; the caller says it. */
export function refusalIsNews(store: EraseStore, askedUnder: EraseIdentity): boolean {
  return store.dispatch({ type: 'refused', askedUnder }).some(effect => effect.type === 'alert-refused');
}
