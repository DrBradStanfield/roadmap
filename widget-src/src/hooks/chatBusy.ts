/**
 * Other tabs' sends (US-15 AC17, AC17a-d) as one state, changed only through the pure `transition`
 * (the mode rule, .claude/skills/untangle). This tab's own send is the chat-turn store's `turn`.
 * Each other tab is tracked on its own: from a post saying `sending` until that tab says it is not,
 * or REMOTE_PENDING_MS after its latest such word (a tab closed mid-reply never says). Busy and the
 * dots are derived from this state, so one tab's end never frees another's send.
 * An older bundle's post has no `sending`, only what it shows, which can mirror another tab's reply
 * and is never followed by its own end: its wait ends at any tab's word that its send ended, this
 * tab's included (`own-ended`, the store's own-ended effect), as all waits did before.
 * Dots (AC17d): a send draws them only under the chat it asked in. A `thread:` key names the same
 * chat in every tab; a `new:` key is the sender's own, so it matches only while this tab's shown chat
 * mirrors the sender's (`mirror`). A post with no `asked` (an older bundle) locks Send and draws none.
 */
import type { Key } from '@roadmap/health-core/chat-turn';

/** How long another tab's reply in flight may lock this tab's chat with no word from it (US-15 AC17a). */
export const REMOTE_PENDING_MS = 5 * 60_000;

/** One other tab's send in flight. `legacy`: an older bundle's (no `sending`). `asked` null: no dots anywhere. */
export type RemoteSend =
  | { phase: 'sending'; asked: Key | null; until: number }
  | { phase: 'legacy'; until: number };

export interface BusyState {
  sends: Readonly<Record<string, RemoteSend>>;
  /** This tab's shown chat (`local`) mirrors tab `from`'s chat `key`, as of `from`'s latest post. */
  mirror: { local: Key; from: string; key: Key } | null;
}

export type BusyEvent =
  /** Another tab's state post, heard as `local` is shown here after it was mirrored. */
  | { type: 'post'; from: string; sending: boolean | undefined; shows: boolean; asked: Key | undefined; shown: Key | undefined; local: Key; now: number }
  /** This tab's own send ended (AC17c). */
  | { type: 'own-ended' }
  /** The clock reached a send's `until` (AC17a). */
  | { type: 'expired'; now: number };

export const IDLE: BusyState = { sends: {}, mirror: null };

const keep = (sends: BusyState['sends'], ok: (r: RemoteSend) => boolean) =>
  Object.fromEntries(Object.entries(sends).filter(([, r]) => ok(r)));

export function transition(s: BusyState, e: BusyEvent): BusyState {
  switch (e.type) {
    case 'post': {
      const { [e.from]: _was, ...rest } = s.sends;
      const mirror = e.shown ? { local: e.local, from: e.from, key: e.shown } : null;
      // `until` is on this tab's own clock (the hook's `now` as it heard the post), so skew between tabs cannot matter.
      const until = e.now + REMOTE_PENDING_MS;
      if (e.sending ?? e.shows) {
        const send: RemoteSend = e.sending === undefined ? { phase: 'legacy', until } : { phase: 'sending', asked: e.asked ?? null, until };
        return { sends: { ...rest, [e.from]: send }, mirror };
      }
      // An end (shows false) frees every older bundle's wait; a mirror (sending false, shows true) is no end.
      return { sends: e.shows ? rest : keep(rest, (r) => r.phase !== 'legacy'), mirror };
    }
    case 'own-ended': return { ...s, sends: keep(s.sends, (r) => r.phase !== 'legacy') };
    case 'expired': return { ...s, sends: keep(s.sends, (r) => r.until > e.now) };
  }
}

/** Another tab's send in flight: Send is locked. */
export const othersSending = (s: BusyState): boolean => Object.keys(s.sends).length > 0;

/** Another tab's send asked in the chat shown here (`shown`): the dots draw. */
export function othersReplyIn(s: BusyState, shown: Key): boolean {
  return Object.entries(s.sends).some(([from, r]) => r.phase === 'sending' && r.asked !== null && (r.asked.startsWith('thread:')
    ? r.asked === shown
    : s.mirror?.local === shown && s.mirror.from === from && s.mirror.key === r.asked));
}

/** When the next wait ends, for the hook's one timer; null with none. */
export function nextExpiry(s: BusyState): number | null {
  const ends = Object.values(s.sends).map((r) => r.until);
  return ends.length ? Math.min(...ends) : null;
}
