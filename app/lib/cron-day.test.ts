import { describe, it, expect } from 'vitest';
import { lockClock, STUCK_AFTER_HOURS, transition, type CronDay, type CronDayEvent, type CronDayStep } from './cron-day';

// US-28 AC7: a daily cron's day, phase by event. Every pair has a row,
// impossible ones included, so none is left to chance.

const D = '2026-08-28';
const NEXT = '2026-08-29';
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const T0 = Date.UTC(2026, 7, 28, 4);
const LIMIT = 6 * HOUR;

const open: CronDay = { phase: 'open' };
const running: CronDay = { phase: 'running', date: D, startedAt: T0, reported: false };
const reported: CronDay = { ...running, reported: true };
const done: CronDay = { phase: 'done', date: D };

const tick = (today: string, after: number): CronDayEvent => ({ type: 'tick', today, now: T0 + after, limitMs: LIMIT });
const started: CronDayEvent = { type: 'started', date: NEXT, now: T0 + HOUR };
const finished: CronDayEvent = { type: 'finished' };
const failed: CronDayEvent = { type: 'failed' };
const held: CronDayEvent = { type: 'held', date: NEXT };
const busy: CronDayEvent = { type: 'busy' };

const step = (day: CronDay, decision: CronDayStep['decision'] = null): CronDayStep => ({ day, decision });

describe('US-28 AC7: cron day transition, phase by event', () => {
  it.each<[string, CronDay, CronDayEvent, CronDayStep]>([
    // open
    ['open, tick: tries', open, tick(D, 0), step(open, 'try')],
    ['open, started: running from now', open, started, step({ phase: 'running', date: NEXT, startedAt: T0 + HOUR, reported: false })],
    ['open, finished (impossible): stays open', open, finished, step(open)],
    ['open, failed: stays open', open, failed, step(open)],
    ['open, held: done on that date', open, held, step({ phase: 'done', date: NEXT })],
    ['open, busy (no acquire runs while open): stays open', open, busy, step(open)],
    // running
    ['running, tick the same day: skips', running, tick(D, HOUR), step(running, 'skip')],
    ["running, tick at the next day's hour, under the limit: skips", running, tick(NEXT, LIMIT), step(running, 'skip')],
    ['running, tick over the limit, not yet reported: skips and reports, once', running, tick(NEXT, LIMIT + 1), step(reported, 'skip-and-report-stuck')],
    ['running, tick over the limit, reported: plain skip', reported, tick(NEXT, 2 * LIMIT), step(reported, 'skip')],
    ['running, started (impossible): the live run stays', running, started, step(running)],
    ['running, finished: done on the run date', running, finished, step(done)],
    ['running, finished after a stuck report: done on the run date', reported, finished, step(done)],
    ['running, failed: open', running, failed, step(open)],
    ['running, held: done on that date', running, held, step({ phase: 'done', date: NEXT })],
    ['running, busy: open, so the next tick tries again (US-28 AC9)', running, busy, step(open)],
    ['running, busy after a stuck report: open', reported, busy, step(open)],
    // done
    ['done, tick on its date: skips', done, tick(D, HOUR), step(done, 'skip')],
    ['done, tick on another date: tries', done, tick(NEXT, DAY), step(done, 'try')],
    ['done, started: running from now', done, started, step({ phase: 'running', date: NEXT, startedAt: T0 + HOUR, reported: false })],
    ['done, finished (impossible): stays done', done, finished, step(done)],
    ['done, failed: open', done, failed, step(open)],
    ['done, held: done on that date', done, held, step({ phase: 'done', date: NEXT })],
    ['done, busy (impossible: no acquire runs while done): stays done', done, busy, step(done)],
  ])('%s', (_, day, event, next) => {
    expect(transition(day, event)).toEqual(next);
  });

  it('a busy answer at every tick keeps the day open: each later tick tries again (US-28 AC9)', () => {
    let day: CronDay = open;
    for (let h = 0; h < 3; h++) {
      const s = transition(day, tick(D, h * HOUR));
      expect(s.decision).toBe('try');
      day = transition(transition(s.day, { type: 'started', date: D, now: T0 + h * HOUR }).day, busy).day;
    }
    expect(day).toEqual(open);
  });

  it('a run that outlasts midnight is never tried beside, at any tick, until it ends', () => {
    let day: CronDay = running;
    const decisions = new Set<string>();
    for (let h = 1; h <= 48; h++) {
      const s = transition(day, tick(h < 20 ? D : NEXT, h * HOUR));
      day = s.day;
      decisions.add(s.decision!);
    }
    expect(decisions).toEqual(new Set(['skip', 'skip-and-report-stuck']));
    expect(transition(transition(day, finished).day, tick(NEXT, 49 * HOUR)).decision).toBe('try');
  });
});

// US-28 AC9: one table of stuck limits. A tick reports a run stuck, and the
// lock lets another machine take its day, at the same age.
describe('US-28 AC9: the stuck limits, shared by the tick and the lock', () => {
  it('one limit per lock name', () => {
    expect(STUCK_AFTER_HOURS).toEqual({ trending_cron: 1, trending_cron_edu: 1, reminder_v2_cron: 6, chat_text_purge: 6 });
  });
  it("the lock's stuck cutoff is the tick's now less that cron's limit", () => {
    const now = new Date(T0);
    expect(lockClock('reminder_v2_cron', now)).toEqual({ now, stuckCutoff: new Date(T0 - 6 * HOUR) });
    expect(lockClock('trending_cron', now)).toEqual({ now, stuckCutoff: new Date(T0 - HOUR) });
  });
});
