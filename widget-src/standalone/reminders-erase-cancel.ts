/**
 * The erase's reminders teardown as one state (US-11 AC4c, lead S59b), kept
 * apart from reminders.ts, whose cancelRemindersForErase drives it.
 *
 * Until its swap, this tab's erase can still merge in another device's Turn on
 * (a re-read while the prepare waits on the Drive proof, or on the chat
 * erase), even one that brings another erase with it. So from the prepare's
 * first read until the commit, every distinct active token seen while this
 * tab's erase runs is kept, in memory only, to be cancelled. While the erased
 * copy uploads, a merge can still bring in an opt-in that survives the erase
 * (another device erased to the same epoch, then turned reminders on): the
 * commit leaves the one the record still holds active (`toCancel`). The
 * listener on hr:remote-changed is attached while the state is `watching`,
 * and only then: the transition says when.
 */
import { eraseRunsHere, getEraseIdentity, getReminderOptIn } from '../src/lib/roadmap-data';
import { REMOTE_CHANGED_EVENT } from '../src/storage/roadmap-store';
import type { FileReminderOptIn } from '@roadmap/health-core/roadmap-file';

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
  | { type: 'read'; optIn: FileReminderOptIn | undefined } // the prepare's first read
  // A re-read merged something in. `running`: this tab's erase still runs;
  // `identity`: the erase the record is at now.
  | { type: 'remote'; optIn: FileReminderOptIn | undefined; running: boolean; identity: string }
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

function kept(state: Extract<EraseCancel, { kind: 'watching' }>, optIn: FileReminderOptIn | undefined): EraseCancel {
  if (optIn?.status !== 'active' || state.cancels.some((c) => c.token === optIn.token)) return state;
  return { ...state, cancels: [...state.cancels, { token: optIn.token, idToken: null }] };
}

export function eraseCancelTransition(state: EraseCancel, event: EraseCancelEvent): EraseCancelStep {
  if (event.type === 'prepared') return moved(state, { kind: 'watching', at: event.at, cancels: [] });
  if (event.type === 'committed') return moved(state, { kind: 'done' });
  if (state.kind !== 'watching') return moved(state, state);
  switch (event.type) {
    case 'read':
      return moved(state, kept(state, event.optIn));
    case 'remote':
      if (event.running) return moved(state, kept(state, event.optIn));
      // The erase ended where it began: refused or put back, and no commit
      // will come. Ended elsewhere, it landed: the commit is on its way.
      return moved(state, event.identity === state.at ? { kind: 'done' } : state);
    case 'proved':
      return moved(state, { ...state, cancels: state.cancels.map((c) => (c.token === event.token ? { ...c, idToken: event.idToken } : c)) });
    case 'failed':
      return moved(state, { kind: 'unprepared' });
  }
}

/** What the commit cancels: every token kept but one the record still holds
 *  active once the erase stands. That one came in after the swap and survived
 *  the erase's save (another device erased to the same epoch, then turned
 *  reminders on), so it is live consent, not a pre-erase row. */
export function toCancel(state: EraseCancel, standing: FileReminderOptIn | undefined): { token: string; idToken: string | null }[] {
  if (state.kind !== 'watching') return [];
  return state.cancels.filter(({ token }) => !(standing?.status === 'active' && standing.token === token));
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
    if (effect.type === 'listen') window.addEventListener(REMOTE_CHANGED_EVENT, watchErase);
    else window.removeEventListener(REMOTE_CHANGED_EVENT, watchErase);
  }
}

function watchErase(): void {
  stepEraseCancel({ type: 'remote', optIn: getReminderOptIn(), running: eraseRunsHere(), identity: getEraseIdentity() });
}
