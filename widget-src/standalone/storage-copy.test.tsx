// @vitest-environment jsdom
/**
 * US-09 AC5 — the plan-tab storage block and the picker it opens.
 *
 * The picker is the only place storage is chosen, so both surfaces are pinned
 * here: the button under the plan opens it, and the picker's own copy names the
 * record (not the plan) and is honest about the browser-only option.
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { PLAN_STORAGE_CTA, PLAN_STORAGE_NOTICE, StorageNoticeContext } from '../src/lib/storage-notice';

vi.mock('../src/storage', () => ({
  GoogleDriveAdapter: class {},
  GitHubAdapter: class {},
  WebDavAdapter: class {},
  isSyncPending: () => false,
  SYNC_PENDING_EVENT: 'hr:sync-pending',
}));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', () => ({
  BACKEND_KEY: 'health_roadmap_backend',
  // Real behaviour (connect.test.ts pins it); the rest of the module is stubbed.
  storageState: (backend: string, reconnect?: string) =>
    (reconnect ? 'reconnect' : backend === 'local' ? 'guest' : 'cloud'),
  PROVIDER_LABELS: { 'google-drive': 'Google Drive', dropbox: 'Dropbox' },
  liftLocalInto: vi.fn(),
  adapterFor: () => null,
  copyDownToDevice: vi.fn(),
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
