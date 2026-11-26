/**
 * The five-second pause between re-reads of the record (US-34, lead H31). It
 * stops two return signals that fire together (focus and visibilitychange on
 * the web, the minute poll) from making two round trips out of one return. It
 * throttles automatic re-reads only: a pressed "Sync now" always reads, so it
 * never says "Synced" over a read it skipped (Brad 2026-11-26).
 */
export const REMOTE_THROTTLE_MS = 5_000;

/** Why the record is re-read: the person pressed Sync now, or something automatic did. */
export type RefreshReason = 'pressed' | 'automatic';

/** The one place that decides whether a re-read runs now, `last` being the last one's start (epoch millis). */
export function refreshDue(reason: RefreshReason, now: number, last: number): boolean {
  return reason === 'pressed' || now - last >= REMOTE_THROTTLE_MS;
}
