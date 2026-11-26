/**
 * Time and stamp primitives the record merge orders by: the day a stamp falls
 * on, the stamp parser, and the clock order (time first, the lamport on a
 * tie). Moved out of merge.ts unchanged (US-64, lead A1-2); merge.ts re-exports
 * the ones it exported, so old import paths keep working.
 */
import type { SyncStamp } from './roadmap-file';

/** Normalise an ISO timestamp to its calendar day — the slot granularity. */
export function dayOf(iso: string): string {
  return iso.slice(0, 10);
}

/** Whole UTC days from one ISO day to another; 0 when either does not parse. The one age rule every surface reads. */
export function daysBetween(from: string, to: string): number {
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) ? Math.floor(ms / 86_400_000) : 0;
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * The calendar day an instant falls on IN THE WRITER'S OWN TIMEZONE — what a
 * person means by "today". `dayOf` reads the day out of a stored string and is
 * right for that; using it on a clock reading puts an 11am Auckland write on
 * yesterday, because the instant is still 23:00Z.
 */
export function localDay(instant: string | Date): string {
  const d = instant instanceof Date ? instant : new Date(instant);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * How far ahead of UTC the earliest-rising timezone runs (Kiritimati, UTC+14).
 */
const MAX_UTC_OFFSET_MS = 14 * 3_600_000;

/**
 * The latest calendar day anyone on Earth has reached at `now`. A server in
 * UTC cannot know the user's timezone, so this — not its own local day — is
 * the only future check it can make without refusing the day an Auckland user
 * is living in (US-31 AC6/AC11).
 */
export function latestDayOnEarth(now: string | Date): string {
  const ms = now instanceof Date ? now.getTime() : Date.parse(now);
  return dayOf(new Date(ms + MAX_UTC_OFFSET_MS).toISOString());
}

/** Stable string comparison (-1 | 0 | 1). */
export function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export type Clock = Required<SyncStamp>;

/** A stamp as the merge compares and stores it: the two clocks, nothing else. */
export function clockOf(stamp: SyncStamp): Clock {
  return { lamport: stamp.lamport ?? 0, updatedAt: stamp.updatedAt };
}

/** A stamp's time as the merge orders it: the instant, or -Infinity for a
 *  time that is unknown (`""` after migrate) or does not parse. */
export function timeOf(iso: string | undefined): number {
  const t = stampInstant(iso);
  return Number.isNaN(t) ? -Infinity : t;
}

/**
 * -1, 0 or 1: the newer edit by clock time wins (US-10 AC8, Brad 2026-10-22);
 * the lamport only breaks a tie in time. Two spellings of one instant with one
 * lamport compare 0, so a winner falls to the value or content tie-break, never
 * to the spelling. Wall-clock time is not skew-proof: a device whose clock runs
 * ahead wins until real time passes it, or until an edit made after seeing it,
 * which stamps no earlier (`laterStamp`).
 */
export function cmpClock(a: Clock, b: Clock): number {
  const [ta, tb] = [timeOf(a.updatedAt), timeOf(b.updatedAt)];
  if (ta !== tb) return ta < tb ? -1 : 1;
  return a.lamport === b.lamport ? 0 : a.lamport < b.lamport ? -1 : 1;
}

/** `cmpClock`, then the spelling: which of two clocks to STORE, so a tie
 *  writes the same spelling whichever side merges. Never picks a value. */
export function cmpStored(a: Clock, b: Clock): number {
  return cmpClock(a, b) || cmpStr(a.updatedAt, b.updatedAt);
}

/**
 * The time a write stamps: `now`, or the stamp it replaces when that is later
 * (US-10 AC8). With the counter one past it too, an edit always beats the
 * value it was made on, even one a clock running ahead stamped. The merge
 * itself cannot read `now` and stay pure, so this is the skew guard.
 */
export function laterStamp(now: string, replaced: string | undefined): string {
  return timeOf(replaced) > timeOf(now) ? (replaced as string) : now;
}

/** The stamps this parser reads: a day, alone or with a time after a T, a t or
 *  a space, and an optional zone (Z, z, +HHMM or +HH:MM; an hour-only +HH only
 *  after a space, Postgres's text style). Looser than `migrate.ts`'s STAMP,
 *  which needs a zone after a space and keeps an offset within 00-14 hours and
 *  00-59 minutes; its `isStamp` takes only what both accept. */
const STAMP_PARTS = /^(\d{4}-\d{2}-\d{2})(?:(?:[Tt](\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?([Zz]|[+-]\d{2}:?\d{2})?)|(?: (\d{2}:\d{2}(?::\d{2})?)(?:\.(\d+))?([Zz]|[+-]\d{2}(?::?\d{2})?)?))?$/;

/**
 * An ISO stamp as an instant; NaN when it is not a string or not a stamp, and
 * NaN compares false. A date-time with no zone reads as UTC, as a date-only
 * string already does, never as this machine's local time. The stamp is
 * rebuilt in the one form ECMAScript defines before parsing, and a day the
 * calendar lacks or a time past 23:59:59 is NaN, so V8 and the iPhone's
 * JavaScriptCore give the same answer for every string (US-10 AC8 review, R3, N1).
 */
export function stampInstant(iso: unknown): number {
  const m = typeof iso === 'string' ? STAMP_PARTS.exec(iso) : null;
  if (!m) return NaN;
  const [day, time, fraction, zone] = [m[1], m[2] ?? m[5], m[3] ?? m[6], m[4] ?? m[7]];
  // Engines differ on what they roll over (V8 reads 2026-02-30 as March 2),
  // so a day the calendar lacks, an hour of 24 or a leap second is no time.
  const [y, mo, d] = day.split('-').map(Number);
  const [h, mi, s = 0] = (time ?? '00:00').split(':').map(Number);
  const utc = new Date(Date.UTC(y, mo - 1, d));
  if (utc.getUTCFullYear() !== y || utc.getUTCMonth() !== mo - 1 || utc.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return NaN;
  if (time === undefined) return Date.parse(day);
  const offset = !zone || /^[Zz]$/.test(zone) ? 'Z' : `${zone.slice(0, 3)}:${zone.slice(3).replace(':', '') || '00'}`;
  return Date.parse(`${day}T${time}${fraction ? `.${fraction.padEnd(3, '0').slice(0, 3)}` : ''}${offset}`);
}

/** The later of two ISO stamps as instants; of one instant in two spellings,
 *  the larger string, so the choice is the same in either order. */
export function latestStamp(a: string, b: string): string {
  const [ta, tb] = [timeOf(a), timeOf(b)];
  return ta !== tb ? (ta > tb ? a : b) : a > b ? a : b;
}
