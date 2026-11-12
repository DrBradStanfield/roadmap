// @vitest-environment jsdom
/**
 * US-09 AC2i (lead C31): a page whose device writes have stopped after a
 * log-off on another page says so. Before, it showed nothing: typed values
 * stayed on screen as if saved, and a page that opened after a log-off showed
 * an empty record that saved nothing. A cloud page that stops loses only its
 * device mirror and keeps saving to its cloud while its sign-in still holds, so
 * it says nothing (what it shows once the sign-in ends: lead C32). A page whose
 * own log-off has begun reloads at once, so it says nothing either.
 *
 * The health-write state lives for the module's life, so every test imports a
 * fresh lib/storage and sync-control.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';

vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));

const STOPPED = 'This page has stopped saving. Reload it to carry on.';
const LOG_OFF_ID_KEY = 'health_roadmap_log_off_id';

type Storage = typeof import('../src/lib/storage');
type Sync = typeof import('./sync-control');
let storage: Storage;
let sync: Sync;

beforeEach(async () => {
  localStorage.clear();
  vi.resetModules();
  storage = await import('../src/lib/storage');
  sync = await import('./sync-control');
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const notice = () => [...document.querySelectorAll('[role="alert"]')].find((el) => el.textContent === STOPPED) ?? null;

describe('US-09 AC2i: a page whose device writes stopped says it has stopped saving', () => {
  it('a device page that hears another tab\'s log-off: a fallback page shows the notice in the bar and atop the tabs', () => {
    localStorage.setItem('health_roadmap_backend', 'dropbox');
    storage.noteDevicePage(); // a fallback page for Dropbox
    render(<><sync.StorageBar backend="local" reconnect="dropbox" /><sync.LocalSaveAlert backend="local" /></>);
    expect(notice()).toBeNull();
    act(() => storage.noteLogOffHeard());
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(2);
    // Styled as the bar's other errors (standalone.css .hr-sync-error).
    expect(notice()?.classList.contains('hr-sync-error')).toBe(true);
  });

  it('a fallback page whose log-off id changes (a storage event, no signal) shows the notice', () => {
    localStorage.setItem('health_roadmap_backend', 'google-drive');
    storage.noteDevicePage();
    render(<sync.LocalSaveAlert backend="local" />);
    expect(notice()).toBeNull();
    act(() => {
      localStorage.setItem(LOG_OFF_ID_KEY, 'id-after');
      window.dispatchEvent(new StorageEvent('storage', { key: LOG_OFF_ID_KEY }));
    });
    expect(notice()).not.toBeNull();
  });

  it('a page that opened stopped (a log-off heard while it loaded) shows the notice from its first frame', () => {
    storage.noteLogOffHeard();
    storage.noteDevicePage();
    render(<sync.StorageBar backend="local" />);
    expect(notice()).not.toBeNull();
  });

  it('a page that opened on the device after the log-off id changed shows the notice', () => {
    localStorage.setItem('health_roadmap_backend', 'dropbox');
    localStorage.setItem(LOG_OFF_ID_KEY, 'id-after'); // changed after this page loaded
    storage.noteDevicePage();
    render(<sync.LocalSaveAlert backend="local" />);
    expect(notice()).not.toBeNull();
  });

  it('a page that starts its own log-off shows no notice: it reloads at once, so nothing flashes or is announced', async () => {
    const { stopRoadmapLocalWrites } = await import('../src/storage/local-storage-adapter');
    localStorage.setItem('health_roadmap_backend', 'dropbox');
    storage.noteDevicePage(); // a fallback page for Dropbox
    render(<><sync.StorageBar backend="local" reconnect="dropbox" /><sync.LocalSaveAlert backend="local" /></>);
    act(() => stopRoadmapLocalWrites()); // the log-off's first, synchronous step
    expect(storage.healthWritesAllowed()).toBe(false);
    expect(notice()).toBeNull();
  });

  it('a guest page shows no notice, with no log-off or after one heard (its copy is its only store)', () => {
    storage.noteDevicePage();
    render(<><sync.StorageBar backend="local" /><sync.LocalSaveAlert backend="local" /></>);
    expect(notice()).toBeNull();
    act(() => storage.noteLogOffHeard());
    expect(notice()).toBeNull();
  });

  it('a cloud page whose device mirror stopped shows no notice: its saves reach its cloud while its sign-in still holds', () => {
    storage.noteCloudPage('dropbox');
    render(<><sync.StorageBar backend="dropbox" /><sync.LocalSaveAlert backend="dropbox" /></>);
    act(() => storage.noteLogOffHeard());
    expect(storage.healthWritesAllowed()).toBe(false);
    expect(notice()).toBeNull();
    expect(document.body.textContent).not.toContain('stopped saving');
  });
});
