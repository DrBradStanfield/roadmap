/**
 * The daily cron runner (untangle S-4): an hourly tick that runs a job once a
 * day, on the first tick at or after its target hour, behind its `cron_lock`
 * row so only one machine runs it.
 *
 * Built on the machinery the May-2026 cron debugging hardened (CLAUDE.md
 * "Dangerous Gotchas"): the `< target hour` check, not `!==`, makes it
 * deploy-resilient, since a restart that shifts the interval past the hour
 * still fires today via the lock; tryAcquireCronLock's fixed CAS does the rest,
 * and endCronLock records how the run ended (US-28 AC9).
 */
import * as Sentry from '@sentry/react-router';
import { endCronLock, tryAcquireCronLock, type CronLockName } from './supabase-cron-lock.server';
import { safeErrorFields } from './safe-error-fields.server';
import { lockClock, stuckLimitMs, transition, type CronDay } from './cron-day';

/** This machine's name in a `cron_lock` row, the same for every cron. With no
 *  FLY_MACHINE_ID (local, tests) there is no owner: null, which never wins a
 *  day by ownership (US-28 AC9). */
export const MACHINE_ID: string | null = process.env.FLY_MACHINE_ID || null;
/** MACHINE_ID for a log line. */
export const MACHINE_LABEL = MACHINE_ID ?? 'none';

const CRON_INTERVAL_MS = 60 * 60 * 1000;

/** A run that finds its lock taken returns this (US-23 AC15): no end state is
 *  written, since the row is another run's now and the keyed end write would
 *  refuse anyway, and the day reopens, so the next tick asks the lock. */
export const LOCK_LOST = Symbol('lock lost');

let sharedLineLogged = false;

/** Reminders and the chat purge share one `cron_lock` row across both Fly apps,
 *  and run with the winning app's env, so they run only on health-tool-app
 *  (US-28 AC8, US-23 AC14). Only the exact string 'true' (fly.toml [env]) turns
 *  them on. Logs one fixed line, the first time a machine asks. */
export function sharedCronsOn(): boolean {
  const on = process.env.RUN_SHARED_CRONS === 'true';
  if (!sharedLineLogged) {
    sharedLineLogged = true;
    console.log(on ? 'Shared crons (reminders, chat purge): on' : "Shared crons (reminders, chat purge): off (RUN_SHARED_CRONS is not 'true')");
  }
  return on;
}

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
  /** Its lock row is shared by both Fly apps: starts only where sharedCronsOn(). */
  shared?: boolean;
  targetHour: number;
  /** The hour and the lock_date on this cron's own clock. */
  clock: (now: Date) => { hour: number; dateStr: string };
  /** Logged once when the interval starts. */
  startLog: string;
  /** The day's work. A throw leaves the day open for the next tick. Its
   *  returned line is logged after the day is safely marked. `lockedAt` is the
   *  locked_at its acquire wrote, for stillHoldsLock. */
  run: (todayStr: string, lockedAt: Date) => Promise<string | void | typeof LOCK_LOST>;
}

export function dailyCron(cron: DailyCron): { start: () => void; stop: () => void } {
  let day: CronDay = { phase: 'open' };
  let intervalId: ReturnType<typeof setInterval> | null = null;

  async function tick(): Promise<void> {
    try {
      const now = new Date();
      const { hour, dateStr: todayStr } = cron.clock(now);
      const step = transition(day, { type: 'tick', today: todayStr, now: now.getTime(), limitMs: stuckLimitMs(cron.lockName) });
      day = step.day;
      if (step.decision === 'skip-and-report-stuck' && day.phase === 'running') {
        reportStuckRun(cron.label, cron.feature, day.startedAt, now.getTime());
      }
      if (step.decision !== 'try' || hour < cron.targetHour) return;

      // Running from before the acquire, so a run that outlasts the hour, or
      // midnight, is never started twice on this machine. A throw (a lock error
      // included, US-28 AC2) opens the day so the next tick retries (AC3, AC6);
      // a failed run marks its row failed, which this machine alone may retake.
      day = transition(day, { type: 'started', date: todayStr, now: now.getTime() }).day;
      const fail = (error: unknown): never => {
        day = transition(day, { type: 'failed' }).day;
        throw error;
      };
      const lock = await tryAcquireCronLock(MACHINE_ID, todayStr, cron.lockName, lockClock(cron.lockName, now)).catch(fail);
      if (lock !== 'won') {
        // Closed ends the day here; busy reopens it, so every hourly tick
        // after the target hour tries again (US-28 AC9).
        day = transition(day, lock === 'busy' ? { type: 'busy' } : { type: 'held', date: todayStr }).day;
        return;
      }
      // The acquire wrote `now` as locked_at: the end writes and the fence match it.
      const completed = await cron.run(todayStr, now).catch(async (runError: unknown) => {
        await endCronLock(MACHINE_ID, todayStr, cron.lockName, now, 'failed', new Date());
        return fail(runError);
      });
      if (completed === LOCK_LOST) {
        day = transition(day, { type: 'busy' }).day;
        return;
      }
      day = transition(day, { type: 'finished' }).day;
      // A finished day is refused to every machine, this one after a restart included (AC9).
      await endCronLock(MACHINE_ID, todayStr, cron.lockName, now, 'finished', new Date());
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
      if (cron.shared && !sharedCronsOn()) return;
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
