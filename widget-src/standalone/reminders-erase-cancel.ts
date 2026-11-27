/**
 * The erase's reminders teardown as one state (US-11 AC4c, lead S59b), kept
 * apart from reminders.ts, whose cancelRemindersForErase drives it.
 *
 * While it runs, this tab's erase can still merge in another device's Turn on
 * (a re-read while the prepare waits on the Drive proof, or on the chat
 * erase), even one that brings another erase with it. So every distinct active
 * token seen while this tab's erase runs, before its swap or while the erased
 * copy uploads, is kept until the commit, in memory only; spared if the record
 * still holds it active (`toCancel`): a merge during the upload can bring in
 * an opt-in that survives the erase (another device erased to the same epoch,
 * then turned reminders on). The
 * listener on hr:record-adopted (every merge taken in, announced or not,
 * US-11 AC15) is attached while the state is `watching`,
 * and only then: the transition says when.
 */
import { eraseRunsHere, getEraseIdentity, getReminderOptIn } from '../src/lib/roadmap-data';
import { RECORD_ADOPTED_EVENT } from '../src/storage/roadmap-store';
import { rowsOf } from '@roadmap/health-core/reminder-rows';
import type { FileReminderOptIn, ReminderTokenRow } from '@roadmap/health-core/roadmap-file';

/** `watching`: the erase began at `at`, and `cancels` holds each distinct
 *  active token seen, in order, the first with its Drive proof once fetched.
 *  `unprepared`: the prepare threw, nothing kept. `done`: committed, refused,
 *  or never begun. */
export type EraseCancel =
  | { kind: 'unprepared' }
  | { kind: 'watching'; at: string; cancels: { token: string; idToken: string | null }[] }
  | { kind: 'done' };
export type EraseCancelEvent =
  | { type: 'prepared'; at: string }
  // Rows the erase read: the prepare's first read, and at the commit every
  // copy the erase read up to its swap (US-11 AC15).
  | { type: 'read'; rows: ReminderTokenRow[] }
  // A re-read merged something in. `running`: this tab's erase still runs;
  // `identity`: the erase the record is at now.
  | { type: 'remote'; rows: ReminderTokenRow[]; running: boolean; identity: string }
  | { type: 'proved'; token: string; idToken: string | null }
  | { type: 'failed' }
  | { type: 'committed' };
export type EraseCancelEffect = { type: 'listen' } | { type: 'unlisten' };
export type EraseCancelStep = { state: EraseCancel; effects: EraseCancelEffect[] };

/** Into `watching` listens; out of it stops listening. */
function moved(from: EraseCancel, state: EraseCancel): EraseCancelStep {
  const was = from.kind === 'watching';
  const is = state.kind === 'watching';
  return { state, effects: was === is ? [] : [{ type: is ? 'listen' : 'unlisten' }] };
}

/** Each active row's token, once, after those already kept. */
function kept(state: Extract<EraseCancel, { kind: 'watching' }>, rows: ReminderTokenRow[]): EraseCancel {
  const active = rows.filter((row) => row.status === 'active');
  const fresh = active.filter((row, i) => !state.cancels.some((c) => c.token === row.token) && active.findIndex((r) => r.token === row.token) === i);
  return fresh.length === 0 ? state : { ...state, cancels: [...state.cancels, ...fresh.map(({ token }) => ({ token, idToken: null }))] };
}

export function eraseCancelTransition(state: EraseCancel, event: EraseCancelEvent): EraseCancelStep {
  if (event.type === 'prepared') return moved(state, { kind: 'watching', at: event.at, cancels: [] });
  if (event.type === 'committed') return moved(state, { kind: 'done' });
  if (state.kind !== 'watching') return moved(state, state);
  switch (event.type) {
    case 'read':
      return moved(state, kept(state, event.rows));
    case 'remote':
      if (event.running) return moved(state, kept(state, event.rows));
      // The erase ended where it began: refused or put back, and no commit
      // will come. Ended elsewhere, it landed: the commit is on its way.
      return moved(state, event.identity === state.at ? { kind: 'done' } : state);
    case 'proved':
      return moved(state, { ...state, cancels: state.cancels.map((c) => (c.token === event.token ? { ...c, idToken: event.idToken } : c)) });
    case 'failed':
      return moved(state, { kind: 'unprepared' });
  }
}

/** What the commit cancels: every token kept until the commit; spared if any
 *  row of the record holds it active once the erase stands, nested or not.
 *  That one survived the erase's save (another device erased to the same
 *  epoch, then turned reminders on), so it is live consent, not a pre-erase row. */
export function toCancel(state: EraseCancel, standing: (FileReminderOptIn | undefined)[]): { token: string; idToken: string | null }[] {
  if (state.kind !== 'watching') return [];
  const live = new Set(standing.flatMap(rowsOf).filter((row) => row.status === 'active').map((row) => row.token));
  return state.cancels.filter(({ token }) => !live.has(token));
}

let eraseCancel: EraseCancel = { kind: 'done' };
/** The teardown now, for the commit to read before it steps to `done`. */
export function eraseCancelState(): EraseCancel {
  return eraseCancel;
}
export function stepEraseCancel(event: EraseCancelEvent): void {
  const { state, effects } = eraseCancelTransition(eraseCancel, event);
  eraseCancel = state;
  for (const effect of effects) {
    if (effect.type === 'listen') window.addEventListener(RECORD_ADOPTED_EVENT, watchErase);
    else window.removeEventListener(RECORD_ADOPTED_EVENT, watchErase);
  }
}

function watchErase(): void {
  stepEraseCancel({ type: 'remote', rows: rowsOf(getReminderOptIn()), running: eraseRunsHere(), identity: getEraseIdentity() });
}
