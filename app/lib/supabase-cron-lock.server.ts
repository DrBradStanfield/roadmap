/**
 * The daily cron lock (atomic UPDATE, then a verify read).
 * Split out of supabase.server.ts (issue #429).
 */
import { supabaseAdmin } from './supabase-client.server';

/** Names of seeded `cron_lock` rows. New crons must add their lock name here AND
 *  seed a row in supabase/rls-policies.sql — typo on either side silently disables
 *  the cron (UPDATE matches zero rows → returns false → cron never runs). */
export type CronLockName = 'reminder_v2_cron' | 'trending_cron' | 'trending_cron_edu' | 'youtube_bot_summary' | 'chat_text_purge';

/** Attempt to acquire the cron lock for today. Returns true if this machine
 *  should run the cron; false if it lost the race or the lock is permanently
 *  unusable (no admin client, missing seed row). Uses an atomic UPDATE with
 *  WHERE clause to prevent race conditions between machines.
 *
 *  THROWS on transient DB errors (US-28 AC1): an error is not "another
 *  machine won", and returning false here made the erroring machine mark the
 *  day done and silently skip its daily job (Sentry JAVASCRIPT-REMIX-66/68).
 *  Callers keep the acquire inside their tick try/catch, which must NOT mark
 *  the day done — so the machine retries on the next tick. */
export async function tryAcquireCronLock(
  machineId: string,
  today: string,
  lockName: CronLockName,
): Promise<boolean> {
  if (!supabaseAdmin) return false;

  // `today` is interpolated into the PostgREST `.or()` filter below — guard
  // against anything other than a YYYY-MM-DD literal so a future caller
  // can't accidentally bypass the lock by passing a value containing `,` or `)`.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return false;

  // `lock_date IS NULL OR lock_date != today`. Required because seed rows can
  // start with lock_date = NULL, and `NULL != $today` evaluates to NULL in SQL
  // (treated as false) — so a bare `.neq` would never match unseeded locks and
  // the cron would fail silently.
  // Attempt to acquire the lock. PostgreSQL row-level locking serializes
  // concurrent UPDATEs to the same row, so this is the atomic CAS — only
  // one machine's UPDATE can match the `lock_date != today` predicate per
  // day.
  //
  // We do NOT use `.select()` here. PostgREST evaluates the WHERE filter
  // against the UPDATED row when returning representation. Because our
  // filter (`lock_date.neq.today`) excludes rows that have today's date,
  // and our UPDATE sets `lock_date = today`, the returned set is empty
  // even when the UPDATE committed. That bug silently broke the trending
  // and reminder crons for weeks — both acquired the lock at the DB level
  // but the function returned false, short-circuiting the cron callback.
  const updateRes = await supabaseAdmin
    .from('cron_lock')
    .update({
      locked_by: machineId,
      locked_at: new Date().toISOString(),
      lock_date: today,
    })
    .eq('lock_name', lockName)
    .or(`lock_date.is.null,lock_date.neq.${today}`);

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

  // Read back the row to determine who owns the lock for today. If this
  // machine's id + today's date are reflected, we won the CAS.
  const { data: verify, error: verifyErr } = await supabaseAdmin
    .from('cron_lock')
    .select('locked_by, lock_date')
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

  return verify.locked_by === machineId && verify.lock_date === today;
}
