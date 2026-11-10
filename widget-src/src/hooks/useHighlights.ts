// The plan's new-card glow (US-07 AC3): which suggestions glow, and which fade.
import { useEffect, useState } from 'react';
import type { Suggestion } from '@roadmap/health-core/types';
import { NO_HIGHLIGHTS, type Highlights } from '../components/PlanCards';

/** A plan's suggestions by id: the words a change can touch (title and description). */
export type Plan = ReadonlyMap<string, string>;
export const planOf = (suggestions: Suggestion[] | undefined): Plan =>
  new Map((suggestions ?? []).map(s => [s.id, `${s.title}\u0000${s.description}`]));

/**
 * The glow's phase, with its data. `baseline` is the plan a card is new against.
 * - settling (the first 3 s after mount): nothing glows; each plan becomes the baseline.
 * - still: a plan with ids new or reworded against the baseline glows them; the
 *   first plan after an empty one too (P7, Brad 2026-11-10).
 * - held (the PDF email box pulses, P7): nothing glows; the baseline stays as the
 *   hold found it and the latest plan waits. Released, what is new against it glows.
 * - glowing(ids) → fading(ids) after 3 s → still after 0.5 s, on the glow's plan.
 *   Another plan restarts the glow against the same baseline; one with nothing new
 *   (a change undone) ends it at once.
 */
export type Glow =
  | { phase: 'settling'; baseline: Plan; held: boolean }
  | { phase: 'still'; baseline: Plan }
  | { phase: 'held'; baseline: Plan; plan: Plan }
  | { phase: 'glowing'; baseline: Plan; plan: Plan; ids: Set<string> }
  | { phase: 'fading'; baseline: Plan; plan: Plan; ids: Set<string> };

export type GlowEvent =
  | { type: 'settled' } | { type: 'plan'; plan: Plan } | { type: 'hold'; on: boolean }
  | { type: 'glowEnded' } | { type: 'fadeEnded' };

function changed(baseline: Plan, plan: Plan): Set<string> {
  const ids = new Set<string>();
  for (const [id, words] of plan) if (baseline.get(id) !== words) ids.add(id);
  return ids;
}
const same = (a: Plan, b: Plan) => a.size === b.size && changed(a, b).size === 0;

/** Glow what the plan holds new against the baseline; with nothing new, the plan is the baseline. */
function glowOn(baseline: Plan, plan: Plan): Glow {
  const ids = changed(baseline, plan);
  return ids.size ? { phase: 'glowing', baseline, plan, ids } : { phase: 'still', baseline: plan };
}

/** The only way the glow changes. Returns the same object when nothing does, so React skips the render. */
export function transition(state: Glow, event: GlowEvent): Glow {
  switch (state.phase) {
    case 'settling':
      if (event.type === 'plan') return same(state.baseline, event.plan) ? state : { ...state, baseline: event.plan };
      if (event.type === 'hold') return event.on === state.held ? state : { ...state, held: event.on };
      if (event.type === 'settled') return state.held ? { phase: 'held', baseline: state.baseline, plan: state.baseline } : { phase: 'still', baseline: state.baseline };
      return state;
    case 'still':
      if (event.type === 'plan') return same(state.baseline, event.plan) ? state : glowOn(state.baseline, event.plan);
      if (event.type === 'hold' && event.on) return { phase: 'held', baseline: state.baseline, plan: state.baseline };
      return state;
    case 'held':
      if (event.type === 'plan') return same(state.plan, event.plan) ? state : { ...state, plan: event.plan };
      if (event.type === 'hold' && !event.on) return glowOn(state.baseline, state.plan);
      return state;
    case 'glowing':
    case 'fading':
      if (event.type === 'plan') return glowOn(state.baseline, event.plan); // a copy restarts the glow, as before
      if (event.type === 'hold' && event.on) return { phase: 'held', baseline: state.baseline, plan: state.plan };
      if (event.type === 'glowEnded' && state.phase === 'glowing') return { ...state, phase: 'fading' };
      if (event.type === 'fadeEnded' && state.phase === 'fading') return { phase: 'still', baseline: state.plan };
      return state;
  }
}

/**
 * New or changed suggestions glow for 3 s, then fade for 0.5 s; nothing glows while
 * `held` (the PDF email box pulses: emailPulses in PlanPdf.tsx). The hook only sends
 * events and runs the timers the phase asks for. useState with an updater, not
 * useReducer, so an unchanged state bails out before a render.
 */
export function useHighlights(suggestions: Suggestion[] | undefined, held: boolean): Highlights {
  const [glow, setGlow] = useState<Glow>(() => ({ phase: 'settling', baseline: planOf(suggestions), held }));
  const send = (event: GlowEvent) => setGlow(state => transition(state, event));

  useEffect(() => {
    const timer = setTimeout(() => send({ type: 'settled' }), 3000);
    return () => clearTimeout(timer);
  }, []);
  // The plan before the hold, so a plan and a release in one render glow the new plan.
  useEffect(() => { send({ type: 'plan', plan: planOf(suggestions) }); }, [suggestions]);
  useEffect(() => { send({ type: 'hold', on: held }); }, [held]);
  // One glow run, glowing then fading, keeps its `ids` object: its two timers start
  // with it, and any other phase or a restarted glow cancels them.
  const run = glow.phase === 'glowing' || glow.phase === 'fading' ? glow.ids : null;
  useEffect(() => {
    if (!run) return;
    const toFade = setTimeout(() => send({ type: 'glowEnded' }), 3000);
    const toStill = setTimeout(() => send({ type: 'fadeEnded' }), 3500);
    return () => { clearTimeout(toFade); clearTimeout(toStill); };
  }, [run]);

  return {
    highlighted: glow.phase === 'glowing' ? glow.ids : NO_HIGHLIGHTS,
    fadingOut: glow.phase === 'fading' ? glow.ids : NO_HIGHLIGHTS,
  };
}
