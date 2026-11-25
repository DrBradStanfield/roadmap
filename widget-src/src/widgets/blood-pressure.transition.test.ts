/**
 * US-75 AC8: properties of the blood pressure widget's saves state (`transition`, widgets/blood-pressure.ts), over
 * seeded random event sequences (docs/review-format.md check 9). The oracle is a model of its own, built from the
 * events alone: how many edits were typed, the newest seq kept and dropped, and the erase of each run as the
 * events give it. It never reads the state under test to decide what is right.
 */
import { describe, expect, it } from 'vitest';
import { NO_SAVES, transition, type SaveEvent, type Saves } from './blood-pressure';

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

const ERASES = ['A', 'B', 'C'];

/** One event, as the widget can send it: a save answers only an edit already typed. */
function nextEvent(rand: () => number, typed: number): SaveEvent {
  const pick = rand();
  if (typed === 0 || pick < 0.5) return { type: 'typed', erase: ERASES[Math.floor(rand() * ERASES.length)] };
  const seq = 1 + Math.floor(rand() * typed);
  return pick < 0.75 ? { type: 'kept', seq } : { type: 'dropped', seq };
}

/** The oracle: counts from the events, and the run's erase as the first typed event of a run names it. */
interface Model { edits: number; kept: number; dropped: number; run: string | null }
function step(m: Model, e: SaveEvent): Model {
  if (e.type === 'typed') return { edits: m.edits + 1, kept: m.kept, dropped: m.dropped, run: m.run ?? e.erase };
  const kept = e.type === 'kept' ? Math.max(m.kept, e.seq) : m.kept;
  const dropped = e.type === 'dropped' ? Math.max(m.dropped, e.seq) : m.dropped;
  const waiting = m.edits > Math.max(kept, dropped);
  return { edits: m.edits, kept, dropped, run: waiting ? m.run : null };
}

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);
const LENGTH = 60;

/** Every step of one seeded sequence: before, event, after, and the oracle after. */
function* walk(seed: number): Generator<{ before: Saves; event: SaveEvent; after: Saves; model: Model; prior: Model }> {
  const rand = random(seed);
  let state = NO_SAVES;
  let model: Model = { edits: 0, kept: 0, dropped: 0, run: null };
  for (let i = 0; i < LENGTH; i++) {
    const event = nextEvent(rand, model.edits);
    const after = transition(state, event);
    const prior = model;
    model = step(model, event);
    yield { before: state, event, after, model, prior };
    state = after;
  }
}

describe('US-75 AC8: the saves state over generated event sequences', () => {
  it.each(SEEDS)('seed %i: the claim never changes inside a run', (seed) => {
    for (const { before, after, prior } of walk(seed)) {
      if (prior.run !== null && after.kind === 'typing') expect(after.erase).toBe(prior.run);
      if (before.kind === 'typing' && after.kind === 'typing') expect(after.erase).toBe(before.erase);
    }
  });

  it.each(SEEDS)('seed %i: a claim is taken only by typed from settled, and it is the erase that event names', (seed) => {
    for (const { before, event, after } of walk(seed)) {
      if (before.kind === 'settled' && after.kind === 'typing') {
        expect(event.type).toBe('typed');
        expect(after.erase).toBe((event as Extract<SaveEvent, { type: 'typed' }>).erase);
      }
    }
  });

  it.each(SEEDS)('seed %i: the counts are the oracle\'s, and kept and dropped never pass edits', (seed) => {
    for (const { after, model } of walk(seed)) {
      expect([after.edits, after.kept, after.dropped]).toEqual([model.edits, model.kept, model.dropped]);
      expect(after.kept).toBeLessThanOrEqual(after.edits);
      expect(after.dropped).toBeLessThanOrEqual(after.edits);
    }
  });

  it.each(SEEDS)('seed %i: settled exactly when no edit is waiting', (seed) => {
    for (const { after, model } of walk(seed)) {
      const waiting = model.edits > Math.max(model.kept, model.dropped);
      expect(after.kind).toBe(waiting ? 'typing' : 'settled');
      if (after.kind === 'typing') expect(after.erase).toBe(model.run);
    }
  });
});
