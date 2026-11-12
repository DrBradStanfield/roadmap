// @vitest-environment jsdom
/**
 * US-09 AC30: the top bar's storage button, where "Supercharge this tool" sat.
 * Its label comes from the real storage state. A record that could not be read
 * runs the panel's own reconnect; every other state opens the one picker, which
 * never shows an unreachable provider as connected (AC13).
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';

const sync = vi.hoisted(() => ({ pending: false, status: 'saved' as 'saved' | 'saving' | 'not-saved' | 'not-saved-on-device', popup: vi.fn(async () => {}) }));
vi.mock('../src/lib/roadmap-data', () => ({ currentSaveStatus: () => sync.status }));
vi.mock('../src/storage', () => ({
  GoogleDriveAdapter: class { acquireViaPopup = sync.popup; },
  savePopupGrant: () => true,
  GitHubAdapter: class {},
  WebDavAdapter: class {},
  isSyncPending: () => sync.pending,
  markSyncPending: vi.fn(),
  SYNC_PENDING_EVENT: 'hr:sync-pending',
  SAVE_STATUS_EVENT: 'hr:save-status',
  gisReady: () => true,
  preloadGis: () => undefined,
}));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', () => ({
  storageState: (backend: string, reconnect?: string) =>
    (reconnect ? 'reconnect' : backend === 'local' ? 'guest' : 'cloud'),
  prepareSwitch: vi.fn(),
  liftLocalInto: vi.fn(),
  adapterFor: () => null,
  finishFormConnect: vi.fn(),
  logOff: vi.fn(),
  connectRefusal: () => null,
  rememberSignIn: vi.fn(() => true),
  forgetBackend: vi.fn(),
}));

import { StorageBar, SyncControl } from './sync-control';
import { PICKER_GUEST_LEAD } from './backend-picker';
import { openBackendPicker } from '../src/lib/storage-notice';
import { resetSwitchFlow } from './switch-flow';
import type { Backend } from './connect';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => { cleanup(); resetSwitchFlow(); sync.pending = false; sync.status = 'saved'; sync.popup.mockClear(); vi.unstubAllGlobals(); });

type Cloud = Exclude<Backend, 'local'>;
/** The bar as app.tsx mounts it, beside the plan's SyncControl, which hosts the picker. */
const mount = (backend: Backend, reconnect?: Cloud) => render(
  <>
    <StorageBar backend={backend} reconnect={reconnect} />
    <SyncControl backend={backend} reconnect={reconnect} hasData />
  </>,
);
/** The bar itself (the plan's status line names the provider too). */
const bar = () => document.querySelector('button.action-btn-small') as HTMLButtonElement;
/** A connected record's status text, where its button was. */
const state = () => document.querySelector('.hr-storage-state');
/** A phone: every max-width query matches (US-62 AC34). */
const asPhone = () => vi.stubGlobal('matchMedia', (q: string) => ({
  matches: q.includes('max-width'), media: q, addEventListener() {}, removeEventListener() {},
}));
const dialog = () => document.querySelector('dialog.hr-modal') as HTMLDialogElement | null;
/** The picker row whose name starts with this provider. */
const option = (name: string) => [...dialog()!.querySelectorAll('.hr-opt')]
  .find((o) => o.querySelector('.hr-opt-name')?.textContent?.startsWith(name))!;

describe('US-09 AC30 — the label says the real storage state', () => {
  it('a guest sees Sign in', () => {
    mount('local');
    expect(bar().textContent).toBe('Sign in');
  });

  // Brad 2026-11-09: a bare teal provider name read as a call to action; it is status text.
  it.each([['dropbox', 'Dropbox'], ['google-drive', 'Google Drive'], ['github', 'GitHub']] as const)(
    'connected to %s, it says "Synced to" the provider, as text, not a button', (backend, label) => {
      mount(backend);
      expect(state()?.textContent).toBe(`Synced to ${label}`);
      expect(state()?.closest('button')).toBeNull();
      expect(bar()).toBeNull();
    },
  );

  // Lead A1 step d (owner, 2026-11-12): the session's save status and the device marker, eight rows.
  // The on-device words need both this session's landed device write and the marker (re-check).
  it.each([
    ['saving', false, 'Saving to Dropbox…'],
    ['saving', true, 'Saving to Dropbox…'],
    ['not-saved-on-device', true, 'Not synced yet. Your changes are on this device.'],
    ['not-saved-on-device', false, 'Not synced yet.'], // another tab logged off: device copy and marker gone (Codex)
    ['not-saved', true, 'Not synced yet.'], // marker set, device write failed (a full disk, a newer device file)
    ['not-saved', false, 'Not synced yet.'],
    ['saved', true, 'Not synced yet.'], // a device copy the marker's release cannot read, or another tab's write waiting
    ['saved', false, 'Synced to Dropbox'],
  ] as const)('session %s, device marker %s: "%s"', (status, pending, words) => {
    sync.status = status;
    sync.pending = pending;
    mount('dropbox');
    expect(state()?.textContent).toBe(words);
  });

  it('Settings says what waits on this device, and promises no upload nothing yet retries (lead A1 step d)', () => {
    sync.pending = true;
    sync.status = 'not-saved-on-device';
    mount('dropbox');
    expect(document.querySelector('.hr-sync-detail')?.textContent).toBe(
      'Some data in this browser is still waiting to sync to your Dropbox. Your data is safe in this browser meanwhile.',
    );
  });

  it.each([
    ['not-saved-on-device', false], // the mirror landed, then another tab logged off (Codex)
    ['saved', true], // the marker stayed over a device copy its release could not read
  ] as const)('Settings says nothing of data in this browser when the session is %s and the marker %s (lead A1 step d re-check)', (status, pending) => {
    sync.status = status;
    sync.pending = pending;
    mount('dropbox');
    expect(document.querySelector('.hr-sync-detail')).toBeNull();
    expect(document.body.textContent).not.toContain('safe in this browser');
  });

  it('Settings says nothing of data waiting in this browser when the device write failed (lead A1 step d review)', () => {
    sync.pending = true;
    sync.status = 'not-saved';
    mount('dropbox');
    expect(document.querySelector('.hr-sync-detail')).toBeNull();
    expect(document.body.textContent).not.toContain('in this browser');
    cleanup();
    sync.status = 'not-saved-on-device';
    mount('dropbox');
    expect(document.querySelector('.hr-sync-detail')?.textContent).toBe(
      'Some data in this browser is still waiting to sync to your Dropbox. Your data is safe in this browser meanwhile.',
    );
  });

  it('Settings claims nothing while a retry runs over a failed, unmirrored write (lead A1 step d review)', () => {
    sync.pending = true; // the marker landed; the device write did not
    sync.status = 'not-saved';
    mount('dropbox');
    expect(document.querySelector('.hr-sync-detail')).toBeNull();
    sync.status = 'saving'; // an edit: the retry runs
    act(() => { window.dispatchEvent(new Event('hr:save-status')); });
    expect(state()?.textContent).toBe('Saving to Dropbox…');
    expect(document.querySelector('.hr-sync-detail')).toBeNull();
    expect(document.body.textContent).not.toContain('safe in this browser');
  });

  it('the first frame already says what the session knows, never a false Synced (F4)', () => {
    sync.status = 'saving';
    expect(renderToStaticMarkup(<StorageBar backend="dropbox" />)).toContain('Saving to Dropbox…');
    sync.status = 'not-saved-on-device';
    sync.pending = true;
    expect(renderToStaticMarkup(<StorageBar backend="dropbox" />)).toContain('Not synced yet. Your changes are on this device.');
  });

  it('follows the save status event and the marker event, with no polling', () => {
    mount('dropbox');
    sync.status = 'saving';
    act(() => { window.dispatchEvent(new Event('hr:save-status')); });
    expect(state()?.textContent).toBe('Saving to Dropbox…');
    sync.status = 'not-saved';
    act(() => { window.dispatchEvent(new Event('hr:save-status')); });
    expect(state()?.textContent).toBe('Not synced yet.');
    sync.pending = true;
    act(() => { window.dispatchEvent(new Event('hr:sync-pending')); });
    expect(state()?.textContent).toBe('Not synced yet.'); // the marker alone: the device write may have failed
    sync.status = 'not-saved-on-device';
    act(() => { window.dispatchEvent(new Event('hr:save-status')); });
    expect(state()?.textContent).toBe('Not synced yet. Your changes are on this device.');
    sync.status = 'saved';
    sync.pending = false;
    act(() => { window.dispatchEvent(new Event('hr:sync-pending')); });
    expect(state()?.textContent).toBe('Synced to Dropbox');
  });

  it.each([
    ['dropbox', 'Retry'],
    ['google-drive', 'Sign in to Google again'],
    ['github', 'Retry'],
    ['self-host', 'Retry'],
  ] as const)('a %s record that could not be read asks to reconnect: %s', (provider, label) => {
    mount('local', provider);
    expect(bar().textContent).toBe(label);
    expect(bar().textContent).not.toBe('Sign in'); // never the guest pitch for a placed record
  });
});

// US-62 AC34 (Brad 2026-11-09): on a phone the bar sits on the Account tab's title line, where
// the storage card's button is the one sign-in; a sync problem also shows atop My health.
describe('US-62 AC34 — the bar on a phone', () => {
  it('a guest\'s Account title line has no Sign in; the storage card\'s button opens the picker', () => {
    asPhone();
    mount('local');
    expect(bar()).toBeNull();
    expect(document.body.textContent).not.toContain('Sign in');
    const cardButton = [...document.querySelectorAll<HTMLButtonElement>('.hr-sync-btn')];
    expect(cardButton.map((b) => b.textContent)).toEqual(['Keep my record in Dropbox or Google Drive']);
    fireEvent.click(cardButton[0]);
    expect(document.querySelectorAll('dialog.hr-modal')).toHaveLength(1);
  });

  it('a reconnect keeps its button on a phone: it is an action', () => {
    asPhone();
    mount('local', 'google-drive');
    expect(bar().textContent).toBe('Sign in to Google again');
  });

  it('problemsOnly (atop My health) draws nothing while all is well or a save runs over no marker, the not-synced words, and the reconnect', () => {
    asPhone();
    const only = (backend: Backend, reconnect?: Cloud) => render(<StorageBar backend={backend} reconnect={reconnect} problemsOnly />);
    expect(only('dropbox').container.innerHTML).toBe('');
    cleanup();
    expect(only('local').container.innerHTML).toBe('');
    cleanup();
    sync.pending = true;
    sync.status = 'not-saved-on-device';
    only('dropbox');
    expect(state()?.textContent).toBe('Not synced yet. Your changes are on this device.');
    cleanup();
    sync.status = 'saved'; // a marker with no landed device write this session
    only('dropbox');
    expect(state()?.textContent).toBe('Not synced yet.');
    cleanup();
    sync.pending = false;
    sync.status = 'saving';
    expect(only('dropbox').container.innerHTML).toBe(''); // no flash on every edit burst (owner, 2026-11-12)
    cleanup();
    sync.pending = true; // saving over a marker: the problem stays shown while the retry runs, in words true whatever the device holds (F3)
    only('dropbox');
    expect(state()?.textContent).toBe('Not synced yet.');
    cleanup();
    sync.pending = false;
    sync.status = 'not-saved';
    only('dropbox');
    expect(state()?.textContent).toBe('Not synced yet.');
    cleanup();
    sync.status = 'saved';
    only('local', 'dropbox');
    expect(bar().textContent).toBe('Retry');
  });
});

describe('US-09 AC30 — a reconnect label runs the reconnect, never the picker', () => {
  it('Sign in to Google again starts the Drive popup inside the click', () => {
    vi.stubGlobal('location', { reload: vi.fn() });
    mount('local', 'google-drive');
    fireEvent.click(bar());
    expect(sync.popup).toHaveBeenCalledTimes(1); // the click's user gesture reaches the GIS popup
    expect(dialog()).toBeNull();
  });

  it('the bar and the panel never start two Drive reconnects at once', () => {
    vi.stubGlobal('location', { reload: vi.fn() });
    sync.popup.mockImplementationOnce(() => new Promise(() => {})); // the popup stays open
    mount('local', 'google-drive');
    fireEvent.click(bar());
    const panelButton = document.querySelector('.hr-sync-btn') as HTMLButtonElement;
    expect(panelButton.textContent).toBe('Reconnecting…'); // one reconnect, shown in both
    fireEvent.click(panelButton);
    expect(sync.popup).toHaveBeenCalledTimes(1);
  });

  it.each([['dropbox', 'Retry'], ['github', 'Retry'], ['self-host', 'Retry']] as const)(
    '%s: "%s" tries the read again', (provider, label) => {
      vi.stubGlobal('location', { reload: vi.fn() });
      mount('local', provider);
      expect(bar().textContent).toBe(label);
      fireEvent.click(bar());
      expect(location.reload).toHaveBeenCalledTimes(1);
      expect(sync.popup).not.toHaveBeenCalled();
      expect(dialog()).toBeNull();
    },
  );
});

describe('US-09 AC30 — the other states open the one picker, current={reconnect ?? backend}', () => {
  it('a guest opens the picker with the browser as current, and the first line for guests', () => {
    mount('local');
    fireEvent.click(bar());
    expect(document.querySelectorAll('dialog.hr-modal')).toHaveLength(1);
    expect(option('This browser only').textContent).toContain('✓ Current');
    const subs = [...dialog()!.querySelectorAll('.hr-modal-sub')].map((p) => p.textContent);
    expect(subs[0]).toBe(PICKER_GUEST_LEAD);
    expect(PICKER_GUEST_LEAD).toBe(
      'Saved your record to Dropbox, Google Drive or GitHub before? Open it here. If not, it is in this browser, and you can choose a home for it now.',
    );
  });

  it('connected, the storage card\'s provider link opens the picker; it marks that provider connected and drops the guest line', () => {
    mount('google-drive');
    fireEvent.click(document.querySelector('.hr-sync-status-link')!); // the title line is text now
    expect(document.querySelectorAll('dialog.hr-modal')).toHaveLength(1);
    expect(option('Google Drive').textContent).toContain('✓ Connected');
    expect(dialog()!.textContent).not.toContain(PICKER_GUEST_LEAD);
  });

  it('AC13: opened in a reconnect session, the picker never calls the unread provider connected, nor the browser current', () => {
    mount('local', 'dropbox');
    act(() => openBackendPicker()); // e.g. from the email step
    expect(option('Dropbox').textContent).not.toContain('✓');
    expect(option('This browser only').textContent).not.toContain('✓');
    expect(dialog()!.textContent).not.toContain(PICKER_GUEST_LEAD);
  });

  it('AC13: a reconnect session offers no log-off, which would wipe edits that never reached the cloud', () => {
    mount('local', 'dropbox');
    act(() => openBackendPicker());
    expect(dialog()!.textContent).not.toContain('Log off this device');
    cleanup();
    mount('dropbox'); // connected and reachable: log-off stays
    act(() => openBackendPicker());
    expect(dialog()!.textContent).toContain('Log off this device');
  });
});
