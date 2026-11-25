import { describe, it, expect } from 'vitest';
import { transition, PRINT_START, type PrintEvent, type PrintState } from './plan-print-machine';

// US-18 AC6, US-09 AC19: every (state, event) pair names the state that follows.
const idle: PrintState = PRINT_START;
const idleBlocked: PrintState = { phase: 'idle', blocked: 'capture', opened: false };
const idleOpened: PrintState = { phase: 'idle', blocked: null, opened: true };
const drawing: PrintState = { phase: 'drawing', at: 'bottom', opened: true };
const building: PrintState = { phase: 'building', at: 'capture', opened: false };

const press: PrintEvent = { type: 'press', at: 'bottom' };
const copied: PrintEvent = { type: 'copied' };
const opened: PrintEvent = { type: 'built', opened: true };
const refused: PrintEvent = { type: 'built', opened: false };
const planGone: PrintEvent = { type: 'planGone' };
const forget: PrintEvent = { type: 'forget' };

const SAME = 'same';
const rows: [string, PrintState, PrintEvent, PrintState | typeof SAME][] = [
  ['idle, press: draws the report, the note empties', idleBlocked, press, { phase: 'drawing', at: 'bottom', opened: false }],
  ['idle opened, press: keeps opened', idleOpened, press, { phase: 'drawing', at: 'bottom', opened: true }],
  ['idle, copied: stale', idle, copied, SAME],
  ['idle, built opened: stale', idle, opened, SAME],
  ['idle, built refused: stale', idleOpened, refused, SAME],
  ['idle blocked, planGone: the note goes', idleBlocked, planGone, { phase: 'idle', blocked: null, opened: false }],
  ['idle, planGone: nothing to clear', idle, planGone, SAME],
  ['idle opened, forget', idleOpened, forget, idle],
  ['idle, forget: nothing to forget', idleBlocked, forget, SAME],

  ['drawing, press: refused (one try at a time)', drawing, press, SAME],
  ['drawing, copied: building', drawing, copied, { ...drawing, phase: 'building' }],
  ['drawing, built opened: idle, opened', drawing, opened, idleOpened],
  ['drawing, built refused: idle, blocked at its button', drawing, refused, { phase: 'idle', blocked: 'bottom', opened: true }],
  ['drawing, planGone: waits for its result', drawing, planGone, SAME],
  ['drawing, forget', drawing, forget, { ...drawing, opened: false }],

  ['building, press: refused', building, press, SAME],
  ['building, copied: stale', building, copied, SAME],
  ['building, built opened: idle, opened', building, opened, idleOpened],
  ['building, built refused: idle, blocked at the capture', building, refused, idleBlocked],
  // A throw (getReportHtml, or document.write or print in the window) ends the try with
  // built{opened: false} from usePlanPrint's finally: a refusal, after which a press runs.
  ['a throw in drawing: idle, blocked, opened kept', drawing, refused, { phase: 'idle', blocked: 'bottom', opened: true }],
  ['a throw in building: idle, blocked at the capture', building, refused, idleBlocked],
  ['building, planGone: waits for its result', building, planGone, SAME],
  ['building, forget: nothing to forget', building, forget, SAME],
];

describe('plan-print-machine transition', () => {
  it.each(rows)('%s', (_name, state, event, expected) => {
    const next = transition(state, event);
    if (expected === SAME) expect(next).toBe(state);
    else expect(next).toEqual(expected);
  });

  it('after a throw ends a try, the next press is accepted at either button', () => {
    for (const state of [drawing, building]) {
      const ended = transition(state, refused);
      expect(transition(ended, { type: 'press', at: 'bottom' }).phase).toBe('drawing');
      expect(transition(ended, { type: 'press', at: 'capture' }).phase).toBe('drawing');
    }
  });

  it('covers every phase with every event', () => {
    const seen = new Set(rows.map(([, s, e]) => `${s.phase}:${e.type}`));
    for (const phase of ['idle', 'drawing', 'building']) for (const type of ['press', 'copied', 'built', 'planGone', 'forget']) {
      expect(seen.has(`${phase}:${type}`), `${phase}:${type}`).toBe(true);
    }
  });
});
