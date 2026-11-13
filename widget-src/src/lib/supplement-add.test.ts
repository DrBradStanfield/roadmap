/**
 * US-62 AC30c, AC30e, AC30g: the add row's transition table. Every state x
 * event row names the state that follows; the rendered paths are pinned in
 * HealthTool.supplement-add-mode.test.tsx and HealthTool.supplement-add-touch.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import { CLOSED, transition, type SupplementAdd, type SupplementAddEvent } from './supplement-add';

const open = (o: Partial<Extract<SupplementAdd, { phase: 'open' }>> = {}): SupplementAdd =>
  ({ phase: 'open', query: '', list: false, held: false, ...o });

const STATES: Record<string, SupplementAdd> = {
  closed: CLOSED,
  'open, nothing shown': open(),
  'open, list': open({ list: true }),
  'open, list, held': open({ list: true, held: true }),
  'open, held, no list': open({ held: true }),
  'open, typed, list': open({ query: 'Crea', list: true }),
  'open, blank typed, list': open({ query: '  ', list: true }),
  'open, typed, held': open({ query: 'Crea', list: true, held: true }),
};

const EVENTS: Record<string, SupplementAddEvent> = {
  opened: { type: 'opened' },
  focused: { type: 'focused' },
  'typed Mag': { type: 'typed', query: 'Mag' },
  pressedList: { type: 'pressedList' },
  pressCancelled: { type: 'pressCancelled' },
  pressedOutside: { type: 'pressedOutside' },
  focusLeft: { type: 'focusLeft' },
  escaped: { type: 'escaped' },
  added: { type: 'added' },
};

const same = 'same';
/** [state, event, next]; `same` means the very same object, so React skips the render. */
const TABLE: [string, string, SupplementAdd | typeof same][] = [
  ['closed', 'opened', open()],
  ...Object.keys(EVENTS).filter(e => e !== 'opened').map(e => ['closed', e, same] as [string, string, typeof same]),

  ['open, nothing shown', 'opened', same],
  ['open, nothing shown', 'focused', open({ list: true })],
  ['open, nothing shown', 'typed Mag', open({ query: 'Mag', list: true })],
  ['open, nothing shown', 'pressedList', open({ held: true })],
  ['open, nothing shown', 'pressCancelled', same],
  ['open, nothing shown', 'pressedOutside', same],
  ['open, nothing shown', 'focusLeft', CLOSED],
  ['open, nothing shown', 'escaped', CLOSED],
  ['open, nothing shown', 'added', CLOSED],

  ['open, list', 'opened', same],
  ['open, list', 'focused', same],
  ['open, list', 'typed Mag', open({ query: 'Mag', list: true })],
  ['open, list', 'pressedList', open({ list: true, held: true })],
  ['open, list', 'pressCancelled', same],
  ['open, list', 'pressedOutside', open()],
  ['open, list', 'focusLeft', CLOSED],
  ['open, list', 'escaped', CLOSED],
  ['open, list', 'added', CLOSED],

  // AC30g: a held press keeps an empty search open when the focus leaves.
  ['open, list, held', 'opened', same],
  ['open, list, held', 'focused', same],
  ['open, list, held', 'typed Mag', open({ query: 'Mag', list: true, held: true })],
  ['open, list, held', 'pressedList', same],
  ['open, list, held', 'pressCancelled', open({ list: true })],
  ['open, list, held', 'pressedOutside', open()],
  ['open, list, held', 'focusLeft', same],
  ['open, list, held', 'escaped', CLOSED],
  ['open, list, held', 'added', CLOSED],

  // Not reached from the page: the outside listener runs only while the list shows.
  ['open, held, no list', 'focused', open({ list: true, held: true })],
  ['open, held, no list', 'pressCancelled', open()],
  ['open, held, no list', 'pressedOutside', open()],
  ['open, held, no list', 'focusLeft', same],

  // Something typed stays open when left (AC30c).
  ['open, typed, list', 'opened', same],
  ['open, typed, list', 'focused', same],
  ['open, typed, list', 'typed Mag', open({ query: 'Mag', list: true })],
  ['open, typed, list', 'pressedList', open({ query: 'Crea', list: true, held: true })],
  ['open, typed, list', 'pressCancelled', same],
  ['open, typed, list', 'pressedOutside', open({ query: 'Crea' })],
  ['open, typed, list', 'focusLeft', same],
  ['open, typed, list', 'escaped', CLOSED],
  ['open, typed, list', 'added', CLOSED],

  ['open, blank typed, list', 'focusLeft', CLOSED],
  ['open, typed, held', 'pressCancelled', open({ query: 'Crea', list: true })],
  ['open, typed, held', 'focusLeft', same],
  ['open, typed, held', 'added', CLOSED],
];

describe('US-62 AC30c, AC30e, AC30g: the supplement add row transition', () => {
  it.each(TABLE)('%s + %s', (state, event, next) => {
    const from = STATES[state];
    const to = transition(from, EVENTS[event]);
    if (next === same) expect(to).toBe(from);
    else expect(to).toEqual(next);
  });

  it('the table covers every event from every state the page reaches', () => {
    const reached = ['closed', 'open, nothing shown', 'open, list', 'open, list, held', 'open, typed, list'];
    for (const state of reached) {
      for (const event of Object.keys(EVENTS)) {
        expect(TABLE.some(([s, e]) => s === state && e === event), `${state} + ${event}`).toBe(true);
      }
    }
  });

  it('closing carries nothing over: a reopen starts empty, no press held', () => {
    const typedHeld = transition(transition(transition(open(), EVENTS['typed Mag']), EVENTS.pressedList), EVENTS.escaped);
    expect(transition(typedHeld, EVENTS.opened)).toEqual(open());
  });
});
