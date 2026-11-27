/**
 * The erase's reminders teardown as one state (US-11 AC4c, AC15), kept apart
 * from reminders.ts, whose cancelRemindersForErase drives it.
 *
 * What the erase saw is not decided here: the record session keeps the erase's
 * observed set, every opt-in row seen in any copy or merge from the erase's
 * start to its swap (I1), and hands it to the commit. This state says only
 * whether the prepare ran and holds the Drive proof it fetched, in memory, for
 * the erase's span. The commit decides what to cancel from the freshest rows,
 * synchronously, just before its requests leave (I3, `toCancel`).
 */
import { rowsOf } from '@roadmap/health-core/reminder-rows';
import type { FileReminderOptIn, ReminderTokenRow } from '@roadmap/health-core/roadmap-file';

/** `ready`: the prepare ran, with the Drive proof when one could be had.
 *  `unprepared`: the prepare threw, nothing kept. `done`: committed, or never begun. */
export type EraseCancel =
  | { kind: 'unprepared' }
  | { kind: 'ready'; proof: string | null }
  | { kind: 'done' };
export type EraseCancelEvent =
  | { type: 'prepared' }
  | { type: 'proved'; proof: string | null }
  | { type: 'failed' }
  | { type: 'committed' };

export function eraseCancelTransition(state: EraseCancel, event: EraseCancelEvent): EraseCancel {
  switch (event.type) {
    case 'prepared':
      return { kind: 'ready', proof: null };
    case 'proved':
      return state.kind === 'ready' ? { kind: 'ready', proof: event.proof } : state;
    case 'failed':
      return state.kind === 'ready' ? { kind: 'unprepared' } : state;
    case 'committed':
      return { kind: 'done' };
  }
}

/** What the commit cancels: every active row the erase observed, unless a row
 *  where the erase now stands (the copy that took its write, this copy) holds
 *  that token active: it survived the erase (another device erased to the same
 *  epoch, then turned reminders on), so it is live consent (I3). */
export function toCancel(observed: FileReminderOptIn | undefined, standing: (FileReminderOptIn | undefined)[]): ReminderTokenRow[] {
  const live = new Set(standing.flatMap(rowsOf).filter((row) => row.status === 'active').map((row) => row.token));
  return rowsOf(observed).filter((row) => row.status === 'active' && !live.has(row.token));
}

let eraseCancel: EraseCancel = { kind: 'done' };
/** The teardown now, for the commit to read before it steps to `done`. */
export function eraseCancelState(): EraseCancel {
  return eraseCancel;
}
export function stepEraseCancel(event: EraseCancelEvent): void {
  eraseCancel = eraseCancelTransition(eraseCancel, event);
}
