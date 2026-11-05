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
import { ROADMAP_FILE_NAME, StorageError } from '@roadmap/health-core';

vi.mock('./google-config', () => ({ googleDriveConfig: () => ({}) }));
vi.mock('../src/lib/server-api', () => ({ trackProductEvent: vi.fn() }));
vi.mock('./reminders', () => ({ remindersSupported: () => false }));
vi.mock('./reminders-control', () => ({ RemindersControl: () => null }));

import { SyncControl } from './sync-control';
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
    render(<SyncControl backend="local" hasData />);
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
  });

  it('the message goes once a later save lands', async () => {
    const storage = fullStorage();
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    store.addMeasurement('weight', 78, '2026-01-10T00:00:00.000Z');
    await store.flush();
    storage.limit = storage.used;
    store.addMeasurement('weight', 93, '2026-02-10T00:00:00.000Z');
    await expect(store.flush()).rejects.toThrow();
    render(<SyncControl backend="local" hasData />);
    expect(alertText()).toContain(FULL_LINE);

    storage.limit = Number.POSITIVE_INFINITY; // the person freed some space
    await act(async () => { await store.flush(); });
    expect(JSON.parse(storage.getItem(BODY)!).measurements.map((m: { value: number }) => m.value)).toContain(93);
    expect(alertText()).toBeNull();
  });

  it('shows on a guest with no plan yet too', async () => {
    const storage = fullStorage();
    const store = await RoadmapStore.create(new LocalStorageAdapter());
    storage.limit = storage.used;
    store.addMeasurement('weight', 93, '2026-02-10T00:00:00.000Z');
    await expect(store.flush()).rejects.toThrow();
    render(<SyncControl backend="local" hasData={false} />);
    expect(alertText()).toContain(FULL_LINE);
  });

  it('a refused revision whose record went back is a refusal; one whose record stayed is not', () => {
    const storage = fullStorage();
    const adapter = new LocalStorageAdapter();
    const v1 = adapter.writeSync(ROADMAP_FILE_NAME, { n: 1 }, null).version;
    render(<SyncControl backend="local" hasData />);

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
    render(<SyncControl backend="dropbox" hasData />);
    expect(alertText()).toBeNull();
  });
});
