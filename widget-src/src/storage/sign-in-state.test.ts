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

const EVENTS: Record<string, SignInEvent> = {
  bootDrive: { type: 'booted', state: IN_DRIVE },
  bootOutDropbox: { type: 'booted', state: OUT_DROPBOX },
  bootUnreachable: { type: 'booted', state: UNREACHABLE_WEBDAV },
  endDrive: { type: 'ended', provider: 'google-drive' },
  endDropbox: { type: 'ended', provider: 'dropbox' },
};

/** For each state, what every event leads to. */
const TABLE: Array<[string, SignIn, Record<keyof typeof EVENTS, SignIn>]> = [
  ['none (before boot)', NONE, {
    bootDrive: IN_DRIVE, bootOutDropbox: OUT_DROPBOX, bootUnreachable: UNREACHABLE_WEBDAV,
    endDrive: NONE, endDropbox: NONE, // a refusal met while the page loads is the load's to show
  }],
  ['signed in to Drive', IN_DRIVE, {
    bootDrive: IN_DRIVE, bootOutDropbox: IN_DRIVE, bootUnreachable: IN_DRIVE, // booted once per page
    endDrive: OUT_DRIVE, endDropbox: IN_DRIVE, // never for another provider
  }],
  ['signed in to Dropbox', IN_DROPBOX, {
    bootDrive: IN_DROPBOX, bootOutDropbox: IN_DROPBOX, bootUnreachable: IN_DROPBOX,
    endDrive: IN_DROPBOX, endDropbox: OUT_DROPBOX,
  }],
  ['signed in to GitHub', IN_GITHUB, {
    bootDrive: IN_GITHUB, bootOutDropbox: IN_GITHUB, bootUnreachable: IN_GITHUB,
    endDrive: IN_GITHUB, endDropbox: IN_GITHUB,
  }],
  ['signed out of Drive', OUT_DRIVE, {
    bootDrive: OUT_DRIVE, bootOutDropbox: OUT_DRIVE, bootUnreachable: OUT_DRIVE,
    endDrive: OUT_DRIVE, endDropbox: OUT_DRIVE, // once per page, whoever asked
  }],
  ['signed out of Dropbox', OUT_DROPBOX, {
    bootDrive: OUT_DROPBOX, bootOutDropbox: OUT_DROPBOX, bootUnreachable: OUT_DROPBOX,
    endDrive: OUT_DROPBOX, endDropbox: OUT_DROPBOX,
  }],
  ['Dropbox unreachable at load', UNREACHABLE_DROPBOX, {
    bootDrive: UNREACHABLE_DROPBOX, bootOutDropbox: UNREACHABLE_DROPBOX, bootUnreachable: UNREACHABLE_DROPBOX,
    endDrive: UNREACHABLE_DROPBOX, endDropbox: UNREACHABLE_DROPBOX, // the session runs on the device: a reload tries again
  }],
];

describe('US-09 AC48 (lead A3): the sign-in transition table', () => {
  it.each(TABLE)('%s', (_name, state, row) => {
    for (const [event, next] of Object.entries(row)) {
      expect([event, transition(state, EVENTS[event])]).toEqual([event, next]);
    }
  });

  it('a signed-out state is left only by a new page: no event leads from it to signed in', () => {
    for (const state of [OUT_DRIVE, OUT_DROPBOX]) {
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

  it('tells its subscribers once per change', () => {
    localStorage.setItem(BACKEND_KEY, 'google-drive');
    const heard = vi.fn();
    state.subscribeSignIn(heard);
    state.signInEnded('google-drive', 'gen-1');
    state.signInEnded('google-drive', 'gen-1');
    expect(heard).toHaveBeenCalledTimes(1);
  });
});
