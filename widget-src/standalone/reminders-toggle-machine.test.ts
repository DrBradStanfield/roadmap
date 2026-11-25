/**
 * The reminders toggle's table (lead H116, US-17 AC18): every step x every
 * event, each row naming the step that follows ('same': unchanged, the same
 * object). Synthetic addresses and words only.
 */
import { describe, it, expect } from 'vitest';
import {
  busy, EMPTY_FORM, INITIAL_STEP, shown, transition,
  type Resting, type ToggleEvent, type ToggleForm, type ToggleStep,
} from './reminders-toggle-machine';

const FORM: ToggleForm = { wantsUpdates: true, typedEmail: 'list@example.com', needsEmail: false, reminderEmail: '' };
const OLD = 'an earlier failure (test text)';
const FAIL = 'a failure (test text)';
const ADDRESS = 'synthetic-person@example.com';

const idle: Resting = { phase: 'idle', error: OLD };
const asking: Resting = { phase: 'asking', form: FORM, error: OLD };
const refreshed: Resting = { phase: 'refreshed', email: ADDRESS, error: OLD };
const turningOn: ToggleStep = { phase: 'turningOn', form: FORM };
const off = (prior: Resting): ToggleStep => ({ phase: 'turningOff', prior: { ...prior, error: null } });

const events = {
  open: { type: 'open' },
  edit: { type: 'edit', edit: { typedEmail: 'edited@example.com' } },
  submit: { type: 'submit' },
  dismiss: { type: 'dismiss' },
  onDone: { type: 'onDone' },
  onRefreshed: { type: 'onRefreshed', email: ADDRESS },
  onFailed: { type: 'onFailed', message: FAIL, needsEmail: true },
  off: { type: 'off' },
  offDone: { type: 'offDone' },
  offFailed: { type: 'offFailed', message: FAIL },
  recordOn: { type: 'recordOn' },
} satisfies Record<string, ToggleEvent>;
type Name = keyof typeof events;

const EDITED: ToggleForm = { ...FORM, typedEmail: 'edited@example.com' };
const quiet = <T extends Resting>(r: T): T => ({ ...r, error: null });

/** [step, what follows each event]: all eleven events in every row. */
const table: Array<[string, ToggleStep, Record<Name, ToggleStep | 'same'>]> = [
  ['idle (with an earlier failure)', idle, {
    open: { phase: 'asking', form: EMPTY_FORM, error: OLD },
    edit: 'same', submit: 'same', dismiss: 'same', onDone: 'same', onRefreshed: 'same', onFailed: 'same',
    off: off(idle),
    offDone: 'same', offFailed: 'same', recordOn: 'same',
  }],
  ['asking', asking, {
    open: 'same',
    edit: { ...asking, form: EDITED },
    submit: turningOn,
    dismiss: INITIAL_STEP,
    onDone: 'same', onRefreshed: 'same', onFailed: 'same',
    off: off(asking),
    offDone: 'same', offFailed: 'same',
    recordOn: INITIAL_STEP,
  }],
  ['refreshed', refreshed, {
    open: 'same', edit: 'same', submit: 'same', dismiss: 'same', onDone: 'same', onRefreshed: 'same', onFailed: 'same',
    off: off(refreshed),
    offDone: 'same', offFailed: 'same', recordOn: 'same',
  }],
  ['turningOn', turningOn, {
    open: 'same', edit: 'same', submit: 'same', dismiss: 'same',
    onDone: INITIAL_STEP,
    onRefreshed: { phase: 'refreshed', email: ADDRESS, error: null },
    onFailed: { phase: 'asking', form: { ...FORM, needsEmail: true }, error: FAIL },
    off: 'same', offDone: 'same', offFailed: 'same', recordOn: 'same',
  }],
  ['turningOff from idle', off(idle), {
    open: 'same', edit: 'same', submit: 'same', dismiss: 'same', onDone: 'same', onRefreshed: 'same', onFailed: 'same', off: 'same',
    offDone: quiet(idle),
    offFailed: { phase: 'idle', error: FAIL },
    recordOn: 'same',
  }],
  ['turningOff from asking', off(asking), {
    open: 'same', edit: 'same', submit: 'same', dismiss: 'same', onDone: 'same', onRefreshed: 'same', onFailed: 'same', off: 'same',
    offDone: quiet(asking),
    offFailed: { ...asking, error: FAIL },
    recordOn: 'same',
  }],
  ['turningOff from refreshed', off(refreshed), {
    open: 'same', edit: 'same', submit: 'same', dismiss: 'same', onDone: 'same', onRefreshed: 'same', onFailed: 'same', off: 'same',
    offDone: INITIAL_STEP,
    offFailed: { ...refreshed, error: FAIL },
    recordOn: 'same',
  }],
];

const rows = table.flatMap(([label, state, next]) =>
  (Object.keys(events) as Name[]).map((name) => [label, name, state, events[name], next[name]] as const));

describe('reminders toggle machine: transition table (H116, US-17 AC18)', () => {
  it('names every event in every row', () => {
    expect(rows).toHaveLength(table.length * Object.keys(events).length);
  });
  it.each(rows)('%s + %s', (_label, _name, state, event, next) => {
    const after = transition(state, event);
    if (next === 'same') expect(after).toBe(state);
    else expect(after).toEqual(next);
  });
});

describe('reminders toggle machine: what the person sees', () => {
  it('a failure that needs no email keeps a field already asked for', () => {
    const asked: ToggleStep = { phase: 'turningOn', form: { ...FORM, needsEmail: true } };
    expect(transition(asked, { type: 'onFailed', message: FAIL, needsEmail: false }))
      .toEqual({ phase: 'asking', form: { ...FORM, needsEmail: true }, error: FAIL });
  });
  it.each<[string, ToggleStep, Resting, boolean]>([
    ['idle', idle, idle, false],
    ['asking', asking, asking, false],
    ['refreshed', refreshed, refreshed, false],
    ['turningOn shows its form, no words, buttons off', turningOn, { phase: 'asking', form: FORM, error: null }, true],
    ['turningOff shows the step under it, buttons off', off(asking), quiet(asking), true],
  ])('%s', (_label, state, view, isBusy) => {
    expect(shown(state)).toEqual(view);
    expect(busy(state)).toBe(isBusy);
  });
});
