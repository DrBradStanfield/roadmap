/**
 * The cloud picker runs one move at a time (US-09 AC45), and the reconnect
 * panel's Drive reconnect and "Use this browser only" are moves too. A move outlives the
 * picker's mount (closing is allowed while it runs), so its state lives here,
 * for the page's life, not in the picker. One union, one pure transition.
 * `dispatch` updates synchronously, so it is its own claim: a second start in
 * the same turn already sees the first.
 *
 * Every running state carries its move's `run` id, and `failed`, `navigating`
 * and `settled` name the run they report on, so a report from an older move
 * changes nothing. A move that hands the page to a redirect or a reload is
 * `navigating`; only then can the browser's back-forward cache show this page
 * again with nothing running (`restored`), and only then does a reopened
 * picker mean the page did not leave (`reopened`), so the move is over. A
 * stopped load tells the page nothing, so a page still here `HAND_OFF_MS` after
 * its hand-off did not leave either (`stayed`, US-09 AC45a). A move
 * still waiting on a fetch stays claimed. `cancel` is "Stop reconnecting": it
 * ends only a reconnect whose popup answer is not yet saved, with no error text.
 * Once the answer is saved (`saved`), the reconnect is `reconnected` and runs
 * to its reload. A popup answer is kept only while `isCurrentRun` holds for its
 * reconnect.
 *
 * Never holds a credential: the GitHub token and the WebDAV password stay in
 * the picker's component state and die with its mount.
 */
import { useEffect, useSyncExternalStore } from 'react';
import { logOffId, type LogOffId } from '../src/lib/storage';
import { getBackendKind } from '../src/lib/roadmap-data';
import { exitAnswered, rereadStoredHome } from '../src/storage/sign-in-state';
import type { Backend } from './connect';

/** The picker step a move started from, where a reopened picker shows it. */
export type MoveStep = 'list' | 'github' | 'self-host' | 'log-off';

/** `run` is the latest move's id; idle keeps it so the next move's is new. */
export type SwitchFlow =
  | { kind: 'idle'; run: number; error: string | null }
  | { kind: 'switching'; run: number; to: Backend; step: MoveStep }
  | { kind: 'loggingOff'; run: number }
  | { kind: 'navigating'; run: number; step: MoveStep }
  | { kind: 'reconnecting'; run: number }
  /** The popup's grant is saved: local edits go up, then the page reloads. Nothing stops it. */
  | { kind: 'reconnected'; run: number };

export type SwitchEvent =
  | { type: 'start'; to: Backend; step: Exclude<MoveStep, 'log-off'> }
  | { type: 'logOff' }
  | { type: 'reconnect' }
  | { type: 'navigating'; run: number }
  | { type: 'settled'; run: number }
  | { type: 'failed'; run: number; message: string }
  | { type: 'cancel'; run: number }
  | { type: 'saved'; run: number }
  | { type: 'clearError' }
  | { type: 'restored' }
  | { type: 'reopened' }
  | { type: 'stayed'; run: number };

/** The step a running state shows on a reopened picker. */
export function stepOf(state: SwitchFlow): MoveStep | null {
  if (state.kind === 'idle') return null;
  if (state.kind === 'reconnecting' || state.kind === 'reconnected') return 'list';
  return state.kind === 'loggingOff' ? 'log-off' : state.step;
}

/** `run` is true only when the event claimed the flow: its caller then runs the move. */
export function transition(state: SwitchFlow, event: SwitchEvent): { next: SwitchFlow; run: boolean } {
  const same = { next: state, run: false };
  if (state.kind === 'idle') {
    if (event.type === 'start') return { next: { kind: 'switching', run: state.run + 1, to: event.to, step: event.step }, run: true };
    if (event.type === 'logOff') return { next: { kind: 'loggingOff', run: state.run + 1 }, run: true };
    if (event.type === 'reconnect') return { next: { kind: 'reconnecting', run: state.run + 1 }, run: true };
    if (event.type === 'clearError' && state.error !== null) return { next: { kind: 'idle', run: state.run, error: null }, run: false };
    return same;
  }
  if (event.type === 'restored' || event.type === 'reopened' || event.type === 'stayed') {
    const left = state.kind === 'navigating' && (event.type !== 'stayed' || event.run === state.run);
    return left ? { next: { kind: 'idle', run: state.run, error: null }, run: false } : same;
  }
  if (!('run' in event) || event.run !== state.run) return same;
  if (event.type === 'failed') return { next: { kind: 'idle', run: state.run, error: event.message }, run: false };
  if (state.kind === 'navigating') return same;
  if (event.type === 'cancel' || event.type === 'saved') {
    if (state.kind !== 'reconnecting') return same;
    return { next: event.type === 'cancel' ? { kind: 'idle', run: state.run, error: null } : { kind: 'reconnected', run: state.run }, run: false };
  }
  return { next: { kind: 'navigating', run: state.run, step: stepOf(state)! }, run: false };
}

let flow: SwitchFlow = { kind: 'idle', run: 0, error: null };
const listeners = new Set<() => void>();

export function getSwitchFlow(): SwitchFlow {
  return flow;
}

/** True only while the move that claimed `run` still runs: for a reconnect,
 *  while the flow is still `reconnecting` or `reconnected` at that run. The one
 *  place a popup answer is refused: once the reconnect stopped, it saves nothing. */
export function isCurrentRun(run: number, state: SwitchFlow = flow): boolean {
  return state.run === run && state.kind !== 'idle' && state.kind !== 'navigating';
}

export function subscribeSwitchFlow(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatch(event: SwitchEvent): boolean {
  const { next, run } = transition(flow, event);
  if (next !== flow) {
    const stayed = flow.kind === 'navigating' && next.kind === 'idle';
    flow = next;
    // However a hand-off ends with the page still here, a page on this browser's copy shows the home this
    // browser now stores (US-09 AC52); a page on a cloud still runs on it until a reload.
    if (stayed && getBackendKind() === 'local') rereadStoredHome();
    listeners.forEach((listener) => listener());
  }
  return run;
}

/** What a running move is handed: its run id, the log-off id it began under (US-09
 *  AC45), and `navigating()`, to call just before it hands the page to a redirect. */
export interface Move {
  run: number;
  gen: LogOffId;
  navigating: () => void;
}

/** Claim the flow with `event`; when it is claimed, run the move and report how it ended. */
export async function runMove(event: SwitchEvent, move: (m: Move) => Promise<void>): Promise<void> {
  if (!dispatch(event)) return;
  exitAnswered(); // any move answers the reconnect panel's exit question (US-09 AC51)
  const { run } = flow;
  const gen = logOffId();
  try {
    await move({ run, gen, navigating: () => dispatch({ type: 'navigating', run }) });
    dispatch({ type: 'settled', run });
  } catch (e) {
    dispatch({ type: 'failed', run, message: e instanceof Error ? e.message : 'Connection failed.' });
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) dispatch({ type: 'restored' });
  });
}

/** How long a page may stay after handing itself to a redirect or reload
 *  before the move counts as over: a page that really leaves is gone by then. */
export const HAND_OFF_MS = 15_000;

/** Every surface that shows the flow frees a hand-off that never left (US-09 AC45a). */
export function useSwitchFlow(): SwitchFlow {
  const state = useSyncExternalStore(subscribeSwitchFlow, getSwitchFlow, getSwitchFlow);
  const handedOff = state.kind === 'navigating' ? state.run : null;
  useEffect(() => {
    if (handedOff === null) return;
    const timer = setTimeout(() => dispatch({ type: 'stayed', run: handedOff }), HAND_OFF_MS);
    return () => clearTimeout(timer);
  }, [handedOff]);
  return state;
}

/** Tests only: a fresh page's idle flow without a fresh module graph. */
export function resetSwitchFlow(): void {
  flow = { kind: 'idle', run: 0, error: null };
}
