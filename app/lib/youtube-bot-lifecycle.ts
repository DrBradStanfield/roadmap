/**
 * US-15 AC70 (lead H49): the YouTube bot's lifecycle, one named state.
 *
 * - stopped: no timer armed, no tick running;
 * - running: the first tick (until it fires) and the interval are armed; no tick runs;
 * - ticking: armed, and one tick runs; a tick that falls due now is skipped (US-27 AC3);
 * - stopping: stopped, with its last tick still finishing; nothing is armed.
 *
 * The timers live inside the state, so a stop always has the ones to clear, and a
 * tick runs only from `running`: never twice at once, never after a stop.
 * Changed only through the pure `transition`; the bot arms and clears the timers
 * and runs the tick the step asks for. Generic over the timer handle so the
 * table test needs no real timers.
 */
export interface Timers<H> { readonly interval: H; readonly first: H | null }

export type Lifecycle<H> =
  | { readonly kind: 'stopped' | 'stopping' }
  | { readonly kind: 'running' | 'ticking'; readonly timers: Timers<H> };

export type LifecycleEvent<H> =
  /** The bot armed these timers to start. */
  | { type: 'start'; timers: Timers<H> }
  | { type: 'stop' }
  /** A timer fired: the first tick's (`first`) or the interval's. */
  | { type: 'due'; first: boolean }
  /** The tick that ran has ended, however it ended. */
  | { type: 'done' };

/** What the bot does next: run a tick, log the skip, or clear timers (a stop's, or a refused start's new ones). */
export type Effect<H> =
  | { kind: 'none' }
  | { kind: 'tick' }
  | { kind: 'busy' }
  | { kind: 'clear'; timers: Timers<H>; refused: boolean };

export interface Step<H> { state: Lifecycle<H>; effect: Effect<H> }

const NONE = { kind: 'none' } as const;

export function transition<H>(state: Lifecycle<H>, event: LifecycleEvent<H>): Step<H> {
  switch (event.type) {
    case 'start':
      if (state.kind === 'stopped') return { state: { kind: 'running', timers: event.timers }, effect: NONE };
      // The last tick still finishing holds the new ticks off until it ends.
      if (state.kind === 'stopping') return { state: { kind: 'ticking', timers: event.timers }, effect: NONE };
      return { state, effect: { kind: 'clear', timers: event.timers, refused: true } };
    case 'stop':
      if (state.kind === 'running') return { state: { kind: 'stopped' }, effect: { kind: 'clear', timers: state.timers, refused: false } };
      if (state.kind === 'ticking') return { state: { kind: 'stopping' }, effect: { kind: 'clear', timers: state.timers, refused: false } };
      return { state, effect: NONE };
    case 'due': {
      if (!('timers' in state)) return { state, effect: NONE }; // stopped or stopping: never a tick
      const timers = event.first ? { ...state.timers, first: null } : state.timers;
      if (state.kind === 'running') return { state: { kind: 'ticking', timers }, effect: { kind: 'tick' } };
      return { state: { kind: 'ticking', timers }, effect: { kind: 'busy' } };
    }
    case 'done':
      if (state.kind === 'ticking') return { state: { kind: 'running', timers: state.timers }, effect: NONE };
      if (state.kind === 'stopping') return { state: { kind: 'stopped' }, effect: NONE };
      return { state, effect: NONE };
  }
}
