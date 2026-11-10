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
 *   that arrives is held, and applies once the page has loaded (US-34 AC4).
 * - idle: the page shows `shown`.
 * - erasing: this tab's erase is writing. The identity it produces comes with
 *   `own-end`; another writer's erase that beat it in the merge arrives
 *   meanwhile and is kept as `overtaken`, shown at the end (the later wins).
 *
 * Per identity, `said` holds the erases whose refused save was said (one alert
 * per erase) and `counted` the remote erases that sent remote_change_applied
 * (one per remote erase, on its arrival, whichever path shows it first).
 */
import { stampInstant } from '@roadmap/health-core/merge';

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
  /** This tab's erase moved the record: `identity` is the one it produced. */
  | { type: 'own-end'; identity: EraseIdentity }
  /** This tab's erase was refused and moved nothing. */
  | { type: 'own-failed' }
  /** REMOTE_CHANGED carried another writer's erase: the identity the store adopted. */
  | { type: 'arrived'; identity: EraseIdentity }
  /** A whole re-read: the identity read with the record, in one turn. */
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
  | { type: 'alert-refused' }
  /** Say how this tab's erase went (its result's message). */
  | { type: 'say-outcome' };

export interface Step { state: EraseState; effects: EraseEffect[] }

export function initialEraseState(shown: EraseIdentity): EraseState {
  return { phase: 'loading', held: null, shown, said: new Set(), counted: new Set() };
}

function parts(identity: EraseIdentity): [number, number, string] {
  try {
    const [epoch, at] = JSON.parse(identity) as [number, string | null];
    return [epoch, at == null || Number.isNaN(stampInstant(at)) ? -Infinity : stampInstant(at), at ?? ''];
  } catch {
    return [-1, -Infinity, ''];
  }
}

/** `a` is a later erase than `b`: a higher epoch, or at one epoch a later
 *  erasedAt, as the merge picks (merge.ts laterErase). */
export function laterErase(a: EraseIdentity, b: EraseIdentity): boolean {
  const [ea, ta, sa] = parts(a);
  const [eb, tb, sb] = parts(b);
  return ea !== eb ? ea > eb : ta !== tb ? ta > tb : sa > sb;
}

const newest = (a: EraseIdentity | null, b: EraseIdentity): EraseIdentity => (a !== null && laterErase(a, b) ? a : b);
const idle = ({ shown, said, counted }: EraseState): EraseState => ({ phase: 'idle', shown, said, counted });
const add = (set: ReadonlySet<EraseIdentity>, identity: EraseIdentity) => new Set([...set, identity]);

/** The count an arrival owes: once per remote erase identity. */
function count(state: EraseState, identity: EraseIdentity): Step {
  if (state.counted.has(identity)) return { state, effects: [] };
  return { state: { ...state, counted: add(state.counted, identity) }, effects: [{ type: 'count-remote-change' }] };
}

/** This tab's erase ends, at `produced` (null: it moved nothing), or at an erase that overtook it. */
function ownEnd(state: EraseState & { phase: 'erasing' }, produced: EraseIdentity | null): Step {
  const winner = produced === null ? state.overtaken ?? state.shown : newest(state.overtaken, produced);
  const shows = laterErase(winner, state.shown);
  return {
    // A refusal of a save asked before the erase is not news (adversary R3).
    state: { ...idle(state), shown: shows ? winner : state.shown, said: add(state.said, state.shown) },
    effects: [
      { type: 'forget' }, { type: 'clear-drafts' },
      ...(shows ? [{ type: 'mark-store', identity: winner } as const] : []),
      // Another writer's erase won: its rows show. Its arrival's read was lost to this erase.
      ...(winner !== produced ? [{ type: 'read' } as const] : []),
      { type: 'say-outcome' },
    ],
  };
}

export function transition(state: EraseState, event: EraseEvent): Step {
  const same: Step = { state, effects: [] };
  switch (event.type) {
    case 'read':
      // A read inside this tab's erase loses to it; an older or the same erase shows nothing new.
      if (state.phase === 'erasing' || !laterErase(event.identity, state.shown)) return same;
      return { state: { ...state, shown: event.identity }, effects: [{ type: 'clear-drafts' }, { type: 'mark-store', identity: event.identity }] };
    case 'arrived': {
      if (state.phase === 'loading') return { state: { ...state, held: newest(state.held, event.identity) }, effects: [] };
      const counted = count(state, event.identity);
      if (state.phase === 'erasing') {
        return { state: { ...counted.state, phase: 'erasing', overtaken: newest(state.overtaken, event.identity) }, effects: counted.effects };
      }
      // Read even when shown: the change can carry another writer's rows. The read shows a new erase.
      return { state: counted.state, effects: [...counted.effects, { type: 'read' }] };
    }
    case 'loaded':
      if (state.phase !== 'loading') return same;
      return state.held === null ? { state: idle(state), effects: [] } : transition(idle(state), { type: 'arrived', identity: state.held });
    case 'own-start':
      return state.phase === 'idle' ? { state: { ...state, phase: 'erasing', overtaken: null }, effects: [] } : same;
    case 'own-end':
      return state.phase === 'erasing' ? ownEnd(state, event.identity) : same;
    case 'own-failed':
      if (state.phase !== 'erasing') return same;
      return state.overtaken === null ? { state: idle(state), effects: [{ type: 'say-outcome' }] } : ownEnd(state, null);
    case 'refused':
      // Inside this tab's erase a refusal is no news: the erase throws the change away anyway.
      if (state.phase === 'erasing' || state.said.has(event.askedUnder)) return same;
      return { state: { ...state, said: add(state.said, event.askedUnder) }, effects: [{ type: 'alert-refused' }] };
  }
}

/** What the page does for each effect; the hook supplies them. */
export interface EraseDoors {
  /** The hook runs it after the commit that shows `identity`, never before (US-16 AC2d). */
  markStore: (identity: EraseIdentity) => void;
  clearDrafts: () => void;
  forget: () => void;
  read: () => void;
  countRemoteChange: () => void;
  alertRefused: () => void;
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
      case 'alert-refused': doors.alertRefused(); break;
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

/** A save the store refused: true if it is news to say, once per erase. */
export function refusalIsNews(store: EraseStore, askedUnder: EraseIdentity): boolean {
  return store.dispatch({ type: 'refused', askedUnder }).some(effect => effect.type === 'alert-refused');
}
