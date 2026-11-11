// @vitest-environment jsdom
/**
 * US-01 AC5: a guest whose browser storage is full is told that a change was
 * not saved on this device. Before, the edit showed and the plan recalculated
 * while the save failed and only a console warning and an error report heard
 * of it; a reload brought the old value back.
 *
 * The storage below is a uniform byte budget, as in
 * local-storage-revision-quota.test.ts: every key costs the same, none is
 * singled out. No real browser quota is claimed. Synthetic values only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core/adapter';

vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));

import { StorageBar, SyncControl } from './sync-control';
import { RoadmapStore } from '../src/storage/roadmap-store';
import { LocalStorageAdapter } from '../src/storage/local-storage-adapter';

const BODY = 'health_roadmap_file_v2';
const REV = BODY + '_rev';
const FULL_LINE = 'Could not save on this device (local storage may be full).';

class ByteBudgetStorage implements Storage {
  private entries = new Map<string, string>();
  limit = Number.POSITIVE_INFINITY;
  /** Refuse a write regardless of room (a write from elsewhere took it). */
  refuse: (key: string, value: string) => boolean = () => false;
  get length() { return this.entries.size; }
  clear() { this.entries.clear(); }
  getItem(k: string) { return this.entries.get(String(k)) ?? null; }
  key(i: number) { return [...this.entries.keys()][i] ?? null; }
  removeItem(k: string) { this.entries.delete(String(k)); }
  get used() { return [...this.entries].reduce((n, [k, v]) => n + 2 * (k.length + v.length), 0); }
  setItem(k: string, v: string) {
    k = String(k); v = String(v);
    const old = this.entries.get(k);
    const after = this.used - (old === undefined ? 0 : 2 * (k.length + old.length)) + 2 * (k.length + v.length);
    if (after > this.limit || this.refuse(k, v)) throw new DOMException('Synthetic uniform byte budget exceeded', 'QuotaExceededError');
    this.entries.set(k, v);
  }
}

function fullStorage(): ByteBudgetStorage {
  const storage = new ByteBudgetStorage();
  vi.stubGlobal('localStorage', storage);
  return storage;
}

const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? null;
/** The top bar's storage button, where the alert sits: on a phone it is above
 *  every tab, so the guest sees it while editing (review of this fix, finding 1). */
const bar = (backend: 'local' | 'dropbox' = 'local') => render(<StorageBar backend={backend} />);

afterEach(() => {
  cleanup();
  // A save that lands clears the refusal, so the next test starts clean.
  vi.stubGlobal('localStorage', new ByteBudgetStorage());
  new LocalStorageAdapter().writeSync(ROADMAP_FILE_NAME, { reset: true }, null);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('US-01 AC5: a guest save refused by a full browser storage is said on screen', () => {
  it('says the change was not saved, keeps it on screen, and stores nothing', async () => {
    const storage = fullStorage();
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    expect(store.addMeasurement('weight', 78, '2026-01-10T00:00:00.000Z').status).toBe('inserted');
    await store.flush();
    bar();
    expect(alertText()).toBeNull();

    const before = storage.getItem(BODY);
    storage.limit = storage.used; // full: nothing more fits
    expect(store.addMeasurement('weight', 93, '2026-02-10T00:00:00.000Z').status).toBe('inserted');
    await act(async () => { await expect(store.flush()).rejects.toThrow(); });

    expect(storage.getItem(BODY)).toBe(before);
    // The working copy keeps the change, as a refused cloud save does (US-09 AC4).
    expect(store.loadAllHistory().map((m) => m.value)).toContain(93);
    expect(alertText()).toContain(FULL_LINE);
    expect(alertText()).toContain('not saved');
    // Styled as the bar's other errors: red, on its own line (standalone.css .hr-sync-error).
    expect(document.querySelector('[role="alert"]')?.classList.contains('hr-sync-error')).toBe(true);
  });

  it('the message goes once a later save lands', async () => {
    const storage = fullStorage();
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('weight', 78, '2026-01-10T00:00:00.000Z');
    await store.flush();
    storage.limit = storage.used;
    store.addMeasurement('weight', 93, '2026-02-10T00:00:00.000Z');
    await expect(store.flush()).rejects.toThrow();
    bar();
    expect(alertText()).toContain(FULL_LINE);

    storage.limit = Number.POSITIVE_INFINITY; // the person freed some space
    await act(async () => { await store.flush(); });
    expect(JSON.parse(storage.getItem(BODY)!).measurements.map((m: { value: number }) => m.value)).toContain(93);
    expect(alertText()).toBeNull();
  });

  it('shows before the guest has any data saved too', async () => {
    const storage = fullStorage();
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    storage.limit = storage.used;
    store.addMeasurement('weight', 93, '2026-02-10T00:00:00.000Z');
    await expect(store.flush()).rejects.toThrow();
    bar();
    expect(alertText()).toContain(FULL_LINE);
  });

  it('a refused revision whose record went back is a refusal; one whose record stayed is not', () => {
    const storage = fullStorage();
    const adapter = new LocalStorageAdapter();
    const v1 = adapter.writeSync(ROADMAP_FILE_NAME, { n: 1 }, null).version;
    bar();

    // The revision is refused and the old record goes back: nothing stored.
    storage.refuse = (key) => key === REV;
    act(() => { expect(() => adapter.writeSync(ROADMAP_FILE_NAME, { n: 2 }, v1)).toThrow(StorageError); });
    expect(JSON.parse(storage.getItem(BODY)!)).toEqual({ n: 1 });
    expect(alertText()).toContain(FULL_LINE);

    // The revision is refused and the old record cannot go back: the change
    // is the stored record (US-34 AC6a), so this device holds it.
    const old = storage.getItem(BODY);
    storage.refuse = (key, value) => key === REV || (key === BODY && value === old);
    act(() => { expect(() => adapter.writeSync(ROADMAP_FILE_NAME, { n: 3 }, v1)).toThrow(StorageError); });
    expect(JSON.parse(storage.getItem(BODY)!)).toEqual({ n: 3 });
    expect(alertText()).toBeNull();
  });

  it('a cloud page does not show it: its status line speaks for the cloud save', async () => {
    const storage = fullStorage();
    const adapter = new LocalStorageAdapter();
    storage.limit = 0;
    expect(() => adapter.writeSync(ROADMAP_FILE_NAME, { n: 1 }, null)).toThrow(StorageError);
    bar('dropbox');
    expect(alertText()).toBeNull();
  });

  it('shows once, in the top bar, not in the plan panel as well', () => {
    const storage = fullStorage();
    const adapter = new LocalStorageAdapter();
    storage.limit = 0;
    render(
      <>
        <div data-testid="bar"><StorageBar backend="local" /></div>
        <div data-testid="plan"><SyncControl backend="local" hasData /></div>
      </>,
    );
    act(() => { expect(() => adapter.writeSync(ROADMAP_FILE_NAME, { n: 1 }, null)).toThrow(StorageError); });
    const alerts = [...document.querySelectorAll('[role="alert"]')];
    expect(alerts).toHaveLength(1);
    expect(alerts[0].closest('[data-testid="bar"]')).not.toBeNull();
    expect(alerts[0].textContent).toContain(FULL_LINE);
  });

  it('only the record counts: a refused chat history write does not show it', () => {
    const storage = fullStorage();
    const adapter = new LocalStorageAdapter();
    adapter.writeSync(ROADMAP_FILE_NAME, { n: 1 }, null);
    bar();
    storage.refuse = (key) => key !== BODY && key !== REV;
    act(() => { expect(() => adapter.writeSync('chat-history.json', { m: 1 }, null)).toThrow(StorageError); });
    expect(alertText()).toBeNull();
  });

  it('only the record counts: a chat history write that lands does not hide a refused record save', () => {
    const storage = fullStorage();
    const adapter = new LocalStorageAdapter();
    const v1 = adapter.writeSync(ROADMAP_FILE_NAME, { n: 1 }, null).version;
    bar();
    storage.refuse = (key) => key === BODY;
    act(() => { expect(() => adapter.writeSync(ROADMAP_FILE_NAME, { n: 2 }, v1)).toThrow(StorageError); });
    expect(alertText()).toContain(FULL_LINE);
    storage.refuse = () => false;
    act(() => { adapter.writeSync('chat-history.json', { m: 1 }, null); });
    expect(JSON.parse(storage.getItem(BODY)!)).toEqual({ n: 1 });
    expect(alertText()).toContain(FULL_LINE);
  });
});
