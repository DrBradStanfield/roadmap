// @vitest-environment jsdom
/**
 * US-09 AC60: two web sync lines (words Brad 2026-11-26).
 * - A cloud page logged off in another tab keeps saving to its cloud while its sign-in holds (AC2i). Once a
 *   save fails, it says so (lead C32), beside the storage bar and atop the tabs on a phone.
 * - The picker, from a cloud, says the old cloud keeps its copy, in the iPhone's words (lead A12).
 * The health-write state is real; the save status is a stand-in for the store's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import type { SaveStatus } from '@roadmap/health-core/save-state';

vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));
const save = vi.hoisted(() => ({ status: 'saved' as SaveStatus }));
vi.mock('../src/lib/roadmap-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/lib/roadmap-data')>()),
  currentSaveStatus: () => save.status,
  currentRetryDue: () => false,
}));

const CLOUD_STOPPED = 'This browser was logged off in another tab. Your latest changes show here but are not saved.';
const DEVICE_STOPPED = 'This page has stopped saving. Reload it to carry on.';

let storage: typeof import('../src/lib/storage');
let sync: typeof import('./sync-control');
let SAVE_STATUS_EVENT: string;

beforeEach(async () => {
  localStorage.clear();
  save.status = 'saved';
  vi.resetModules();
  storage = await import('../src/lib/storage');
  sync = await import('./sync-control');
  ({ SAVE_STATUS_EVENT } = await import('../src/storage'));
});
afterEach(() => {
  cleanup();
  localStorage.clear();
});

const alerts = () => [...document.querySelectorAll('[role="alert"]')].map((el) => el.textContent);
const saveEnds = (status: SaveStatus) => act(() => { save.status = status; window.dispatchEvent(new Event(SAVE_STATUS_EVENT)); });

describe('US-09 AC60: a cloud page logged off in another tab says so once a save fails', () => {
  it('saves still landing: nothing is said; a save that fails: the line, in the bar and atop the tabs; one that lands: gone', () => {
    storage.noteCloudPage('dropbox');
    render(<><sync.StorageBar backend="dropbox" /><sync.LocalSaveAlert backend="dropbox" /></>);
    act(() => storage.noteLogOffHeard());
    expect(alerts()).toEqual([]);
    saveEnds('not-saved');
    expect(alerts()).toEqual([CLOUD_STOPPED, CLOUD_STOPPED]); // in the bar and atop the tabs
    expect(document.body.textContent).not.toMatch(/Reload/);
    saveEnds('saved');
    expect(alerts()).toEqual([]);
  });

  it('control: a failed save with no log-off says nothing new', () => {
    storage.noteCloudPage('dropbox');
    render(<sync.LocalSaveAlert backend="dropbox" />);
    saveEnds('not-saved');
    expect(alerts()).toEqual([]);
  });

  it.each<[string, Parameters<typeof import('./sync-control').saveAlert>, string]>([
    ['a device page stopped', ['local', true, false, 'saved'], 'deviceStopped'],
    ['a device page refused for room', ['local', false, true, 'saved'], 'deviceRefused'],
    ['a device page, stopped and refused', ['local', true, true, 'saved'], 'deviceStopped'],
    ['a cloud page stopped, its save failed', ['google-drive', true, false, 'not-saved'], 'cloudStopped'],
    ['a cloud page stopped, its save failed with a device copy', ['github', true, false, 'not-saved-on-device'], 'cloudStopped'],
    ['a cloud page stopped, a save running', ['dropbox', true, false, 'saving'], 'none'],
    ['a cloud page stopped, its saves landing', ['dropbox', true, false, 'saved'], 'none'],
    ['a cloud page writing, its save failed', ['dropbox', false, false, 'not-saved'], 'none'],
  ])('US-09 AC60: %s', (_name, args, alert) => {
    expect(sync.saveAlert(...args)).toBe(alert);
  });

  it('a device page keeps its own line', () => {
    localStorage.setItem('health_roadmap_backend', 'dropbox');
    storage.noteDevicePage(); // a fallback page for Dropbox
    render(<sync.LocalSaveAlert backend="local" />);
    act(() => storage.noteLogOffHeard());
    expect(alerts()).toEqual([DEVICE_STOPPED]);
  });
});

describe('US-09 AC60: the picker says the old cloud keeps its copy', () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = vi.fn();
  });

  it.each([
    ['dropbox', 'Your record in Dropbox stays there as it is.'],
    ['google-drive', 'Your record in Google Drive stays there as it is.'],
    ['github', 'Your record in GitHub stays there as it is.'],
  ] as const)('from %s', async (current, line) => {
    const { BackendPickerModal } = await import('./backend-picker');
    render(<BackendPickerModal current={current} onClose={() => {}} />);
    expect([...document.querySelectorAll('dialog p')].map((p) => p.textContent)).toContain(line);
  });

  it('a guest has no old cloud, so nothing is said', async () => {
    const { BackendPickerModal } = await import('./backend-picker');
    render(<BackendPickerModal current="local" onClose={() => {}} />);
    expect(document.querySelector('dialog')?.textContent).not.toMatch(/stays there as it is/);
  });
});
