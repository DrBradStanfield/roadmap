/**
 * US-15 AC71 (lead H49): the YouTube bot's lifecycle table, every state x event.
 * The bot posts public replies, so the rows that matter most: a tick runs only
 * from running, and nothing in stopped or stopping ever asks for one.
 */
import { describe, expect, it } from 'vitest';
import { transition, type Effect, type Lifecycle, type LifecycleEvent } from './youtube-bot-lifecycle';

const armed = { first: 'first-old', interval: 'interval-old' };
const fresh = { first: 'first-new', interval: 'interval-new' };
const afterFirst = { first: null, interval: 'interval-old' };

const stopped: Lifecycle<string> = { kind: 'stopped' };
const stopping: Lifecycle<string> = { kind: 'stopping' };
const running: Lifecycle<string> = { kind: 'running', timers: armed };
const ticking: Lifecycle<string> = { kind: 'ticking', timers: armed };

const start: LifecycleEvent<string> = { type: 'start', timers: fresh };
const stop: LifecycleEvent<string> = { type: 'stop' };
const dueFirst: LifecycleEvent<string> = { type: 'due', first: true };
const dueInterval: LifecycleEvent<string> = { type: 'due', first: false };
const done: LifecycleEvent<string> = { type: 'done' };

const none: Effect<string> = { kind: 'none' };
const tick: Effect<string> = { kind: 'tick' };
const busy: Effect<string> = { kind: 'busy' };
const clearOld: Effect<string> = { kind: 'clear', timers: armed, refused: false };
const refuseNew: Effect<string> = { kind: 'clear', timers: fresh, refused: true };

describe('US-15 AC71: the lifecycle table', () => {
  const rows: Array<[string, Lifecycle<string>, LifecycleEvent<string>, Lifecycle<string>, Effect<string>]> = [
    ['stopped + start arms the new timers', stopped, start, { kind: 'running', timers: fresh }, none],
    ['stopped + stop does nothing', stopped, stop, stopped, none],
    ['stopped + due runs no tick', stopped, dueFirst, stopped, none],
    ['stopped + due (interval) runs no tick', stopped, dueInterval, stopped, none],
    ['stopped + done stays stopped', stopped, done, stopped, none],

    ['running + start refuses and clears the new timers', running, start, running, refuseNew],
    ['running + stop clears its timers', running, stop, stopped, clearOld],
    ['running + first due runs a tick and drops the first timer', running, dueFirst, { kind: 'ticking', timers: afterFirst }, tick],
    ['running + interval due runs a tick', running, dueInterval, ticking, tick],
    ['running + done stays running', running, done, running, none],

    ['ticking + start refuses and clears the new timers', ticking, start, ticking, refuseNew],
    ['ticking + stop clears its timers; the tick finishes', ticking, stop, stopping, clearOld],
    ['ticking + first due is skipped', ticking, dueFirst, { kind: 'ticking', timers: afterFirst }, busy],
    ['ticking + interval due is skipped', ticking, dueInterval, ticking, busy],
    ['ticking + done is running again', ticking, done, running, none],

    ['stopping + start arms, held off until the last tick ends', stopping, start, { kind: 'ticking', timers: fresh }, none],
    ['stopping + stop does nothing', stopping, stop, stopping, none],
    ['stopping + due runs no tick', stopping, dueFirst, stopping, none],
    ['stopping + due (interval) runs no tick', stopping, dueInterval, stopping, none],
    ['stopping + done is stopped', stopping, done, stopped, none],
  ];

  it.each(rows)('%s', (_name, state, event, next, effect) => {
    expect(transition(state, event)).toEqual({ state: next, effect });
  });

  it('only running asks for a tick', () => {
    const states = [stopped, stopping, running, ticking];
    const events = [start, stop, dueFirst, dueInterval, done];
    const ticks = states.flatMap((s) => events.filter((e) => transition(s, e).effect.kind === 'tick').map((e) => `${s.kind}+${e.type}`));
    expect(ticks).toEqual(['running+due', 'running+due']);
  });
});
