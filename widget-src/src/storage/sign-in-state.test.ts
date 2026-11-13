// @vitest-environment jsdom
/**
 * US-09 AC48, lead A3 step 2: the page's one sign-in state and its pure
 * transition (design §4 test 1, owner rule R7). Every state meets every event.
 * The way back to signed in is a saved sign-in and the reload after it, which
 * boots the page again: no event moves a signed-out page back, so a refresh
 * answer from before the raise cannot. A signed-out state names only Google
 * Drive or Dropbox, and only the provider this page signed in to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { transition, type SignIn, type SignInEvent } from './sign-in-state';

const NONE: SignIn = { kind: 'none' };
const IN_DRIVE: SignIn = { kind: 'signedIn', provider: 'google-drive' };
const IN_DROPBOX: SignIn = { kind: 'signedIn', provider: 'dropbox' };
const IN_GITHUB: SignIn = { kind: 'signedIn', provider: 'github' };
const OUT_DRIVE: SignIn = { kind: 'signedOut', provider: 'google-drive' };
const OUT_DROPBOX: SignIn = { kind: 'signedOut', provider: 'dropbox' };
const UNREACHABLE_DROPBOX: SignIn = { kind: 'unreachable', provider: 'dropbox' };
const UNREACHABLE_WEBDAV: SignIn = { kind: 'unreachable', provider: 'self-host' };
/** US-09 AC49 (lead A28): "Use this browser only" with no copy here asks first, over the lost sign-in. */
const ASKING_OUT_DRIVE: SignIn = { kind: 'confirmingExit', lost: { kind: 'signedOut', provider: 'google-drive' }, question: 'empty' };
const ASKING_UNREACHABLE_DROPBOX: SignIn = { kind: 'confirmingExit', lost: { kind: 'unreachable', provider: 'dropbox' }, question: 'empty' };
/** US-09 AC50 (lead A30): over a copy here the cloud was never read into, it asks whether that copy may be out of date. */
const ASKING_STALE_OUT_DRIVE: SignIn = { kind: 'confirmingExit', lost: { kind: 'signedOut', provider: 'google-drive' }, question: 'stale' };
const ASKING_STALE_UNREACHABLE_DROPBOX: SignIn = { kind: 'confirmingExit', lost: { kind: 'unreachable', provider: 'dropbox' }, question: 'stale' };

const EVENTS: Record<string, SignInEvent> = {
  bootDrive: { type: 'booted', state: IN_DRIVE },
  bootOutDropbox: { type: 'booted', state: OUT_DROPBOX },
  bootUnreachable: { type: 'booted', state: UNREACHABLE_WEBDAV },
  endDrive: { type: 'ended', provider: 'google-drive' },
  endDropbox: { type: 'ended', provider: 'dropbox' },
  askExit: { type: 'exitAsked', question: 'empty' },
  askStale: { type: 'exitAsked', question: 'stale' },
  answerExit: { type: 'exitAnswered' },
  // US-09 AC52: a page that stayed after a hand-off re-reads the home this browser stores.
  storedDrive: { type: 'reread', stored: 'google-drive' },
  storedNone: { type: 'reread', stored: null },
};

/** For each state, what every event leads to. */
const TABLE: Array<[string, SignIn, Record<keyof typeof EVENTS, SignIn>]> = [
  ['none (before boot)', NONE, {
    bootDrive: IN_DRIVE, bootOutDropbox: OUT_DROPBOX, bootUnreachable: UNREACHABLE_WEBDAV,
    endDrive: NONE, endDropbox: NONE, // a refusal met while the page loads is the load's to show
    askExit: NONE, askStale: NONE, answerExit: NONE, // no panel, no exit
    storedDrive: NONE, storedNone: NONE,
  }],
  ['signed in to Drive', IN_DRIVE, {
    bootDrive: IN_DRIVE, bootOutDropbox: IN_DRIVE, bootUnreachable: IN_DRIVE, // booted once per page
    endDrive: OUT_DRIVE, endDropbox: IN_DRIVE, // never for another provider
    askExit: IN_DRIVE, askStale: IN_DRIVE, answerExit: IN_DRIVE,
    storedDrive: IN_DRIVE, storedNone: IN_DRIVE, // only a lost sign-in follows the stored home
  }],
  ['signed in to Dropbox', IN_DROPBOX, {
    bootDrive: IN_DROPBOX, bootOutDropbox: IN_DROPBOX, bootUnreachable: IN_DROPBOX,
    endDrive: IN_DROPBOX, endDropbox: OUT_DROPBOX,
    askExit: IN_DROPBOX, askStale: IN_DROPBOX, answerExit: IN_DROPBOX,
    storedDrive: IN_DROPBOX, storedNone: IN_DROPBOX,
  }],
  ['signed in to GitHub', IN_GITHUB, {
    bootDrive: IN_GITHUB, bootOutDropbox: IN_GITHUB, bootUnreachable: IN_GITHUB,
    endDrive: IN_GITHUB, endDropbox: IN_GITHUB,
    askExit: IN_GITHUB, askStale: IN_GITHUB, answerExit: IN_GITHUB,
    storedDrive: IN_GITHUB, storedNone: IN_GITHUB,
  }],
  ['signed out of Drive', OUT_DRIVE, {
    bootDrive: OUT_DRIVE, bootOutDropbox: OUT_DRIVE, bootUnreachable: OUT_DRIVE,
    endDrive: OUT_DRIVE, endDropbox: OUT_DRIVE, // once per page, whoever asked
    askExit: ASKING_OUT_DRIVE, askStale: ASKING_STALE_OUT_DRIVE, answerExit: OUT_DRIVE,
    storedDrive: OUT_DRIVE, storedNone: NONE, // AC52: Drive forgotten here: the page is this browser's only
  }],
  ['signed out of Dropbox', OUT_DROPBOX, {
    bootDrive: OUT_DROPBOX, bootOutDropbox: OUT_DROPBOX, bootUnreachable: OUT_DROPBOX,
    endDrive: OUT_DROPBOX, endDropbox: OUT_DROPBOX,
    askExit: { kind: 'confirmingExit', lost: OUT_DROPBOX, question: 'empty' },
    askStale: { kind: 'confirmingExit', lost: OUT_DROPBOX, question: 'stale' }, answerExit: OUT_DROPBOX,
    storedDrive: NONE, storedNone: NONE, // this browser no longer names Dropbox
  }],
  ['Dropbox unreachable at load', UNREACHABLE_DROPBOX, {
    bootDrive: UNREACHABLE_DROPBOX, bootOutDropbox: UNREACHABLE_DROPBOX, bootUnreachable: UNREACHABLE_DROPBOX,
    endDrive: UNREACHABLE_DROPBOX, endDropbox: UNREACHABLE_DROPBOX, // the session runs on the device: a reload tries again
    askExit: ASKING_UNREACHABLE_DROPBOX, askStale: ASKING_STALE_UNREACHABLE_DROPBOX, answerExit: UNREACHABLE_DROPBOX,
    storedDrive: NONE, storedNone: NONE,
  }],
  ['asking before Drive\'s exit (AC49)', ASKING_OUT_DRIVE, {
    bootDrive: ASKING_OUT_DRIVE, bootOutDropbox: ASKING_OUT_DRIVE, bootUnreachable: ASKING_OUT_DRIVE,
    endDrive: ASKING_OUT_DRIVE, endDropbox: ASKING_OUT_DRIVE, // already signed out
    askExit: ASKING_OUT_DRIVE, answerExit: OUT_DRIVE, // either answer goes back to the panel; a yes then runs the exit
    askStale: ASKING_STALE_OUT_DRIVE, // AC50: a copy arrived while it asked: asked again, in the words now true
    storedDrive: ASKING_OUT_DRIVE, storedNone: NONE, // a question about a forgotten cloud goes with it
  }],
  ['asking before unreachable Dropbox\'s exit (AC49)', ASKING_UNREACHABLE_DROPBOX, {
    bootDrive: ASKING_UNREACHABLE_DROPBOX, bootOutDropbox: ASKING_UNREACHABLE_DROPBOX, bootUnreachable: ASKING_UNREACHABLE_DROPBOX,
    endDrive: ASKING_UNREACHABLE_DROPBOX, endDropbox: ASKING_UNREACHABLE_DROPBOX,
    askExit: ASKING_UNREACHABLE_DROPBOX, askStale: ASKING_STALE_UNREACHABLE_DROPBOX, answerExit: UNREACHABLE_DROPBOX,
    storedDrive: NONE, storedNone: NONE,
  }],
  ['asking whether Drive\'s copy here is out of date (AC50)', ASKING_STALE_OUT_DRIVE, {
    bootDrive: ASKING_STALE_OUT_DRIVE, bootOutDropbox: ASKING_STALE_OUT_DRIVE, bootUnreachable: ASKING_STALE_OUT_DRIVE,
    endDrive: ASKING_STALE_OUT_DRIVE, endDropbox: ASKING_STALE_OUT_DRIVE,
    askStale: ASKING_STALE_OUT_DRIVE, answerExit: OUT_DRIVE,
    askExit: ASKING_OUT_DRIVE, // the copy here went (another tab's log-off) while it asked: asked again, in the words now true
    storedDrive: ASKING_STALE_OUT_DRIVE, storedNone: NONE,
  }],
  ['asking whether unreachable Dropbox\'s copy here is out of date (AC50)', ASKING_STALE_UNREACHABLE_DROPBOX, {
    bootDrive: ASKING_STALE_UNREACHABLE_DROPBOX, bootOutDropbox: ASKING_STALE_UNREACHABLE_DROPBOX, bootUnreachable: ASKING_STALE_UNREACHABLE_DROPBOX,
    endDrive: ASKING_STALE_UNREACHABLE_DROPBOX, endDropbox: ASKING_STALE_UNREACHABLE_DROPBOX,
    askStale: ASKING_STALE_UNREACHABLE_DROPBOX, answerExit: UNREACHABLE_DROPBOX, askExit: ASKING_UNREACHABLE_DROPBOX,
    storedDrive: NONE, storedNone: NONE,
  }],
];

describe('US-09 AC48 (lead A3): the sign-in transition table', () => {
  it.each(TABLE)('%s', (_name, state, row) => {
    for (const [event, next] of Object.entries(row)) {
      expect([event, transition(state, EVENTS[event])]).toEqual([event, next]);
    }
  });

  it('a signed-out state is left only by a new page: no event leads from it to signed in', () => {
    for (const state of [OUT_DRIVE, OUT_DROPBOX, ASKING_OUT_DRIVE, ASKING_STALE_OUT_DRIVE]) {
      for (const event of Object.values(EVENTS)) expect(transition(state, event).kind).not.toBe('signedIn');
    }
  });
});

describe('US-09 AC48: a refusal counts only while this browser still chose that provider under the same log-off', () => {
  const BACKEND_KEY = 'health_roadmap_backend';
  const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';
  let state: typeof import('./sign-in-state');

  beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem(LOG_OFF_ID_KEY, 'gen-1');
    vi.resetModules();
    state = await import('./sign-in-state');
    state.bootSignIn({ kind: 'signedIn', provider: 'google-drive' });
  });
  afterEach(() => localStorage.clear());

  it('raises for the chosen provider under the adapter\'s own log-off id', () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    state.signInEnded('google-drive', 'gen-1');
    expect(state.currentSignIn()).toEqual(OUT_DRIVE);
    expect(state.isSignedOut('google-drive')).toBe(true);
    expect(state.isSignedOut('dropbox')).toBe(false);
  });

  it('ignores it once another tab chose another home, or none', () => {
    localStorage.setItem(BACKEND_KEY, 'dropbox');
    state.signInEnded('google-drive', 'gen-1');
    localStorage.removeItem(BACKEND_KEY);
    state.signInEnded('google-drive', 'gen-1');
    expect(state.currentSignIn()).toEqual(IN_DRIVE);
  });

  it('ignores it after a log-off (AC45): the adapter began under an older id', () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    localStorage.setItem(LOG_OFF_ID_KEY, 'gen-2');
    state.signInEnded('google-drive', 'gen-1');
    expect(state.currentSignIn()).toEqual(IN_DRIVE);
  });

  it('ignores it once this page may not write (lead A3, adversary F5): another tab\'s log-off was heard', async () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    const storage = await import('../lib/storage');
    storage.noteCloudPage('google-drive');
    storage.noteLogOffHeard();
    expect(storage.healthWritesAllowed()).toBe(false);
    state.signInEnded('google-drive', 'gen-1'); // same home, same log-off id: only the write guard stops it
    expect(state.currentSignIn()).toEqual(IN_DRIVE);
  });

  it('tells its subscribers once per change', () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    const heard = vi.fn();
    state.subscribeSignIn(heard);
    state.signInEnded('google-drive', 'gen-1');
    state.signInEnded('google-drive', 'gen-1');
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('US-09 AC49: a signed-out page still counts as signed out while it asks before its exit', () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    state.signInEnded('google-drive', 'gen-1');
    state.askBeforeExit('empty');
    expect(state.currentSignIn()).toEqual(ASKING_OUT_DRIVE);
    expect(state.isSignedOut('google-drive')).toBe(true);
    expect(state.lostSignIn()).toEqual(OUT_DRIVE);
    state.exitAnswered();
    expect(state.currentSignIn()).toEqual(OUT_DRIVE);
  });
});
