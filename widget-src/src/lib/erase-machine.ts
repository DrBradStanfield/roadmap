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
 * - loading: the page has not shown its first read. Another writer's erase
 *   that arrives is held, and read once the page has loaded (US-34 AC4).
 * - idle: the page shows `shown`.
 * - erasing: this tab's erase is writing (from idle, or from loading, taking
 *   the held erase along). Another writer's erase that arrives meanwhile is
 *   kept as `overtaken`, and read at the end if the store ends there.
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
 *
 * What the events carry (the hook's contract, PR 2b):
 * - read: the store's identity in the turn the record is shown, after the
 *   read's await, and only when it is still the identity the record was read
 *   under. A read whose identity moved during its await is stale and is not
 *   dispatched: the change that moved it brings its own read. Dispatched
 *   stale, it would move `shown` back within an epoch (the overlapping-reads
 *   test), and the store would refuse every save.
 * - own-end: the store's identity in the turn this tab's erase resolves,
 *   whoever made it. When another writer's erase was taken in during the
 *   erase's flush, it is that erase, already heard as `arrived`.
 * - arrived: REMOTE_CHANGED's `erase`, when it carries one.
 */

/** The store's erase identity, `[eraseEpoch, erasedAt]` as one string (record-session eraseIdentityOf). */
export type EraseIdentity = string;

interface Ledger {
  shown: EraseIdentity;
  said: ReadonlySet<EraseIdentity>;
  counted: ReadonlySet<EraseIdentity>;
}

export type EraseState = Ledger & (
  | { phase: 'loading'; held: EraseIdentity | null }
  | { phase: 'idle' }
  | { phase: 'erasing'; overtaken: EraseIdentity | null }
);

export type EraseEvent =
  | { type: 'own-start' }
  /** This tab's erase moved the record: `identity` is the store's as it resolves. */
  | { type: 'own-end'; identity: EraseIdentity }
  /** This tab's erase was refused and moved nothing. */
  | { type: 'own-failed' }
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
  /** Say how this tab's erase went (its result's message). */
  | { type: 'say-outcome' };

export interface Step { state: EraseState; effects: EraseEffect[] }

export function initialEraseState(shown: EraseIdentity): EraseState {
  return { phase: 'loading', held: null, shown, said: new Set(), counted: new Set() };
}

/** The identity's erase epoch; -1, the floor, when it cannot be read. */
export function epochOf(identity: EraseIdentity): number {
  try {
    const [epoch] = JSON.parse(identity) as unknown[];
    return typeof epoch === 'number' && Number.isFinite(epoch) ? epoch : -1;
  } catch {
    return -1;
  }
}

/** `next` takes `prior`'s place: another identity, at the same or a higher epoch. */
const replaces = (next: EraseIdentity, prior: EraseIdentity): boolean => next !== prior && epochOf(next) >= epochOf(prior);
/** The erase kept of two reports: the latest, unless it is at a lower epoch. */
const keep = (prior: EraseIdentity | null, next: EraseIdentity): EraseIdentity => (prior !== null && epochOf(next) < epochOf(prior) ? prior : next);
const idle = ({ shown, said, counted }: EraseState): EraseState => ({ phase: 'idle', shown, said, counted });
const add = (set: ReadonlySet<EraseIdentity>, identity: EraseIdentity) => new Set([...set, identity]);
const READ: EraseEffect = { type: 'read' };
const COUNT: EraseEffect = { type: 'count-remote-change' };
const SAY: EraseEffect = { type: 'say-outcome' };

/** This tab's erase ends at `identity`: another writer's when it is the erase that overtook it. */
function ownEnd(state: EraseState & { phase: 'erasing' }, identity: EraseIdentity): Step {
  const theirs = state.overtaken === identity;
  const shows = replaces(identity, state.shown);
  const counts = theirs && shows && !state.counted.has(identity);
  return {
    state: {
      ...idle(state),
      shown: shows ? identity : state.shown,
      // A refusal of a save asked before the erase is not news (adversary R3).
      said: add(state.said, state.shown),
      counted: counts ? add(state.counted, identity) : state.counted,
    },
    effects: [
      { type: 'forget' }, { type: 'clear-drafts' },
      ...(shows ? [{ type: 'mark-store', identity } as const] : []),
      // Another writer's erase won: its rows show. Its arrival's read was lost to this erase.
      ...(theirs ? [READ] : []),
      ...(counts ? [COUNT] : []),
      SAY,
    ],
  };
}

export function transition(state: EraseState, event: EraseEvent): Step {
  const same: Step = { state, effects: [] };
  switch (event.type) {
    case 'read': {
      // A read inside this tab's erase loses to it; the erase shown, or a lower epoch, shows nothing new.
      if (state.phase === 'erasing' || !replaces(event.identity, state.shown)) return same;
      // No erase this tab made reaches a read first: its own-end shows it.
      const counts = !state.counted.has(event.identity);
      return {
        state: { ...state, shown: event.identity, counted: counts ? add(state.counted, event.identity) : state.counted },
        effects: [{ type: 'clear-drafts' }, { type: 'mark-store', identity: event.identity }, ...(counts ? [COUNT] : [])],
      };
    }
    case 'arrived':
      if (state.phase === 'loading') return { state: { ...state, held: keep(state.held, event.identity) }, effects: [] };
      if (state.phase === 'erasing') return { state: { ...state, overtaken: keep(state.overtaken, event.identity) }, effects: [] };
      // Read even when shown: the change can carry another writer's rows. The read shows a new erase.
      return { state, effects: [READ] };
    case 'loaded':
      // During this tab's erase the held erase rides as `overtaken`.
      if (state.phase !== 'loading') return same;
      return { state: idle(state), effects: state.held === null ? [] : [READ] };
    case 'own-start': {
      if (state.phase === 'erasing') return same;
      const { shown, said, counted } = state;
      return { state: { phase: 'erasing', overtaken: state.phase === 'loading' ? state.held : null, shown, said, counted }, effects: [] };
    }
    case 'own-end':
      return state.phase === 'erasing' ? ownEnd(state, event.identity) : same;
    case 'own-failed':
      // Nothing moved: an erase that overtook it is read, and that read shows it (and counts it).
      if (state.phase !== 'erasing') return same;
      return { state: idle(state), effects: state.overtaken === null ? [SAY] : [READ, SAY] };
    case 'refused':
      // Inside this tab's erase a refusal is no news: the erase throws the change away anyway.
      if (state.phase === 'erasing' || state.said.has(event.askedUnder)) return same;
      return { state: { ...state, said: add(state.said, event.askedUnder) }, effects: [{ type: 'alert-refused' }] };
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
  sayOutcome: () => void;
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
      case 'say-outcome': doors.sayOutcome(); break;
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
