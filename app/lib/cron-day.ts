/**
 * A daily cron's day on this machine, as one named state (US-28 AC7).
 *
 * - open: no run today and none going. A tick tries (the caller's hour gate
 *   and the shared lock decide the rest).
 * - running(date): a run is going. Every tick skips, whatever the date, so a
 *   run that outlasts midnight never has a second run started beside it. Past
 *   the cron's stuck limit the first tick reports it, once.
 * - done(date): the day ran here, or the lock closed it to this machine
 *   ('held'). A tick on that date skips; a tick on any other date tries.
 *   A busy lock (another machine's fresh run) is not done: the day goes back
 *   to open, so the next tick tries again (US-28 AC9).
 *
 * Every phase x event pair has a result, impossible ones included: none throws.
 */
import type { CronLockName } from './supabase-cron-lock.server';

const HOUR_MS = 60 * 60 * 1000;

/** Hours a run may take before it counts as stuck: a tick reports it (AC7) and
 *  the lock lets any machine take its day (AC9), at the same age.
 *  - trending: every step has its own time limit (15 s + 30 s + 30 s, in
 *    computeAndWriteTrending), so a healthy run ends in under 2 minutes; one
 *    still going an hour on has hung outside those limits.
 *  - reminders: 5 sends at a time, 50 opt-ins a page, growing with the opt-in
 *    count; at about a second per batch of 5, 6 hours covers some 100,000
 *    opt-ins, far past today's list, and still reports a hung pass the same day.
 *  - chat purge: the day's aged rows, one update per match event, plus an
 *    archive step capped at 5 minutes; at tens of milliseconds per row, 6 hours
 *    covers hundreds of thousands of rows, far past one day's chats. */
export const STUCK_AFTER_HOURS: Record<CronLockName, number> = {
  trending_cron: 1,
  trending_cron_edu: 1,
  reminder_v2_cron: 6,
  chat_text_purge: 6,
};

export const stuckLimitMs = (lockName: CronLockName): number => STUCK_AFTER_HOURS[lockName] * HOUR_MS;

/** The lock's clock for a tick: the tick's own now, and the oldest locked_at a
 *  live run may have. One clock, the cron's: the database's now() is never read. */
export function lockClock(lockName: CronLockName, now: Date): { now: Date; stuckCutoff: Date } {
  return { now, stuckCutoff: new Date(now.getTime() - stuckLimitMs(lockName)) };
}

export type CronDay =
  | { phase: 'open' }
  | { phase: 'running'; date: string; startedAt: number; reported: boolean }
  | { phase: 'done'; date: string };

export type CronDayEvent =
  | { type: 'tick'; today: string; now: number; limitMs: number }
  | { type: 'started'; date: string; now: number }
  | { type: 'finished' }
  | { type: 'failed' }
  | { type: 'held'; date: string }
  | { type: 'busy' };

export type TickDecision = 'skip' | 'try' | 'skip-and-report-stuck';

/** The next day, and for a tick (only), what the caller does. */
export interface CronDayStep {
  day: CronDay;
  decision: TickDecision | null;
}

/** The only way a CronDay changes. */
export function transition(day: CronDay, event: CronDayEvent): CronDayStep {
  const to = (next: CronDay): CronDayStep => ({ day: next, decision: null });
  switch (event.type) {
    case 'tick':
      if (day.phase === 'open') return { day, decision: 'try' };
      if (day.phase === 'done') return { day, decision: day.date === event.today ? 'skip' : 'try' };
      if (!day.reported && event.now - day.startedAt > event.limitMs) {
        return { day: { ...day, reported: true }, decision: 'skip-and-report-stuck' };
      }
      return { day, decision: 'skip' };
    case 'started':
      // Started while running cannot happen (a tick never tries then): the live run stays.
      return to(day.phase === 'running' ? day : { phase: 'running', date: event.date, startedAt: event.now, reported: false });
    case 'finished':
      // Finished with no run going cannot happen: nothing changes.
      return to(day.phase === 'running' ? { phase: 'done', date: day.date } : day);
    case 'failed':
      // A failure from any phase opens the day, so the next tick retries.
      return to({ phase: 'open' });
    case 'held':
      // The lock closed the date to this machine: that date is done here.
      return to({ phase: 'done', date: event.date });
    case 'busy':
      // Another machine's run is live: try again next tick. Busy while done
      // cannot happen (no acquire runs then): the done day stays.
      return to(day.phase === 'done' ? day : { phase: 'open' });
  }
}
