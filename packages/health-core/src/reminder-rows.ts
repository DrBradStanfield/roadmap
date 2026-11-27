/**
 * The reminders opt-in as one row per token (US-17 AC19, untangle R9).
 *
 * `reminderOptIn` keeps today's meaning, the newest row overall, and may hold
 * `tokens`: the newest row of every other token. Rows form a map of
 * last-write-wins registers keyed by token, so the merge is commutative,
 * associative and idempotent whatever order copies meet in. Every comparison
 * runs on rows with `tokens` stripped, the content tie-break included.
 * No DOM and no Node: engine-portability.test.ts checks.
 */
import { mergeByKey, stampIsNewer, timeOf } from './record-time';
import { stableStringify, type FileReminderOptIn, type ReminderTokenRow, type RoadmapFile } from './roadmap-file';

/** A row's own fields: its `tokens` key, if any, left out. */
export function ownRow<T extends object>(row: T): Omit<T, 'tokens'> {
  const { tokens: _tokens, ...own } = row as T & { tokens?: unknown };
  return own;
}

const newer = (a: ReminderTokenRow, b: ReminderTokenRow) => (stampIsNewer(b, a) ? b : a);

/** A row stamped before an erase time: its `updatedAt` instant against the
 *  erase instant, lamport aside. A row at the erase's very instant stays, as
 *  the gate keeps a row that shares the erase's millisecond; an unknown stamp
 *  is before any erase. No erase time, no floor. */
function beforeErase(row: ReminderTokenRow, erasedAt: string | undefined): boolean {
  return erasedAt !== undefined && timeOf(row.updatedAt) < timeOf(erasedAt);
}

/** The rows kept nested under a stored object: every other token's, less any before the erase. */
function keptNested(rows: ReminderTokenRow[], storedToken: unknown, erasedAt: string | undefined): ReminderTokenRow[] {
  return rows.filter((row) => row.token !== storedToken && !beforeErase(row, erasedAt));
}

/** The object's own row and every `tokens` row, one per token, the newest.
 *  A row whose token is empty or not a string (the erase's marker) is skipped. */
export function rowsOf(optIn: FileReminderOptIn | undefined): ReminderTokenRow[] {
  if (!optIn) return [];
  const rows = [optIn, ...(Array.isArray(optIn.tokens) ? optIn.tokens : [])]
    .filter((row) => typeof row?.token === 'string' && row.token !== '')
    .map((row) => ownRow(row));
  return mergeByKey(rows, [], (row) => row.token);
}

/**
 * The equal-epoch merge of two opt-ins. The stored object is the newest of
 * both objects' own rows (the erase marker included) and every row, which for
 * app-written copies is `pickNewerOptional` over the two objects, as before.
 * `tokens` holds every other token's row, sorted by token, and only when there
 * is one: a file with one real token is byte for byte what it was. `erasedAt`,
 * the merged file's erase time, is a floor for the nested rows only: one whose
 * `updatedAt` instant is before it is gone with the erase (`beforeErase`).
 */
export function mergeOptIn(local: FileReminderOptIn | undefined, remote: FileReminderOptIn | undefined, erasedAt?: string): FileReminderOptIn | undefined {
  if (!local && !remote) return undefined;
  const rows = mergeByKey(rowsOf(local), rowsOf(remote), (row) => row.token);
  // Remote first: an exact tie keeps the remote object, as `pickNewerOptional` did.
  const stored = [remote, local].flatMap((o) => (o ? [ownRow(o)] : [])).concat(rows).reduce(newer);
  const tokens = keptNested(rows, stored.token, erasedAt);
  return tokens.length > 0 ? { ...stored, tokens } : stored;
}

/** True when a re-read lost an opt-in row this save wrote: the stored object,
 *  or a row of `rowsOf`, has no row for its token as new in `theirs`. A nested
 *  row before the re-read's erase time is not owed: the merge drops it too. */
export function optInBehind(ours: FileReminderOptIn | undefined, theirs: FileReminderOptIn | undefined, erasedAt?: string): boolean {
  if (!ours) return false;
  // A hand-edited token that is not a string keys by its content, so two parsed copies agree.
  const keyOf = (token: unknown) => (typeof token === 'string' ? token : `\u0000${stableStringify(token)}`);
  const held = new Map(rowsOf(theirs).map((row) => [row.token, row]));
  // The stored object counts too, the erase marker included, which rowsOf skips.
  if (theirs && !held.has(keyOf(theirs.token))) held.set(keyOf(theirs.token), ownRow(theirs));
  return [ownRow(ours), ...keptNested(rowsOf(ours), ours.token, erasedAt)].some((row) => {
    const match = held.get(keyOf(row.token));
    return !match || stampIsNewer(row, match);
  });
}

/** What the reminders control shows: the newest active row, or else the
 *  stored object (which covers the erase marker). */
export function shownOptIn(file: Pick<RoadmapFile, 'reminderOptIn'>): ReminderTokenRow | undefined {
  const active = rowsOf(file.reminderOptIn).filter((row) => row.status === 'active');
  if (active.length > 0) return active.reduce(newer);
  return file.reminderOptIn && ownRow(file.reminderOptIn);
}
