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
import { PICKER_TITLE, PLAN_STORAGE_CTA, PLAN_STORAGE_NOTICE } from '../src/lib/storage-notice';

vi.mock('../src/storage', () => ({
  GoogleDriveAdapter: class {},
  GitHubAdapter: class {},
  WebDavAdapter: class {},
  isSyncPending: () => false,
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
  BACKEND_KEY: 'health_roadmap_backend',
  // Real behaviour (connect.test.ts pins it); the rest of the module is stubbed.
  storageState: (backend: string, signIn?: { kind: string }) =>
    (signIn?.kind === 'signedOut' || signIn?.kind === 'unreachable' ? 'reconnect' : backend === 'local' ? 'guest' : 'cloud'),
  prepareSwitch: vi.fn(),
  liftLocalInto: vi.fn(),
  adapterFor: () => null,
  finishFormConnect: vi.fn(),
  logOff: vi.fn(),
}));

// Fresh modules for every test (US-09 AC13, AC19): the page's write state, the
// log-off id it loaded with, the sign-in answer and sync-control's "seen" memory
// all last for the module's life, so a shared copy would make the order matter.
let SyncControl: typeof import('./sync-control').SyncControl;
let BackendPickerModal: typeof import('./backend-picker').BackendPickerModal;
let noteDevicePage: typeof import('../src/lib/storage').noteDevicePage;
let stopLocalHealthWrites: typeof import('../src/lib/storage').stopLocalHealthWrites;
let bootSignIn: typeof import('../src/storage/sign-in-state').bootSignIn;
let resetSignIn: typeof import('../src/storage/sign-in-state').resetSignIn;
let openBackendPicker: typeof import('../src/lib/storage-notice').openBackendPicker;

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  ({ SyncControl } = await import('./sync-control'));
  ({ BackendPickerModal } = await import('./backend-picker'));
  ({ noteDevicePage, stopLocalHealthWrites } = await import('../src/lib/storage'));
  ({ bootSignIn, resetSignIn } = await import('../src/storage/sign-in-state'));
  ({ openBackendPicker } = await import('../src/lib/storage-notice'));
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** The load's answer, as boot seeds it (US-09 AC48): Drive's sign-in ended; any other cloud did not answer. */
const lostAtLoad = (provider: 'google-drive' | 'dropbox' | 'github' | 'self-host') => {
  resetSignIn();
  bootSignIn(provider === 'google-drive' ? { kind: 'signedOut', provider } : { kind: 'unreachable', provider });
};
/** `lost`: the provider the load could not use, or none. */
const guest = (ui: React.ReactNode, lost?: Parameters<typeof lostAtLoad>[0]) => {
  if (lost) lostAtLoad(lost); else resetSignIn();
  return render(<>{ui}</>);
};

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
    const { container, getByRole } = guest(<SyncControl backend="local" hasData />, 'google-drive');
    expect(container.textContent).toContain('Google Drive is signed out');
    expect(container.textContent).toContain('kept in this browser and merges when you reconnect');
    expect(getByRole('button', { name: 'Use this browser only' })).toBeTruthy();
  });

  it('US-09 AC13: a Dropbox record that could not be read names Dropbox and offers a retry', () => {
    const { container, getByRole } = guest(<SyncControl backend="local" hasData />, 'dropbox');
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

  it('asks about the record, and says our server never stores your health record', () => {
    const dialog = open();
    expect(dialog.querySelector('h2')?.textContent).toBe(PICKER_TITLE);
    expect(dialog.textContent).toContain(PLAN_STORAGE_NOTICE);
    expect(dialog.textContent).toContain('Our server never stores your health record.');
    expect(dialog.getAttribute('aria-label')).toBe(PICKER_TITLE);
  });

  it('warns before Google that the Drive box must be ticked (US-09 AC21)', () => {
    const dialog = open();
    const hint = dialog.querySelector('.hr-opt-hint');
    expect(hint?.textContent).toBe("On Google's screen, tick the Google Drive box. Without it we cannot save your file.");
    expect(hint?.closest('button')?.textContent).toContain('Google Drive');
    expect(dialog.querySelectorAll('.hr-opt-hint')).toHaveLength(1); // Drive only
    expect(hint?.textContent).not.toMatch(/—/);
  });

  it('drops the Drive hint once Drive is the connected backend (US-09 AC21)', () => {
    render(<BackendPickerModal current="google-drive" onClose={vi.fn()} />);
    expect(document.querySelector('.hr-opt-hint')).toBeNull();
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
  const show = (ui: React.ReactNode) => render(<>{ui}</>);
  afterEach(() => { vi.resetAllMocks(); });
  const cta = (view: ReturnType<typeof render>) => view.getByRole('button', { name: PLAN_STORAGE_CTA });
  const pulsing = (view: ReturnType<typeof render>) => cta(view).classList.contains('hr-sync-btn-attention');
  const throwingStorage = () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('SecurityError'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('SecurityError'); });
  };

  it('pulses only with attention and before the button was ever pressed', () => {
    expect(pulsing(show(<SyncControl backend="local" hasData attention />))).toBe(true);
    cleanup();
    expect(pulsing(show(<SyncControl backend="local" hasData attention={false} />))).toBe(false);
    cleanup();
    expect(pulsing(show(<SyncControl backend="local" hasData />))).toBe(false);
    cleanup();
    localStorage.setItem(SEEN_KEY, '1');
    expect(pulsing(show(<SyncControl backend="local" hasData attention />))).toBe(false);
  });

  it('pressing it stops the pulse now and on later visits, and still opens the picker', () => {
    const view = show(<SyncControl backend="local" hasData attention />);
    fireEvent.click(cta(view));
    expect(pulsing(view)).toBe(false);
    expect(document.querySelector('dialog.hr-modal')).toBeTruthy();
    expect(localStorage.getItem(SEEN_KEY)).toBe('1');
    cleanup();
    expect(pulsing(show(<SyncControl backend="local" hasData attention />))).toBe(false);
  });

  it('the picker opened by any other route (a storage link, the email step) stops it too', () => {
    const view = show(<SyncControl backend="local" hasData attention />);
    act(() => openBackendPicker());
    expect(pulsing(view)).toBe(false);
    expect(document.querySelector('dialog.hr-modal')).toBeTruthy();
    expect(localStorage.getItem(SEEN_KEY)).toBe('1');
  });

  it('storage that throws never breaks the button: it pulses, stops when pressed, and stays stopped on a remount', () => {
    throwingStorage();
    const view = show(<SyncControl backend="local" hasData attention />);
    expect(pulsing(view)).toBe(true);
    fireEvent.click(cta(view));
    expect(pulsing(view)).toBe(false);
    expect(document.querySelector('dialog.hr-modal')).toBeTruthy();
    cleanup();
    expect(pulsing(show(<SyncControl backend="local" hasData attention />))).toBe(false);
  });

  it('a cloud or reconnect session has no such button, so nothing pulses', () => {
    const lost = [{ kind: 'signedOut', provider: 'google-drive' }, { kind: 'unreachable', provider: 'dropbox' }] as const;
    for (const [backend, state] of [['dropbox', undefined], ['local', lost[0]], ['local', lost[1]]] as const) {
      resetSignIn();
      if (state) bootSignIn(state);
      expect(show(<SyncControl backend={backend} hasData attention />).container.querySelector('.hr-sync-btn-attention')).toBeNull();
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

describe('US-09 AC13: the fallback notice on a live page', () => {
  it.each(['google-drive', 'dropbox'] as const)('%s: says changes are kept in this browser', (provider) => {
    const { container } = guest(<SyncControl backend="local" hasData />, provider);
    expect(container.textContent).toContain('kept in this browser');
  });
});

describe('US-09 AC13: the fallback notice on a page that missed another tab\'s log-off', () => {
  it('shows no promise once the log-off id has changed, and drops it when the change arrives as a storage event', () => {
    localStorage.setItem('health_roadmap_backend', 'dropbox');
    noteDevicePage(); // a fallback page for Dropbox
    const shown = guest(<SyncControl backend="local" hasData />, 'dropbox');
    expect(shown.container.textContent).toContain('kept in this browser');
    act(() => {
      localStorage.setItem('health_roadmap_log_off_id', 'id-after'); // another tab logged off; no signal reached this page
      window.dispatchEvent(new StorageEvent('storage', { key: 'health_roadmap_log_off_id' }));
    });
    expect(shown.container.textContent).toContain('Your record is safe in your');
    expect(shown.container.textContent).not.toContain('kept in this browser');
    shown.unmount();

    const later = guest(<SyncControl backend="local" hasData />, 'google-drive');
    expect(later.container.textContent).not.toContain('kept in this browser');
  });

  it('a page restored from the back-forward cache after the log-off id changed shows no promise', () => {
    const shown = guest(<SyncControl backend="local" hasData />, 'dropbox');
    expect(shown.container.textContent).toContain('kept in this browser');
    act(() => {
      // Changed while the page sat in the cache: no storage event reaches it.
      localStorage.setItem('health_roadmap_log_off_id', 'id-after');
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    });
    expect(shown.container.textContent).toContain('Your record is safe in your');
    expect(shown.container.textContent).not.toContain('kept in this browser');
  });

  it('an unmounted sync control hears no log-off id change and no back-forward restore', () => {
    const heard = vi.fn();
    const wrappers = new Map<EventListenerOrEventListenerObject, EventListener>();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) => {
      if (type !== 'storage' && type !== 'pageshow') return add(type, fn, opts);
      const wrapper: EventListener = (event) => { heard(type); (typeof fn === 'function' ? fn : fn.handleEvent.bind(fn))(event); };
      wrappers.set(fn, wrapper);
      add(type, wrapper, opts);
    });
    vi.spyOn(window, 'removeEventListener').mockImplementation((type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | EventListenerOptions) =>
      remove(type, wrappers.get(fn) ?? fn, opts));
    const fire = () => act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'health_roadmap_log_off_id' }));
      window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    });
    try {
      const shown = guest(<SyncControl backend="local" hasData />, 'dropbox');
      fire();
      expect(heard).toHaveBeenCalledWith('storage');
      expect(heard).toHaveBeenCalledWith('pageshow');
      shown.unmount();
      heard.mockClear();
      fire();
      expect(heard).not.toHaveBeenCalled();
    } finally {
      cleanup(); // unmount through the wrapped removal first, so no wrapped listener outlives the test
      vi.restoreAllMocks();
    }
  });
});

describe('US-09 AC13: the fallback notice on a page whose device writes stopped', () => {
  it('a notice already on screen drops the promise when the writes stop, with no other change', () => {
    const { container } = guest(<SyncControl backend="local" hasData />, 'dropbox');
    expect(container.textContent).toContain('kept in this browser');
    act(() => stopLocalHealthWrites());
    expect(container.textContent).toContain('Your record is safe in your');
    expect(container.textContent).not.toContain('kept in this browser');
  });

  it.each(['google-drive', 'dropbox'] as const)('%s: names the provider and makes no promise that changes are kept', (provider) => {
    stopLocalHealthWrites();
    const { container } = guest(<SyncControl backend="local" hasData />, provider);
    expect(container.textContent).toContain('Your record is safe in your');
    expect(container.textContent).not.toContain('kept in this browser');
  });
});
