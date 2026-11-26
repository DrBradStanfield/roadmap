/**
 * US-75 AC5 and AC8: properties of the blood pressure widget's saves state (`transition`, widgets/blood-pressure.ts),
 * over seeded random event sequences (docs/review-format.md check 9). The oracle is a model of its own, built from
 * the events alone: how many edits were typed, and the newest seq kept and dropped. It never reads the state under
 * test to decide what is right.
 *
 * Each property was shown failing against a named mutation of `transition`, applied alone and then reverted:
 * - "the counts are the oracle's": `kept` takes `Math.max(s.kept, e.seq + 1)`; this property failed on all 200
 *   seeds (`expected [ 2, 3, +0 ] to deeply equal [ 2, 2, +0 ]`).
 * - "settled exactly when no edit is waiting": the waiting test `counts.edits > Math.max(...)` becomes `>=`; this
 *   property failed on 196 of 200 seeds (`expected 'typing' to be 'settled'`).
 */
import { describe, expect, it } from 'vitest';
import { NO_SAVES, transition, type SavesEvent } from './blood-pressure';

/** mulberry32: a small seeded generator, so a failure names its seed and replays. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One event, as the widget can send it: a save answers only an edit already typed. */
function nextEvent(rand: () => number, typed: number): SavesEvent {
  const pick = rand();
  if (typed === 0 || pick < 0.5) return { type: 'typed' };
  const seq = 1 + Math.floor(rand() * typed);
  return pick < 0.75 ? { type: 'kept', seq } : { type: 'dropped', seq };
}

/** The oracle: counts from the events alone. */
interface Model { edits: number; kept: number; dropped: number }
function step(m: Model, e: SavesEvent): Model {
  if (e.type === 'typed') return { ...m, edits: m.edits + 1 };
  return e.type === 'kept' ? { ...m, kept: Math.max(m.kept, e.seq) } : { ...m, dropped: Math.max(m.dropped, e.seq) };
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const LENGTH = 60;

/** Every step of one seeded sequence: the state after the event, and the oracle after it. */
function* walk(seed: number) {
  const rand = random(seed);
  let state = NO_SAVES;
  let model: Model = { edits: 0, kept: 0, dropped: 0 };
  for (let i = 0; i < LENGTH; i++) {
    const event = nextEvent(rand, model.edits);
    state = transition(state, event);
    model = step(model, event);
    yield { after: state, model };
  }
}

describe('US-75 AC5: the saves state over generated event sequences', () => {
  it.each(SEEDS)('seed %i: the counts are the oracle\'s, and kept and dropped never pass edits', (seed) => {
    for (const { after, model } of walk(seed)) {
      expect([after.edits, after.kept, after.dropped]).toEqual([model.edits, model.kept, model.dropped]);
      expect(after.kept).toBeLessThanOrEqual(after.edits);
      expect(after.dropped).toBeLessThanOrEqual(after.edits);
    }
  });

  it.each(SEEDS)('seed %i: settled exactly when no edit is waiting', (seed) => {
    for (const { after, model } of walk(seed)) {
      expect(after.kind).toBe(model.edits > Math.max(model.kept, model.dropped) ? 'typing' : 'settled');
    }
  });
});
