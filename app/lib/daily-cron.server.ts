/**
 * The daily cron runner (untangle S-4): an hourly tick that runs a job once a
 * day, on the first tick at or after its target hour, behind its `cron_lock`
 * row so only one machine runs it.
 *
 * Built on the machinery the May-2026 cron debugging hardened (CLAUDE.md
 * "Dangerous Gotchas"): the `< target hour` check, not `!==`, makes it
 * deploy-resilient, since a restart that shifts the interval past the hour
 * still fires today via the lock; tryAcquireCronLock's fixed CAS does the rest.
 */
import * as Sentry from '@sentry/react-router';
import { tryAcquireCronLock, type CronLockName } from './supabase.server';
import { safeErrorFields } from './safe-error-fields.server';
import { transition, type CronDay } from './cron-day';

/** This machine's name in a `cron_lock` row, the same for every cron. */
export const MACHINE_ID = process.env.FLY_MACHINE_ID || `local-${process.pid}`;

const CRON_INTERVAL_MS = 60 * 60 * 1000;

/** One Sentry message, fixed text and tags (the cron, the hours), when a run
 *  outlasts its cron's stuck limit (US-28 AC7). No ids, no error text. */
export function reportStuckRun(label: string, feature: string, startedAt: number, now: number): void {
  const hours = Math.round((now - startedAt) / CRON_INTERVAL_MS);
  console.error(`${label} run still going after ${hours} h`);
  Sentry.captureMessage('Daily cron run still going', { level: 'warning', tags: { feature, hours } });
}

export interface DailyCron {
  /** Log prefix, e.g. 'Trending cron'. */
  label: string;
  /** Sentry `feature` tag on a tick's error. */
  feature: string;
  lockName: CronLockName;
  targetHour: number;
  /** Hours a run may take before a tick reports it stuck (US-28 AC7). */
  stuckAfterHours: number;
  /** The hour and the lock_date on this cron's own clock. */
  clock: (now: Date) => { hour: number; dateStr: string };
  /** Logged once when the interval starts. */
  startLog: string;
  /** The day's work. A throw leaves the day open for the next tick. Its
   *  returned line is logged after the day is safely marked. */
  run: (todayStr: string) => Promise<string | void>;
}

export function dailyCron(cron: DailyCron): { start: () => void; stop: () => void } {
  let day: CronDay = { phase: 'open' };
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    try {
      const now = new Date();
      const { hour, dateStr: todayStr } = cron.clock(now);
      const step = transition(day, { type: 'tick', today: todayStr, now: now.getTime(), limitMs: cron.stuckAfterHours * CRON_INTERVAL_MS });
      day = step.day;
      if (step.decision === 'skip-and-report-stuck' && day.phase === 'running') {
        reportStuckRun(cron.label, cron.feature, day.startedAt, now.getTime());
      }
      if (step.decision !== 'try' || hour < cron.targetHour) return;

      // Running from before the acquire, so a run that outlasts the hour, or
      // midnight, is never started twice on this machine. A throw (a lock error
      // included, US-28 AC2) opens the day so the next tick retries (AC3, AC6);
      // the lock row names this machine, so its re-acquire wins.
      day = transition(day, { type: 'started', date: todayStr, now: now.getTime() }).day;
      let completed: string | void;
      try {
        if (!(await tryAcquireCronLock(MACHINE_ID, todayStr, cron.lockName))) {
          day = transition(day, { type: 'held', date: todayStr }).day;
          return;
        }
        completed = await cron.run(todayStr);
      } catch (runError) {
        day = transition(day, { type: 'failed' }).day;
        throw runError;
      }
      day = transition(day, { type: 'finished' }).day;
      if (completed) console.log(completed);
    } catch (error) {
      console.error(`${cron.label} error:`, safeErrorFields(error));
      Sentry.captureException(error, { tags: { feature: cron.feature } });
    }
  }

  return {
    start() {
      // These modules self-start on import, so without the 'test' case every
      // suite that imports one would spawn a real hourly interval.
      if (process.env.NODE_ENV === 'development' || process.env.NODE_ENV === 'test') {
        console.log(`${cron.label} disabled in ${process.env.NODE_ENV}`);
        return;
      }
      console.log(cron.startLog);
      intervalId = setInterval(tick, CRON_INTERVAL_MS);
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
        console.log(`${cron.label} stopped`);
      }
    },
  };
}
