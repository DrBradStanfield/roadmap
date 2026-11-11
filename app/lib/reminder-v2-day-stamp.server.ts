/**
 * The reminder day-stamp (US-23 AC15): `reminder_optin_v2.attempting_on`, the
 * day a pass last went to email this row.
 *
 * NOT a mutex. Two passes running at once could both read an old stamp, both
 * write today and both pass the read-back, and both send. Keeping two passes
 * apart is the cron lock's job (US-28 AC9). The stamp guards a LATER re-run:
 * after a restart, a failed pass or a stuck takeover, that run reads today's
 * stamp and skips the row, so a send in flight when the old process died is
 * never repeated the same day.
 *
 * Order, strictly: read the stamp; if it names today or a later day, skip;
 * else write today, guarded in the UPDATE itself to a stamp that is NULL or
 * earlier than today (no `.select()`: the PostgREST gotcha), so a stalled
 * earlier-day pass whose write lands late never moves a later stamp back;
 * read it back with a separate select: a later day means skip, today means
 * send. Today from ANOTHER writer between our read and write also reads back
 * as today and passes: the stamp is not a mutex. Then the caller sends and
 * records last_sent. Nothing ever clears a stamp: a provider error after it
 * leaves it in place, so that person waits a day, and it expires by date.
 * Residual: if last_sent fails to record after a sent email, the person gets
 * a repeat the next day (reported at error level).
 */
import { requireAdmin } from './reminder-v2.server';

async function readStamp(id: string): Promise<string | null> {
  const { data, error } = await requireAdmin()
    .from('reminder_optin_v2')
    .select('attempting_on')
    .eq('id', id)
    .maybeSingle();
  if (error) throw new Error(`reminder_optin_v2 day-stamp read failed: ${error.message}`);
  if (!data) throw new Error('reminder_optin_v2 day-stamp: row gone');
  return (data.attempting_on as string | null) ?? null;
}

/** Stamp `today` on the opt-in before its send. 'attempted-today' means skip
 *  it; 'stamped' means send. Throws on a database error or a stamp that does
 *  not read back, and then nothing is sent. */
export async function stampReminderDay(id: string, today: string): Promise<'stamped' | 'attempted-today'> {
  // `today` goes into the `.or()` filter below: a date and nothing else.
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new Error('reminder_optin_v2 day-stamp: malformed date');
  const stamped = await readStamp(id);
  if (stamped !== null && stamped >= today) return 'attempted-today';

  const { error } = await requireAdmin()
    .from('reminder_optin_v2')
    .update({ attempting_on: today })
    .eq('id', id)
    .or(`attempting_on.is.null,attempting_on.lt.${today}`);
  if (error) throw new Error(`reminder_optin_v2 day-stamp write failed: ${error.message}`);

  const after = await readStamp(id);
  if (after !== null && after > today) return 'attempted-today';
  if (after !== today) throw new Error('reminder_optin_v2 day-stamp did not read back');
  return 'stamped';
}
