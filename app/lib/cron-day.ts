/**
 * A daily cron's day on this machine, as one named state (US-28 AC7).
 *
 * - open: no run today and none going. A tick tries (the caller's hour gate
 *   and the shared lock decide the rest).
 * - running(date): a run is going. Every tick skips, whatever the date, so a
 *   run that outlasts midnight never has a second run started beside it. Past
 *   the cron's stuck limit the first tick reports it, once.
 * - done(date): the day ran here, or another machine holds its lock. A tick on
 *   that date skips; a tick on any other date tries.
 *
 * Every phase x event pair has a result, impossible ones included: none throws.
 */
export type CronDay =
  | { phase: 'open' }
  | { phase: 'running'; date: string; startedAt: number; reported: boolean }
  | { phase: 'done'; date: string };

export type CronDayEvent =
  | { type: 'tick'; today: string; now: number; limitMs: number }
  | { type: 'started'; date: string; now: number }
  | { type: 'finished' }
  | { type: 'failed' }
  | { type: 'held'; date: string };

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
      // Another machine holds the date's lock: that date is done here.
      return to({ phase: 'done', date: event.date });
  }
}
