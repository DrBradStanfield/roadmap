/**
 * The daily cron lock (atomic UPDATE, then a verify read), and the write that
 * records how the run ended (US-28 AC9). Split out of supabase.server.ts (issue #429).
 */
import * as Sentry from '@sentry/react-router';
import { supabaseAdmin } from './supabase-client.server';

/** Names of seeded `cron_lock` rows. New crons must add their lock name here AND
 *  seed a row in supabase/rls-policies.sql — typo on either side silently disables
 *  the cron (UPDATE matches zero rows → returns false → cron never runs). */
export type CronLockName = 'reminder_v2_cron' | 'trending_cron' | 'trending_cron_edu' | 'chat_text_purge';

/** The one clock a claim is made on, the caller's (cron-day.ts lockClock): the
 *  run's start, written as locked_at, and the oldest locked_at a live run may have. */
export interface CronLockClock {
  now: Date;
  stuckCutoff: Date;
}

/** Fly machine ids are lowercase hex; anything else could break the filter below. */
const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The rows `me` may take for `today` (US-28 AC9), as one PostgREST `.or()`:
 *  - lock_date IS NULL: a seed row;
 *  - an earlier day, unless a run on it is still live: run_state is NULL (a
 *    legacy row), or not 'running', or its locked_at is past the stuck cutoff;
 *  - today, this machine's own failed or running row: its own retry (AC3, AC6).
 *    A running row of its own means a dead run: while a run lives, this
 *    process's CronDay never calls the acquire;
 *  - today, anyone's running row past the stuck cutoff: a dead run frees its day.
 * Refused: today finished, or today NULL (a legacy row reads as finished), to
 * every machine, this one included. Today failed on ANOTHER machine is refused
 * too: one retry path, the owner's, and no ping-pong; the next day takes it, so
 * if the owner never returns the cost is one skipped day.
 *
 * `run_state.neq.running` is NULL, not true, on a NULL row, so the branch that
 * must match a legacy row carries its own `run_state.is.null` arm. A null
 * `me` (no FLY_MACHINE_ID) owns nothing: the own-row branch is left out.
 * lock_date is TEXT YYYY-MM-DD on the cron's own clock, so `lt` is a date compare.
 */
function takeableFilter(me: string | null, today: string, stuckCutoff: string): string {
  const branches = [
    'lock_date.is.null',
    `and(lock_date.lt.${today},or(run_state.is.null,run_state.neq.running,locked_at.lt.${stuckCutoff}))`,
    ...(me === null ? [] : [`and(lock_date.eq.${today},locked_by.eq.${me},run_state.in.(failed,running))`]),
    `and(lock_date.eq.${today},run_state.eq.running,locked_at.lt.${stuckCutoff})`,
  ];
  return branches.join(',');
}

/** What an acquire answers (US-28 AC9). Not 'finished': 'closed' also covers
 *  a day that failed on another machine, a later day and an unusable lock,
 *  none of which finished; all mean the same to the caller: not today, here.
 *  - won: this machine runs the day now.
 *  - closed: the day is not this machine's; end it here (CronDay 'held').
 *  - busy: not now, maybe later; the day stays open and the next tick tries. */
export type CronLockResult = 'won' | 'closed' | 'busy';

/**
 * Every not-won answer, by the row the verify read returns (US-28 AC9).
 * A lost race is answered from the same row: whatever won is what it shows.
 *
 * | verify row                                         | answer |
 * |----------------------------------------------------|--------|
 * | today, finished                                    | closed |
 * | today, run_state NULL (a legacy row)               | closed |
 * | today, failed, another owner (or no id here)       | closed |
 * | a later day than today                             | closed |
 * | today, running (fresh; or stuck/own, a lost race)  | busy   |
 * | today, failed, this machine's own (a lost race)    | busy   |
 * | an earlier day (running and fresh, or a lost race) | busy   |
 * | the seed (lock_date NULL), or any other run_state  | busy   |
 *
 * Today failed on another machine is closed, not busy: the filter gives it
 * back to its owner only, so trying every hour would be trying for nothing.
 * Busy is the default: a row this table does not name may change by the next
 * tick, and a wrong 'closed' skips a day while a wrong 'busy' costs one query.
 * Not from a row: the verify erroring, or the row missing, THROWS (AC1, AC2);
 * no admin client, a malformed date or an unsafe machine id answer 'closed',
 * since nothing in this process can change them.
 */
export function notWonAnswer(
  row: { locked_by: string | null; lock_date: string | null; run_state: string | null },
  me: string | null,
  today: string,
): 'closed' | 'busy' {
  if (row.lock_date !== null && row.lock_date > today) return 'closed';
  if (row.lock_date !== today) return 'busy';
  if (row.run_state === 'finished' || row.run_state === null) return 'closed';
  if (row.run_state === 'failed' && (me === null || row.locked_by !== me)) return 'closed';
  return 'busy';
}

let unsafeIdReported = false;

/** A FLY_MACHINE_ID the filter cannot carry stops every daily cron on this
 *  machine, so say so once per process: fixed text, never the value. */
function reportUnsafeId(): void {
  if (unsafeIdReported) return;
  unsafeIdReported = true;
  console.error('Cron lock: FLY_MACHINE_ID is not a safe id; daily crons will not run on this machine');
  Sentry.captureMessage('Cron lock: unsafe FLY_MACHINE_ID, daily crons off', { level: 'error', tags: { feature: 'cron_lock' } });
}

/** Attempt to acquire the cron lock for today: 'won', 'closed' or 'busy'
 *  (CronLockResult, notWonAnswer's table). `machineId` null means no owner:
 *  such a caller never wins by ownership. It writes `clock.now` as locked_at:
 *  a winner passes that same Date on, as `lockedAt`, to stillHoldsLock and
 *  endCronLock, which match the run by it.
 *
 *  THROWS on transient DB errors (US-28 AC1): an error is not "another
 *  machine won", and returning a not-won answer here made the erroring machine
 *  mark the day done and silently skip its daily job (Sentry
 *  JAVASCRIPT-REMIX-66/68). Callers keep the acquire inside their tick
 *  try/catch, which must NOT mark the day done — so the machine retries on
 *  the next tick. */
export async function tryAcquireCronLock(
  machineId: string | null,
  today: string,
  lockName: CronLockName,
  clock: CronLockClock,
): Promise<CronLockResult> {
  if (!supabaseAdmin) return 'closed';

  // `today` and the machine id are interpolated into the PostgREST `.or()`
  // filter below — guard against anything that could contain `,` or `)` so a
  // future caller can't accidentally bypass the lock. The cutoff comes from
  // toISOString, which has neither.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return 'closed';
  if (machineId !== null && !SAFE_ID.test(machineId)) {
    reportUnsafeId();
    return 'closed';
  }
  const lockedAt = clock.now.toISOString();

  // PostgreSQL row-level locking serializes concurrent UPDATEs to the same
  // row, so this is the atomic CAS: once one machine's UPDATE sets today's
  // running row, the filter refuses every other machine's.
  //
  // We do NOT use `.select()` here. PostgREST evaluates the WHERE filter
  // against the UPDATED row when returning representation, and the update
  // makes the row fail the filter, so the returned set is empty even when the
  // UPDATE committed. That bug silently broke the trending and reminder crons
  // for weeks — both acquired the lock at the DB level but the function
  // returned false, short-circuiting the cron callback.
  const updateRes = await supabaseAdmin
    .from('cron_lock')
    .update({
      locked_by: machineId,
      locked_at: lockedAt,
      lock_date: today,
      run_state: 'running',
    })
    .eq('lock_name', lockName)
    .or(takeableFilter(machineId, today, clock.stuckCutoff.toISOString()));

  if (updateRes.error) {
    // Transient failure — throw so the caller's tick catch retries next tick
    // (the catch also owns the Sentry capture; capturing here too would
    // double-report every error).
    console.error(`Error acquiring cron lock (${lockName}):`, updateRes.error);
    throw new Error(
      `cron lock acquire failed (${lockName}): ${updateRes.error.message}`,
      { cause: updateRes.error },
    );
  }

  // Read back the row: this call won only if the row shows what it wrote. A
  // stale row of this machine's own (an older locked_at) is not a win.
  const { data: verify, error: verifyErr } = await supabaseAdmin
    .from('cron_lock')
    .select('locked_by, lock_date, run_state, locked_at')
    .eq('lock_name', lockName)
    .maybeSingle();

  if (verifyErr) {
    console.error(`Could not verify cron lock state (${lockName}):`, verifyErr);
    throw new Error(
      `cron lock verify failed (${lockName}): ${verifyErr.message}`,
      { cause: verifyErr },
    );
  }
  // No row at all = missing seed row (see CronLockName) — permanent
  // misconfig, not transient. It must not read as `false`: every caller takes
  // that as "another machine won today" and marks the day done, so a missing
  // row silently retired the job. Throw instead — the callers' catches report
  // it to Sentry and leave the day unclaimed.
  if (!verify) {
    console.error(`Cron lock row missing (${lockName}) — check the seed in rls-policies.sql`);
    throw new Error(
      `cron lock row missing (${lockName}) — seed it in rls-policies.sql`,
    );
  }

  // locked_at compares as an instant: Postgres answers in microseconds with
  // its own offset form (2026-11-11T05:54:00.123000+00:00), never our string.
  // A null owner can win only through this call's own write (seed, earlier
  // day, stuck): the filter gave it no own-row branch.
  const won =
    verify.locked_by === machineId &&
    verify.lock_date === today &&
    verify.run_state === 'running' &&
    Date.parse(verify.locked_at) === clock.now.getTime();
  return won ? 'won' : notWonAnswer(verify, machineId, today);
}

/** Does this run still hold its lock (US-23 AC15)? True only if the row
 *  still carries `me` as locked_by and the locked_at this run's acquire wrote,
 *  compared as an instant. Fails closed: a read that errors, throws or finds
 *  no row answers false, so the caller sends nothing more. Never throws. */
export async function stillHoldsLock(lockName: CronLockName, me: string | null, lockedAt: Date): Promise<boolean> {
  if (!supabaseAdmin) return false;
  try {
    const { data, error } = await supabaseAdmin
      .from('cron_lock')
      .select('locked_by, locked_at')
      .eq('lock_name', lockName)
      .maybeSingle();
    if (error) throw error;
    return !!data && data.locked_by === me && Date.parse(data.locked_at) === lockedAt.getTime();
  } catch (error) {
    Sentry.captureException(error, { tags: { feature: 'cron_lock' } });
    return false;
  }
}

/** Record how this machine's run of `date` ended: 'finished' (with its end
 *  time) or 'failed' (US-28 AC9). Keyed by the lock, this owner, the run's
 *  date and the locked_at its acquire wrote, so a stale run can never mark a
 *  newer day, another machine's row, or a later run of this machine's own (a
 *  delayed 'failed' landing after a restarted run's 'finished'). `lockedAt`
 *  goes as an ISO string; Postgres reads it as a timestamptz and compares
 *  instants, whatever form it stores. A separate update with no `.select()`
 *  (the gotcha above). Never throws: an error is logged and reported, and
 *  the row stays 'running' — its own machine
 *  retakes it after a restart; another machine meets it as 'busy' and keeps
 *  trying each tick, and takes it once it passes the stuck limit. */
export async function endCronLock(
  machineId: string | null,
  date: string,
  lockName: CronLockName,
  lockedAt: Date,
  outcome: 'finished' | 'failed',
  now: Date,
): Promise<void> {
  if (!supabaseAdmin) return;
  const write = supabaseAdmin
    .from('cron_lock')
    .update(outcome === 'finished' ? { run_state: 'finished', finished_at: now.toISOString() } : { run_state: 'failed' })
    .eq('lock_name', lockName)
    .eq('lock_date', date)
    .eq('locked_at', lockedAt.toISOString());
  const { error } = await (machineId === null ? write.is('locked_by', null) : write.eq('locked_by', machineId));
  if (error) {
    console.error(`Could not mark cron lock ${outcome} (${lockName}):`, error.message);
    Sentry.captureException(error, { tags: { feature: 'cron_lock' } });
  }
}
