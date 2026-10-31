// @vitest-environment jsdom
/**
 * US-09 AC30: the top bar's storage button, where "Supercharge this tool" sat.
 * Its label comes from the real storage state, and every state opens the one
 * picker with `current={reconnect ?? backend}` (AC13).
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, fireEvent, cleanup, act } from '@testing-library/react';

const sync = vi.hoisted(() => ({ pending: false }));
vi.mock('../src/storage', () => ({
  GoogleDriveAdapter: class {},
  GitHubAdapter: class {},
  WebDavAdapter: class {},
  isSyncPending: () => sync.pending,
  SYNC_PENDING_EVENT: 'hr:sync-pending',
}));
vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
vi.mock('./connect', () => ({
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

import { StorageBar, SyncControl } from './sync-control';
import { PICKER_GUEST_LEAD } from './backend-picker';
import type { Backend } from './connect';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
afterEach(() => { cleanup(); sync.pending = false; });

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
const dialog = () => document.querySelector('dialog.hr-modal') as HTMLDialogElement | null;
/** The picker row whose name starts with this provider. */
const option = (name: string) => [...dialog()!.querySelectorAll('.hr-opt')]
  .find((o) => o.querySelector('.hr-opt-name')?.textContent?.startsWith(name))!;

describe('US-09 AC30 — the label says the real storage state', () => {
  it('a guest sees Sign in', () => {
    mount('local');
    expect(bar().textContent).toBe('Sign in');
  });

  it.each([['dropbox', 'Dropbox'], ['google-drive', 'Google Drive'], ['github', 'GitHub']] as const)(
    'connected to %s, it names the provider', (backend, label) => {
      mount(backend);
      expect(bar().textContent).toBe(label);
    },
  );

  it('connected with changes still waiting, it says Saving… and goes back once they land', () => {
    sync.pending = true;
    mount('dropbox');
    expect(bar().textContent).toBe('Saving…');
    sync.pending = false;
    act(() => { window.dispatchEvent(new Event('hr:sync-pending')); });
    expect(bar().textContent).toBe('Dropbox');
  });

  it.each([
    ['dropbox', 'Reconnect Dropbox'],
    ['google-drive', 'Sign in to Google again'],
    ['github', 'Retry'],
    ['self-host', 'Retry'],
  ] as const)('a %s record that could not be read asks to reconnect: %s', (provider, label) => {
    mount('local', provider);
    expect(bar().textContent).toBe(label);
    expect(bar().textContent).not.toBe('Sign in'); // never the guest pitch for a placed record
  });
});

describe('US-09 AC30 — every state opens the one picker, current={reconnect ?? backend}', () => {
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

  it('connected, the picker marks that provider connected and drops the guest line', () => {
    mount('google-drive');
    fireEvent.click(bar());
    expect(option('Google Drive').textContent).toContain('✓ Connected');
    expect(dialog()!.textContent).not.toContain(PICKER_GUEST_LEAD);
  });

  it('AC13: a reconnect session runs on the browser, yet the picker treats the unread provider as current', () => {
    mount('local', 'dropbox');
    fireEvent.click(bar());
    expect(option('Dropbox').textContent).toContain('✓ Connected');
    expect(option('This browser only').textContent).not.toContain('✓');
    expect(dialog()!.textContent).not.toContain(PICKER_GUEST_LEAD);
  });
});
