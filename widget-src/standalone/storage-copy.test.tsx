// @vitest-environment jsdom
/**
 * US-09 AC5 — the plan-tab storage block and the picker it opens.
 *
 * The picker is the only place storage is chosen, so both surfaces are pinned
 * here: the button under the plan opens it, and the picker's own copy names the
 * record (not the plan) and is honest about the browser-only option.
 * US-09 AC19 — the button's one-time pulse once the guest has their PDF.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect, vi, afterEach, beforeAll, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';
import { PLAN_STORAGE_CTA, PLAN_STORAGE_NOTICE, StorageNoticeContext } from '../src/lib/storage-notice';

vi.mock('../src/storage', () => ({
  GoogleDriveAdapter: class {},
  GitHubAdapter: class {},
  WebDavAdapter: class {},
  isSyncPending: () => false,
  SYNC_PENDING_EVENT: 'hr:sync-pending',
}));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', () => ({
  BACKEND_KEY: 'health_roadmap_backend',
  // Real behaviour (connect.test.ts pins it); the rest of the module is stubbed.
  storageState: (backend: string, reconnect?: string) =>
    (reconnect ? 'reconnect' : backend === 'local' ? 'guest' : 'cloud'),
  PROVIDER_LABELS: { 'google-drive': 'Google Drive', dropbox: 'Dropbox', github: 'GitHub', 'self-host': 'your own server' },
  prepareSwitch: vi.fn(),
  liftLocalInto: vi.fn(),
  adapterFor: () => null,
  finishFormConnect: vi.fn(),
  logOff: vi.fn(),
  useBusyRun: () => ({ busy: false, error: null, setError: vi.fn(), run: vi.fn() }),
}));

import { SyncControl } from './sync-control';
import { BackendPickerModal } from './backend-picker';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(cleanup);

const guest = (ui: React.ReactNode) =>
  render(<StorageNoticeContext.Provider value>{ui}</StorageNoticeContext.Provider>);

describe('US-09 AC5 — under the plan', () => {
  it('offers the record question as the primary button, with the explainer under it', () => {
    const { getByRole, container } = guest(<SyncControl backend="local" hasData />);
    expect(getByRole('button', { name: PLAN_STORAGE_CTA })).toBeTruthy();
    expect(container.textContent).toContain(PLAN_STORAGE_NOTICE);
  });

  it('the button opens the picker', () => {
    const { getByRole, queryByRole } = guest(<SyncControl backend="local" hasData />);
    expect(queryByRole('dialog')).toBeNull();
    fireEvent.click(getByRole('button', { name: PLAN_STORAGE_CTA }));
    expect(document.querySelector('dialog.hr-modal')).toBeTruthy();
  });

  it('the explainer link opens the same picker, no second one', () => {
    const { getByRole } = guest(<SyncControl backend="local" hasData />);
    fireEvent.click(getByRole('button', { name: 'Dropbox or Google Drive' }));
    expect(document.querySelectorAll('dialog.hr-modal').length).toBe(1);
  });

  it('a connected user is told the record lives in their provider', () => {
    const { container } = guest(<SyncControl backend="dropbox" hasData />);
    expect(container.textContent).toContain('Your health record is yours alone. It lives in your');
    expect(container.textContent).not.toContain(PLAN_STORAGE_CTA);
  });

  it('the signed-out Drive state talks about the browser, not the device', () => {
    const { container, getByRole } = guest(<SyncControl backend="local" reconnect="google-drive" hasData />);
    expect(container.textContent).toContain('Google Drive is signed out');
    expect(container.textContent).toContain('kept in this browser and merges when you reconnect');
    expect(getByRole('button', { name: 'Use this browser only' })).toBeTruthy();
  });

  it('US-09 AC13: a Dropbox record that could not be read names Dropbox and offers a retry', () => {
    const { container, getByRole } = guest(<SyncControl backend="local" reconnect="dropbox" hasData />);
    expect(container.textContent).toContain('Dropbox could not be reached');
    expect(getByRole('button', { name: 'Retry' })).toBeTruthy();
    expect(container.textContent).not.toContain(PLAN_STORAGE_CTA); // never the guest pitch
    expect(container.textContent).not.toMatch(/—/);
  });
});

describe('US-09 AC5 — the picker', () => {
  // The picker portals to <body>, so its copy is read off the document.
  const open = () => {
    render(<BackendPickerModal current="local" onClose={vi.fn()} />);
    return document.querySelector('dialog.hr-modal') as HTMLDialogElement;
  };

  it('asks about the record, and promises nothing is stored on our server', () => {
    const dialog = open();
    expect(dialog.querySelector('h2')?.textContent).toBe(PLAN_STORAGE_CTA);
    expect(dialog.textContent).toContain(PLAN_STORAGE_NOTICE);
    expect(dialog.getAttribute('aria-label')).toBe(PLAN_STORAGE_CTA);
  });

  it('names the browser-only option honestly', () => {
    const dialog = open();
    expect(dialog.textContent).toContain('This browser only');
    expect(dialog.textContent).toContain(
      'No account needed. Your record stays in this browser. Clear your browsing data and it is gone.',
    );
  });

  it('describes each cloud as one file in a folder the user owns', () => {
    const dialog = open();
    expect(dialog.textContent).toContain('One file in your own Google Drive, in a private "Health Plan by Dr Brad" folder.');
    expect(dialog.textContent).toContain('One file in your own Dropbox, in a private "Health Plan by Dr Brad" folder.');
    expect(dialog.textContent).toContain('A private GitHub repository you own. Every change is kept in its history.');
    expect(dialog.textContent).toContain('Any WebDAV server you run, such as Nextcloud or ownCloud.');
  });

  // Both send the account email to reminders (reminders.ts identityFor); the
  // advanced options, which give no email unless the token allows it, say nothing.
  it('US-09 AC17: Google Drive and Dropbox each say they share the email, and what it is for', () => {
    const notes = [...open().querySelectorAll('.hr-opt-note')];
    expect(notes.map((n) => n.textContent)).toEqual([
      'Google also shares your email address. We use it only to remind you when a check-up or blood test is due.',
      'Dropbox also shares your email address. We use it only to remind you when a check-up or blood test is due.',
    ]);
    // Each under its option's blurb, inside that option.
    expect(notes.map((n) => n.previousElementSibling?.className)).toEqual(['hr-opt-blurb', 'hr-opt-blurb']);
    expect(notes.map((n) => n.closest('button')?.querySelector('.hr-opt-name')?.textContent)).toEqual(['Google Drive', 'Dropbox']);
  });

  it('carries no em dash and never mentions Dr Brad’s servers', () => {
    const text = open().textContent ?? '';
    expect(text).not.toMatch(/—/);
    expect(text).not.toMatch(/Brad's servers/);
  });

  it('the log-off step (row 16) says browser, not device, with no em dash', () => {
    render(<BackendPickerModal current="dropbox" onClose={vi.fn()} />);
    fireEvent.click(document.querySelector('dialog.hr-modal button.hr-sync-link') as HTMLButtonElement);
    const text = document.querySelector('dialog.hr-modal')?.textContent ?? '';
    expect(text).toContain('clears your health record from this browser');
    expect(text).not.toMatch(/—/);
  });
});

// US-09 AC19 — once a guest has their PDF, the storage button pulses with the
// form's attention-pulse glow until it is first pressed. The "pressed" memory is
// a side localStorage key in this browser, never the record.
describe('US-09 AC19 — the storage button pulses once the guest has their PDF', () => {
  const SEEN_KEY = 'hr_storage_cta_seen';
  // A fresh sync-control per test: it remembers "seen" for the page's life
  // (module scope), and the AC5 tests above press the button too.
  let Sync: typeof SyncControl;
  let openPicker: () => void;
  let show: (ui: React.ReactNode) => ReturnType<typeof render>;
  beforeEach(async () => {
    localStorage.clear();
    vi.resetModules();
    ({ SyncControl: Sync } = await import('./sync-control'));
    const notice = await import('../src/lib/storage-notice');
    openPicker = notice.openBackendPicker;
    show = (ui) => render(<notice.StorageNoticeContext.Provider value>{ui}</notice.StorageNoticeContext.Provider>);
  });
  afterEach(() => { vi.restoreAllMocks(); });
  const cta = (view: ReturnType<typeof render>) => view.getByRole('button', { name: PLAN_STORAGE_CTA });
  const pulsing = (view: ReturnType<typeof render>) => cta(view).classList.contains('hr-sync-btn-attention');
  const throwingStorage = () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SecurityError'); });
  };

  it('pulses only with attention and before the button was ever pressed', () => {
    expect(pulsing(show(<Sync backend="local" hasData attention />))).toBe(true);
    cleanup();
    expect(pulsing(show(<Sync backend="local" hasData attention={false} />))).toBe(false);
    cleanup();
    expect(pulsing(show(<Sync backend="local" hasData />))).toBe(false);
    cleanup();
    localStorage.setItem(SEEN_KEY, '1');
    expect(pulsing(show(<Sync backend="local" hasData attention />))).toBe(false);
  });

  it('pressing it stops the pulse now and on later visits, and still opens the picker', () => {
    const view = show(<Sync backend="local" hasData attention />);
    fireEvent.click(cta(view));
    expect(pulsing(view)).toBe(false);
    expect(document.querySelector('dialog.hr-modal')).toBeTruthy();
    expect(localStorage.getItem(SEEN_KEY)).toBe('1');
    cleanup();
    expect(pulsing(show(<Sync backend="local" hasData attention />))).toBe(false);
  });

  it('the picker opened by any other route (a storage link, the email step) stops it too', () => {
    const view = show(<Sync backend="local" hasData attention />);
    act(() => openPicker());
    expect(pulsing(view)).toBe(false);
    expect(document.querySelector('dialog.hr-modal')).toBeTruthy();
    expect(localStorage.getItem(SEEN_KEY)).toBe('1');
  });

  it('storage that throws never breaks the button: it pulses, stops when pressed, and stays stopped on a remount', () => {
    throwingStorage();
    const view = show(<Sync backend="local" hasData attention />);
    expect(pulsing(view)).toBe(true);
    fireEvent.click(cta(view));
    expect(pulsing(view)).toBe(false);
    expect(document.querySelector('dialog.hr-modal')).toBeTruthy();
    cleanup();
    expect(pulsing(show(<Sync backend="local" hasData attention />))).toBe(false);
  });

  it('a cloud or reconnect session has no such button, so nothing pulses', () => {
    for (const ui of [
      <Sync backend="dropbox" hasData attention />,
      <Sync backend="local" reconnect="google-drive" hasData attention />,
      <Sync backend="local" reconnect="dropbox" hasData attention />,
    ]) {
      expect(show(ui).container.querySelector('.hr-sync-btn-attention')).toBeNull();
      cleanup();
    }
  });

  it('CSS: reuses the form\'s attention-pulse glow, static under reduced motion, never printed', () => {
    const flat = (path: string) => readFileSync(resolve(__dirname, path), 'utf8').replace(/\s+/g, ' ');
    const css = flat('standalone.css');
    expect(css).toContain('.hr-sync-btn-attention { -webkit-animation: attention-pulse 2s ease-in-out infinite; animation: attention-pulse 2s ease-in-out infinite; }');
    expect(css).not.toMatch(/@(-webkit-)?keyframes attention-pulse/); // the form's keyframes, not a copy
    expect(flat('../src/styles.css')).toMatch(/@keyframes attention-pulse/);
    const reduced = css.slice(css.indexOf('@media (prefers-reduced-motion: reduce) {'));
    expect(reduced).toMatch(/^@media \(prefers-reduced-motion: reduce\) \{ \.hr-sync-btn-attention \{ -webkit-animation: none; animation: none; box-shadow: [^;}]+; \} \}/);
    expect(css).toContain('@media print { .hr-sync-btn-attention { -webkit-animation: none; animation: none; box-shadow: none; } }');
  });
});
