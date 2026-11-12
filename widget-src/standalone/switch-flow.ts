/**
 * The cloud picker runs one move at a time (US-09 AC45). A move outlives the
 * picker's mount (closing is allowed while it runs), so its state lives here,
 * for the page's life, not in the picker. One union, one pure transition.
 * `dispatch` updates synchronously, so it is its own claim: a second start in
 * the same turn already sees the first. Success leaves the page (a reload or
 * a redirect), so only a failure returns to idle.
 *
 * Never holds a credential: the GitHub token and the WebDAV password stay in
 * the picker's component state and die with its mount.
 */
import { useSyncExternalStore } from 'react';
import type { Backend } from './connect';

/** The picker step a move started from, where a reopened picker shows it. */
export type MoveStep = 'list' | 'github' | 'self-host';

export type SwitchFlow =
  | { kind: 'idle'; error: string | null }
  | { kind: 'switching'; to: Backend; step: MoveStep }
  | { kind: 'loggingOff' };

export type SwitchEvent =
  | { type: 'start'; to: Backend; step: MoveStep }
  | { type: 'logOff' }
  | { type: 'failed'; message: string }
  | { type: 'clearError' };

const IDLE: SwitchFlow = { kind: 'idle', error: null };

/** `run` is true only when the event claimed the flow: its caller then runs the move. */
export function transition(state: SwitchFlow, event: SwitchEvent): { next: SwitchFlow; run: boolean } {
  if (state.kind === 'idle') {
    if (event.type === 'start') return { next: { kind: 'switching', to: event.to, step: event.step }, run: true };
    if (event.type === 'logOff') return { next: { kind: 'loggingOff' }, run: true };
    if (event.type === 'clearError' && state.error !== null) return { next: IDLE, run: false };
    return { next: state, run: false };
  }
  if (event.type === 'failed') return { next: { kind: 'idle', error: event.message }, run: false };
  return { next: state, run: false };
}

let flow: SwitchFlow = IDLE;
const listeners = new Set<() => void>();

export function getSwitchFlow(): SwitchFlow {
  return flow;
}

export function subscribeSwitchFlow(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function dispatch(event: SwitchEvent): boolean {
  const { next, run } = transition(flow, event);
  if (next !== flow) {
    flow = next;
    listeners.forEach((listener) => listener());
  }
  return run;
}

/** Claim the flow with `event`; when it is claimed, run the move and report a failure. */
export async function runMove(event: SwitchEvent, move: () => Promise<void>): Promise<void> {
  if (!dispatch(event)) return;
  try {
    await move();
  } catch (e) {
    dispatch({ type: 'failed', message: e instanceof Error ? e.message : 'Connection failed.' });
  }
}

export function useSwitchFlow(): SwitchFlow {
  return useSyncExternalStore(subscribeSwitchFlow, getSwitchFlow);
}

/** Tests only: a fresh page's idle flow without a fresh module graph. */
export function resetSwitchFlow(): void {
  flow = IDLE;
}
