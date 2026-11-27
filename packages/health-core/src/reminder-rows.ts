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
import { mergeByKey, stampIsNewer } from './record-time';
import { stableStringify, type FileReminderOptIn, type ReminderTokenRow, type RoadmapFile } from './roadmap-file';

/** A row's own fields: its `tokens` key, if any, left out. */
export function ownRow<T extends object>(row: T): Omit<T, 'tokens'> {
  const { tokens: _tokens, ...own } = row as T & { tokens?: unknown };
  return own;
}

const newer = (a: ReminderTokenRow, b: ReminderTokenRow) => (stampIsNewer(b, a) ? b : a);

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
 * is one: a file with one real token is byte for byte what it was. A superseded
 * erase marker is dropped: it is no token's row. The merge reads no erase time.
 */
export function mergeOptIn(local: FileReminderOptIn | undefined, remote: FileReminderOptIn | undefined): FileReminderOptIn | undefined {
  if (!local && !remote) return undefined;
  const rows = mergeByKey(rowsOf(local), rowsOf(remote), (row) => row.token);
  // Remote first: an exact tie keeps the remote object, as `pickNewerOptional` did.
  const stored = [remote, local].flatMap((o) => (o ? [ownRow(o)] : [])).concat(rows).reduce(newer);
  const tokens = rows.filter((row) => row.token !== stored.token);
  return tokens.length > 0 ? { ...stored, tokens } : stored;
}

/** True when a re-read lost an opt-in row this save wrote: merging ours into
 *  theirs, by the merge's own order, would change theirs. */
export function optInBehind(ours: FileReminderOptIn | undefined, theirs: FileReminderOptIn | undefined): boolean {
  return ours !== undefined && stableStringify(mergeOptIn(ours, theirs)) !== stableStringify(mergeOptIn(theirs, undefined));
}

/** What the reminders control shows: the newest active row, or else the
 *  stored object (which covers the erase marker). */
export function shownOptIn(file: Pick<RoadmapFile, 'reminderOptIn'>): ReminderTokenRow | undefined {
  const active = rowsOf(file.reminderOptIn).filter((row) => row.status === 'active');
  if (active.length > 0) return active.reduce(newer);
  return file.reminderOptIn && ownRow(file.reminderOptIn);
}

/** One address however it is cased or padded. */
export const addressKey = (email: string): string => email.trim().toLowerCase();

/** Every address an active row names, each once however it is cased or
 *  padded: the shown row's first, then the rest in order (US-17 AC19). A row
 *  with no address string names none, and still counts as on elsewhere. */
export function activeAddresses(file: Pick<RoadmapFile, 'reminderOptIn'>): string[] {
  const shown = shownOptIn(file);
  const active = rowsOf(file.reminderOptIn).filter((row) => row.status === 'active' && row.token !== shown?.token);
  const seen = new Set<string>();
  return [...(shown?.status === 'active' ? [shown] : []), ...active].flatMap(({ email }) => {
    if (typeof email !== 'string' || email.trim() === '') return [];
    const key = addressKey(email);
    if (seen.has(key)) return [];
    seen.add(key);
    return [email];
  });
}
