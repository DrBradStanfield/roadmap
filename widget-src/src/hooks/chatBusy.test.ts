/**
 * US-15 AC17a-d: other tabs' sends, one state with a pure transition (lead C23). Each row is
 * state x event -> the state that follows; then where the dots draw and what locks Send.
 */
import { describe, it, expect } from 'vitest';
import { IDLE, REMOTE_PENDING_MS, nextExpiry, othersReplyIn, othersSending, transition, type BusyEvent, type BusyState } from './chatBusy';

const T = 1_000;
const until = T + REMOTE_PENDING_MS;
const post = (p: Partial<Extract<BusyEvent, { type: 'post' }>>): BusyEvent =>
  ({ type: 'post', from: 'a', sending: true, shows: true, asked: undefined, shown: undefined, local: 'new:0', now: T, ...p });
const SENDING_A: BusyState = { sends: { a: { phase: 'sending', asked: 'thread:X', until: 50 } }, mirror: null };
const LEGACY_B: BusyState = { sends: { b: { phase: 'legacy', until: 50 } }, mirror: null };
const BOTH: BusyState = { sends: { ...SENDING_A.sends, ...LEGACY_B.sends }, mirror: null };

describe('US-15 AC17a-d: transition table', () => {
  it.each<[string, BusyState, BusyEvent, BusyState]>([
    ['idle x post{sending, asked} -> sending with its asked chat and mirror', IDLE,
      post({ asked: 'thread:X', shown: 'thread:X', local: 'thread:X' }),
      { sends: { a: { phase: 'sending', asked: 'thread:X', until } }, mirror: { local: 'thread:X', from: 'a', key: 'thread:X' } }],
    ['idle x post{sending, no asked} (this bundle before C23) -> sending, asked null, no mirror', IDLE,
      post({}), { sends: { a: { phase: 'sending', asked: null, until } }, mirror: null }],
    ['idle x post{no sending, shows} (an older bundle) -> legacy', IDLE,
      post({ sending: undefined }), { sends: { a: { phase: 'legacy', until } }, mirror: null }],
    ['idle x post{sending false, shows} (a mirror) -> no send, mirror kept', IDLE,
      post({ sending: false, shown: 'new:3', local: 'new:1' }), { sends: {}, mirror: { local: 'new:1', from: 'a', key: 'new:3' } }],
    ['sending(a) x post{a, sending} -> restarted clock, new asked', SENDING_A,
      post({ asked: 'new:2' }), { sends: { a: { phase: 'sending', asked: 'new:2', until } }, mirror: null }],
    ['sending(a) x post{a, ended} -> idle', SENDING_A, post({ sending: false, shows: false }), IDLE],
    ['legacy(b) x post{a, sending false, shows} -> a mirror is no end: legacy kept', LEGACY_B,
      post({ sending: false }), LEGACY_B],
    ['legacy(b) x post{a, ended} -> every legacy wait ends', LEGACY_B, post({ sending: false, shows: false }), IDLE],
    ['legacy(b) x post{a, old bundle ended} -> every legacy wait ends', LEGACY_B, post({ sending: undefined, shows: false }), IDLE],
    ['both x own-ended -> legacy ends, sending stays', BOTH, { type: 'own-ended' }, SENDING_A],
    ['both x expired(before until) -> unchanged', BOTH, { type: 'expired', now: 49 }, BOTH],
    ['both x expired(at until) -> idle', BOTH, { type: 'expired', now: 50 }, IDLE],
  ])('%s', (_name, s, e, next) => {
    expect(transition(s, e)).toEqual(next);
  });

  it('two tabs expire each on its own clock', () => {
    const s = transition(transition(IDLE, post({ from: 'a' })), post({ from: 'b', now: T + 10 }));
    expect(nextExpiry(s)).toBe(until);
    const after = transition(s, { type: 'expired', now: until });
    expect(Object.keys(after.sends)).toEqual(['b']);
    expect(nextExpiry(after)).toBe(until + 10);
    expect(nextExpiry(IDLE)).toBeNull();
  });
});

describe('US-15 AC17d: where the dots draw; Send locks for any send', () => {
  const asking = (asked: 'thread:X' | 'new:0' | null, mirror: BusyState['mirror']): BusyState =>
    ({ sends: { a: { phase: 'sending', asked, until } }, mirror });

  it.each<[string, BusyState, 'thread:X' | 'new:0' | 'new:1', boolean]>([
    ['a thread asked, the same thread shown', asking('thread:X', null), 'thread:X', true],
    ['a thread asked, a new chat shown', asking('thread:X', null), 'new:1', false],
    ['a new chat asked, this tab mirrors it', asking('new:0', { local: 'new:1', from: 'a', key: 'new:0' }), 'new:1', true],
    ['a new chat asked, this tab has left the chat that mirrored it', asking('new:0', { local: 'new:1', from: 'a', key: 'new:0' }), 'new:0', false],
    ['a new chat asked, the sender has moved to another new chat', asking('new:0', { local: 'new:1', from: 'a', key: 'new:2' as 'new:0' }), 'new:1', false],
    ['a new chat asked, this tab mirrors another tab', asking('new:0', { local: 'new:1', from: 'c', key: 'new:0' }), 'new:1', false],
    ['a new chat asked, no mirror heard', asking('new:0', null), 'new:0', false],
    ['no asked chat (an older bundle): nowhere', asking(null, { local: 'new:1', from: 'a', key: 'new:0' }), 'new:1', false],
    ['an older bundle\'s legacy wait: nowhere', { ...LEGACY_B, mirror: { local: 'new:1', from: 'b', key: 'new:0' } }, 'new:1', false],
  ])('%s -> dots %s', (_name, s, shown, dots) => {
    expect(othersReplyIn(s, shown)).toBe(dots);
    expect(othersSending(s)).toBe(true);
  });

  it('idle: no dots, Send free', () => {
    expect([othersReplyIn(IDLE, 'new:0'), othersSending(IDLE)]).toEqual([false, false]);
  });
});
