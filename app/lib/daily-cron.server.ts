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

/** This machine's name in a `cron_lock` row, the same for every cron. */
export const MACHINE_ID = process.env.FLY_MACHINE_ID || `local-${process.pid}`;

const CRON_INTERVAL_MS = 60 * 60 * 1000;

export interface DailyCron {
  /** Log prefix, e.g. 'Trending cron'. */
  label: string;
  /** Sentry `feature` tag on a tick's error. */
  feature: string;
  lockName: CronLockName;
  targetHour: number;
  /** The hour and the lock_date on this cron's own clock. */
  clock: (now: Date) => { hour: number; dateStr: string };
  /** Logged once when the interval starts. */
  startLog: string;
  /** The day's work. A throw leaves the day open for the next tick. */
  run: (todayStr: string) => Promise<void>;
}

export function dailyCron(cron: DailyCron): { start: () => void; stop: () => void } {
  let lastRunDate: string | null = null;
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    try {
      const { hour, dateStr: todayStr } = cron.clock(new Date());
      if (hour < cron.targetHour) return;
      if (lastRunDate === todayStr) return;

      // Acquire stays inside the try/catch (US-28 AC2: a lock error retries next tick).
      const acquired = await tryAcquireCronLock(MACHINE_ID, todayStr, cron.lockName);
      if (!acquired) {
        lastRunDate = todayStr;
        return;
      }
      // Marked while the run goes, so a run that outlasts the hour is not
      // started twice on this machine; released if it fails, so the next tick
      // re-runs the day (US-28 AC3, AC6). The lock row names this machine, so
      // its re-acquire wins.
      lastRunDate = todayStr;
      await cron.run(todayStr).catch((runError: unknown) => {
        lastRunDate = null;
        throw runError;
      });
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
